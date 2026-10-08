import test from 'node:test'
import assert from 'node:assert/strict'
import { hostChapterGenerator, modelForSession } from '../lib/host/chapter-generator.js'
import { generationPrompt } from '../lib/domain/proposals.js'
import { hash } from '../lib/domain/books.js'

function fixture(chunks, header = undefined, pending = null) {
  const requests = []
  const ctx = {
    get(name) { return this[name] },
    sessionProjections: { stateOf: () => ({ pending, lastUsed: null }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'deepseek-v4.1-flash' }) },
    llm: { async prepareCall(config, signal) {
      requests.push({ config, signal })
      return { config, stream(options) { requests.push(options); return chunks(options) } }
    } },
  }
  const session = { id: 'author-session', requestHeader: () => header }
  const proposal = { request: { mode: 'rewrite', instruction: '保留伤势。', materials: '左腕受伤', start: 3, end: 6 }, baseline: '前文。选区。后文。' }
  return { ctx, session, proposal, requests }
}

test('effective route prefers pending selection, then last request without adapter defaults, then host default', () => {
  const f = fixture(async function* () {})
  assert.deepEqual(modelForSession(f.ctx, f.session), { provider: 'fixture', model: 'deepseek-v4.1-flash' })
  f.session.requestHeader = () => ({ config: { provider: 'author', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' }, adapterDefaults: { reasoningEffort: true } })
  assert.deepEqual(modelForSession(f.ctx, f.session), { provider: 'author', model: 'deepseek-v4.1-flash' })
  f.ctx.sessionProjections.stateOf = () => ({ pending: { provider: 'selected', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' } })
  assert.deepEqual(modelForSession(f.ctx, f.session), { provider: 'selected', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' })
})

test('host one-shot receives only target snapshot and explicit materials, no tools or parent history; usage stays unknown', async () => {
  const f = fixture(async function* () {
    yield { type: 'text-delta', index: 0, text: '改写结果。' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const progress = []
  const generate = hostChapterGenerator(f.ctx, f.session)
  f.ctx.agentDefaultModel.currentSelection = () => ({ provider: 'later', model: 'deepseek-v4.1-flash' })
  const result = await generate(f.proposal, new AbortController().signal, async text => { progress.push(text) })
  assert.equal(result.complete, true)
  assert.equal(result.replacement, '改写结果。')
  assert.deepEqual(result.usage, { state: 'unknown' })
  const options = f.requests[1]
  assert.equal(options.provider, 'fixture')
  assert.deepEqual(options.tools, [])
  assert.equal(options.messages.length, 1)
  assert.equal(options.messages[0].content[0].text, generationPrompt(f.proposal))
  assert.equal(options.sessionId, f.session.id)
  assert.equal(progress.at(-1), result.replacement)
  assert.equal(hash(options.messages[0].content[0].text), hash(generationPrompt(f.proposal)))
})

for (const reason of ['max-tokens', 'error', 'aborted']) {
  test(`terminal ${reason} is incomplete while retaining prose`, async () => {
    const f = fixture(async function* () {
      yield { type: 'text-delta', index: 0, text: '部分文本' }
      yield { type: 'finish', reason: { kind: reason, failure: { code: 'fixture' } } }
    })
    const result = await hostChapterGenerator(f.ctx, f.session)(f.proposal, new AbortController().signal, async () => {})
    assert.equal(result.complete, false)
    assert.equal(result.replacement, '部分文本')
  })
}

test('empty and missing finish are incomplete; reported usage is preserved and cancellation settles a stuck iterator', async () => {
  const empty = fixture(async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })
  assert.equal((await hostChapterGenerator(empty.ctx, empty.session)(empty.proposal, new AbortController().signal, async () => {})).reason, 'empty-output')
  const missing = fixture(async function* () {
    yield { type: 'text-delta', index: 0, text: '前缀' }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
  })
  const result = await hostChapterGenerator(missing.ctx, missing.session)(missing.proposal, new AbortController().signal, async () => {})
  assert.equal(result.reason, 'missing-finish')
  assert.deepEqual(result.usage, { state: 'reported', inputTokens: 10, outputTokens: 2, totalTokens: 12 })
  const stuck = fixture(() => ({ [Symbol.asyncIterator]() { return this }, next: () => new Promise(() => {}), return: async () => ({ done: true }) }))
  const controller = new AbortController()
  const pending = hostChapterGenerator(stuck.ctx, stuck.session)(stuck.proposal, controller.signal, async () => {})
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(pending, error => error.name === 'AbortError')
})
