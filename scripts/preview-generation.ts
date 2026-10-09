/** Fixed-response Host adapter for isolated preview profiles; never contacts a provider. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
export const inject = ['llm', 'sessionController', 'sessions']
export async function apply(ctx) {
  const output = resolve(process.env.DSH_HOME, '..')
  await mkdir(output, { recursive: true })
  const callFile = resolve(output, 'generation-calls.json')
  const calls = await readFile(callFile, 'utf8').then(text => JSON.parse(text), error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  assert(Array.isArray(calls))
  class FixedAdapter extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'deepseek-v4.1-flash', name: 'Fixed-response fixture' }] }
    async *stream(options) {
      assert.equal(options.provider, 'novel-fixture')
      assert.equal(options.tools.length, 0)
      assert.equal(options.messages.length, 1)
      const input = JSON.parse(options.messages[0].content[0].text)
      calls.push({ sessionId: options.sessionId, task: input.task, instruction: input.instruction, chapter: input.chapter, selection: input.selection,
        ...(input.documentKind ? { documentKind: input.documentKind } : {}), ...(input.selectedMaterials ? { selectedMaterials: input.selectedMaterials } : {}) })
      await writeFile(callFile, JSON.stringify(calls))
      if (input.task === 'suggest-chapter-state') {
        const quote = input.chapter.slice(0, Math.min(40, input.chapter.length))
        const evidence = { start: 0, end: quote.length, quote }
        yield { type: 'text-delta', index: 0, text: JSON.stringify({
          events: quote ? [{ title: '本章已发生变化', evidence, changes: input.characters.length ? [{ characterId: input.characters[0].characterId, kind: 'injury', value: '左腕仍不能用力' }] : [] }] : [],
          foreshadows: quote ? [{ title: '船头白花线索', note: '确认它是否是伏笔，再保存。', evidence }] : [],
        }) }
        yield { type: 'finish', reason: { kind: 'stop' } }; return
      }
      if (input.task === 'suggest-scene-intent') {
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ directions: [{ ...input.currentIntent, goal: '在天亮前把信交给船夫。', choice: '用右手递信，左腕仍藏在袖中。' }, { ...input.currentIntent, goal: '等船靠岸后再交信。', choice: '先问清渡口是否有人守着。' }] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }; return
      }
      if (input.task === 'extract-facts') {
        const quote = input.chapter.slice(0, Math.min(40, input.chapter.length))
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ summary: { text: quote, quote, start: 0, end: quote.length }, facts: [{ subject: '主角', predicate: '当前状态', value: quote, scope: { kind: 'reader' }, sourceChapterId: input.chapterId, quote, start: 0, end: quote.length }] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (input.task === 'review-fiction') {
        const at = input.text.indexOf('[TODO]')
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ dimensions: ['continuity', 'character', 'causality', 'language'].map(dimension => ({ dimension, state: 'checked' })), issues: at < 0 ? [] : [{ dimension: 'language', severity: 'error', message: '移除占位内容。', suggestion: '将占位内容写成完整动作。', quote: '[TODO]', start: at, end: at + 6, references: [] }] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (input.instruction.includes('[empty]')) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
      if (input.instruction.includes('[review-problem]')) {
        yield { type: 'text-delta', index: 0, text: '前文保持。\n\n[TODO]\n\n后文保持。' }
        yield { type: 'finish', reason: { kind: 'stop' } }; return
      }
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
  const { modelForSession } = await import(new URL('./host/chapter-generator.js', import.meta.resolve('dsh-super-novel')).href)
  for (const sessionId of ['super-novel-preview-a', 'super-novel-preview-b']) {
    assert.equal(modelForSession(ctx, ctx.sessions.get(sessionId)).provider, 'novel-fixture')
  }
}
