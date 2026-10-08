import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projection from '@deepseek-ai/dsh-session-projection'
import Policy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import Llm, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import SuperNovel from '../lib/index.js'

test('hot unload settles review and extraction, releases locks and reinstall reads unchanged author data', async t => {
  await mkdir('.test-output', { recursive: true })
  const root = await mkdtemp(resolve('.test-output/lifecycle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  ctx.provide('sessionPersistence', { stat: async () => undefined }); ctx.provide('agentPresets', { roots: [], list: async () => [] })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'lifecycle-fixture', model: 'deepseek-v4.1-flash' }) })
  ctx.plugin(Sessions); ctx.plugin(Projection); ctx.plugin(Policy); ctx.plugin(LocalFs); ctx.plugin(Llm)
  const plugin = ctx.plugin(SuperNovel)
  t.after(() => ctx.fiber.dispose())
  await new Promise(resolve => ctx.inject(['sessions', 'sessionProjections', 'sandboxPolicy', 'fs', 'llm', 'superNovel'], () => resolve(true)))
  ctx.sessionProjections.register({ key: 'modelSelection', stateSchema: z.any(), init: () => ({ pending: null, lastUsed: null }), apply: state => state, stateVersion: 2 })
  let starts = 0, aborted = 0, started
  const ready = new Promise(resolve => { started = resolve })
  class Fixed extends LlmAdapter {
    async *stream(options) {
      if (++starts === 2) started(true)
      await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { aborted++; reject(options.signal.reason) }, { once: true }))
      throw new Error('unexpected completion')
    }
  }
  ctx.llm.registerAdapter(['lifecycle-fixture'], new Fixed())
  const sessionId = SessionId('lifecycle'), session = ctx.sessions.create(sessionId, { meta: { cwd: root } })
  setSandboxMode(session, 'workspace-write')
  const signal = new AbortController().signal, api = ctx.superNovel
  let book = await api.createBook(sessionId, { operationId: randomUUID(), title: '卸载保留' }, signal)
  const chapterId = randomUUID()
  book = await api.changeChapter(sessionId, { operationId: randomUUID(), bookId: book.bookId, chapterId, expectedRevision: book.revision, expectedHash: '', action: 'create', title: '首章', content: '作者原稿。', beforeChapterId: '' }, signal)
  const before = await api.chapter(sessionId, book.bookId, chapterId, signal)
  const outcomes = Promise.allSettled([
    api.generateFacts(sessionId, { proposalId: randomUUID(), bookId: book.bookId, sourceChapterId: chapterId, expectedRevision: book.revision, expectedHash: before.hash }, signal),
    api.reviewChapter(sessionId, { reviewId: randomUUID(), bookId: book.bookId, chapterId, proposalId: '', expectedRevision: book.revision, expectedHash: before.hash, minCharacters: 0, maxCharacters: 0, minParagraphs: 0, maxParagraphs: 0 }, signal),
  ])
  await ready
  await plugin.dispose()
  assert.equal(aborted, 2)
  assert((await outcomes).every(result => result.status === 'rejected' && result.reason.name === 'AbortError'))
  const locks = await readdir(join(root, 'novels', book.bookId))
  assert(!locks.some(name => name.endsWith('.lock')))
  ctx.plugin(SuperNovel)
  await new Promise(resolve => ctx.inject(['superNovel'], () => resolve(true)))
  assert.notEqual(ctx.superNovel, api)
  assert.deepEqual(await ctx.superNovel.chapter(sessionId, book.bookId, chapterId, signal), before)
  assert.deepEqual(await ctx.superNovel.chapterReviews(sessionId, book.bookId, chapterId, signal), [])
  assert.deepEqual(await ctx.superNovel.factProposals(sessionId, book.bookId, chapterId, signal), [])
})
