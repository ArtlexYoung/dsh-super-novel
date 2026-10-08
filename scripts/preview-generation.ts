/** Fixed-response Host adapter for isolated preview profiles; never contacts a provider. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
export const inject = ['llm', 'sessionController', 'sessions']
export async function apply(ctx) {
  const output = resolve(process.env.DSH_HOME, '..')
  await mkdir(output, { recursive: true })
  const calls = []
  class FixedAdapter extends LlmAdapter {
    async *stream(options) {
      assert.equal(options.provider, 'novel-fixture')
      assert.equal(options.tools.length, 0)
      assert.equal(options.messages.length, 1)
      const input = JSON.parse(options.messages[0].content[0].text)
      calls.push({ sessionId: options.sessionId, instruction: input.instruction, chapter: input.chapter, selection: input.selection })
      await writeFile(resolve(output, 'generation-calls.json'), JSON.stringify(calls))
      if (input.task === 'extract-facts') {
        const quote = input.chapter.slice(0, Math.min(40, input.chapter.length))
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ summary: { text: quote, quote, start: 0, end: quote.length }, facts: [{ subject: '主角', predicate: '当前状态', value: quote, scope: { kind: 'reader' }, sourceChapterId: input.chapterId, quote, start: 0, end: quote.length }] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (input.instruction.includes('[empty]')) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
      yield { type: 'text-delta', index: 0, text: '候选前句。\n' }
      if (input.instruction.includes('[slow]')) {
        await new Promise((yes, no) => {
          if (options.signal.aborted) { no(options.signal.reason); return }
          const timer = setTimeout(yes, 30_000)
          options.signal.addEventListener('abort', () => { clearTimeout(timer); no(options.signal.reason) }, { once: true })
        })
      }
      yield { type: 'text-delta', index: 0, text: '他用右手扶住船沿，左腕仍藏在袖中。\n' }
      yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 } }
      yield { type: 'finish', reason: { kind: input.instruction.includes('[truncated]') ? 'max-tokens' : 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['novel-fixture'], new FixedAdapter()))
  for (const sessionId of ['super-novel-preview-a', 'super-novel-preview-b', 'super-novel-preview-readonly']) {
    await ctx.sessionController.selectModel({ sessionId, provider: 'novel-fixture', model: 'deepseek-v4.1-flash' })
  }
  const { modelForSession } = await import('../lib/host/chapter-generator.js')
  for (const sessionId of ['super-novel-preview-a', 'super-novel-preview-b']) {
    assert.equal(modelForSession(ctx, ctx.sessions.get(sessionId)).provider, 'novel-fixture')
  }
}
