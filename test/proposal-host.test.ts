import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projection from '@deepseek-ai/dsh-session-projection'
import Policy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import Llm, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import SuperNovel from '../lib/index.js'
import { BackupStore } from '../lib/host/backup-store.js'

test('real Cordis service dispatches candidate remotes with optional model services and preserves readonly policy', async t => {
  await mkdir('.test-output', { recursive: true })
  const root = await mkdtemp(resolve('.test-output/proposal-host-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const ctx = new Context()
  ctx.provide('sessionPersistence', { stat: async () => undefined })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixed', model: 'deepseek-v4.1-flash' }) })
  ctx.provide('agentPresets', { roots: [], list: async () => [] })
  ctx.plugin(Sessions); ctx.plugin(Projection); ctx.plugin(Policy, { mode: 'read-only' }); ctx.plugin(LocalFs); ctx.plugin(Llm)
  ctx.plugin(SuperNovel)
  t.after(() => ctx.fiber.dispose())
  await new Promise(resolve => ctx.inject(['sessions', 'sessionProjections', 'sandboxPolicy', 'fs', 'llm', 'superNovel'], () => resolve(true)))
  ctx.sessionProjections.register({ key: 'modelSelection', stateSchema: z.any(), init: () => ({ pending: null, lastUsed: null }), apply: state => state, stateVersion: 2 })
  let calls = 0
  class Fixed extends LlmAdapter {
    async *stream(options) {
      calls++
      assert.deepEqual(options.tools, [])
      assert.equal(options.messages.length, 1)
      yield { type: 'text-delta', index: 0, text: '正式采纳前的候选。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['fixed'], new Fixed())
  const sessionId = SessionId('host-proposal')
  const session = ctx.sessions.create(sessionId, { meta: { cwd: root } })
  setSandboxMode(session, 'workspace-write')
  const signal = new AbortController().signal
  let book = await ctx.superNovel.createBook(sessionId, { operationId: randomUUID(), title: '真实入口' }, signal)
  const chapterId = randomUUID()
  book = await ctx.superNovel.changeChapter(sessionId, { operationId: randomUUID(), bookId: book.bookId, chapterId,
    expectedRevision: book.revision, action: 'create', title: '首章', beforeChapterId: '', content: '', expectedHash: '' }, signal)
  const chapter = await ctx.superNovel.chapter(sessionId, book.bookId, chapterId, signal)
  const request = { proposalId: randomUUID(), bookId: book.bookId, chapterId, expectedRevision: book.revision,
    expectedHash: chapter.hash, mode: 'draft', instruction: '起草', materials: '', start: 0, end: 0 }
  await ctx.superNovel.generateChapter(sessionId, request, signal)
  let view
  for (let i = 0; i < 100; i++) {
    view = await ctx.superNovel.proposal(sessionId, book.bookId, request.proposalId, signal)
    if (view.state === 'review') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(view.state, 'review')
  assert.equal((await ctx.superNovel.chapter(sessionId, book.bookId, chapterId, signal)).content, '')
  await ctx.superNovel.generateChapter(sessionId, request, signal)
  assert.equal(calls, 1)
  const decision = { bookId: book.bookId, proposalId: view.proposalId, expectedCandidateHash: view.candidateHash }
  // Exercise the real backup job immediately, without waiting fifteen minutes.
  for (const timer of ctx.superNovel.backupTimers.values()) clearTimeout(timer)
  ctx.superNovel.backupTimers.clear()
  const nativeTimeout = globalThis.setTimeout, scheduled = []
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => {
    if (delay !== 15 * 60 * 1000) return nativeTimeout(fn, delay, ...args)
    scheduled.push(fn)
    return { unref() {} }
  })
  setSandboxMode(session, 'read-only')
  await assert.rejects(ctx.superNovel.acceptProposal(sessionId, decision, signal), error => error.details.reason === 'read-only')
  assert.equal(scheduled.length, 0)
  setSandboxMode(session, 'workspace-write')
  assert.equal((await ctx.superNovel.acceptProposal(sessionId, decision, signal)).state, 'accepted')
  assert.equal((await ctx.superNovel.chapter(sessionId, book.bookId, chapterId, signal)).content, '正式采纳前的候选。')
  assert.equal(scheduled.length, 1)
  scheduled.shift()(); await Promise.all([...ctx.superNovel.backupJobs])
  const backups = await BackupStore.at(root), list = await backups.list(book.bookId)
  assert.equal(list.length, 1)
  const preview = await backups.inspect(book.bookId, list[0].backupId, signal)
  assert(preview.files.some(name => name.endsWith(`/proposals/${view.proposalId}.json`)))
  const current = await ctx.superNovel.chapter(sessionId, book.bookId, chapterId, signal), quote = current.content
  const facts = await ctx.superNovel.proposeFacts(sessionId, {proposalId:randomUUID(),bookId:book.bookId,sourceChapterId:chapterId,expectedRevision:current.book.revision,expectedHash:current.hash,coverage:'chapter',
    facts:[{subject:'正文',predicate:'文字',value:quote,scope:{kind:'reader'},sourceChapterId:chapterId,start:0,end:quote.length,quote}]},signal)
  await ctx.superNovel.acceptFacts(sessionId, book.bookId, facts.proposalId, facts.factsHash, signal)
  assert.equal(scheduled.length, 1, 'fact proposal and adoption coalesce into one backup')
  scheduled.shift()(); await Promise.all([...ctx.superNovel.backupJobs])
  assert.equal((await backups.list(book.bookId)).length, 2)
  assert.equal(scheduled.length, 0, 'queries do not schedule backups')
})
