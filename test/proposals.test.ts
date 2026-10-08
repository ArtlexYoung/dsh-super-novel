import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BookStore } from '../lib/host/book-store.js'
import { ProposalStore } from '../lib/host/proposal-store.js'
import { ProposalTasks } from '../lib/host/proposal-tasks.js'
import { hash, json } from '../lib/domain/books.js'
import type { GenerateChapterRequest } from '../src/types.js'

const signal = () => new AbortController().signal
const matches = code => error => error.code === code
async function fixture(t, text = '\uFEFF前文\r\n选中段。\r\n后文🙂') {
  await mkdir('.test-output', { recursive: true })
  const root = await mkdtemp(resolve('.test-output/proposals-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const books = await BookStore.at(root)
  let book = await books.createBook({ operationId: randomUUID(), title: '渡河' }, signal())
  const chapterId = randomUUID()
  book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId, expectedRevision: book.revision,
    action: 'create', title: '渡口', beforeChapterId: '', expectedHash: '', content: '' }, signal())
  book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId, expectedRevision: book.revision,
    action: 'save', title: '', beforeChapterId: '', expectedHash: hash(''), content: text }, signal())
  const store = await ProposalStore.at(root, hash(root), books)
  const request: GenerateChapterRequest = { proposalId: randomUUID(), bookId: book.bookId, chapterId,
    expectedRevision: book.revision, expectedHash: hash(text), mode: 'rewrite', start: 5, end: 9,
    instruction: '只改选区，保留事实。', materials: '左腕受伤。' }
  return { root, books, store, book, chapterId, text, request }
}
async function complete(store, request, replacement = '新的选区。') {
  await store.create('session-a', request, signal())
  await store.checkpoint(request.bookId, request.proposalId, replacement, 'review', '', { state: 'unknown' }, 10)
  return await store.view(request.bookId, request.proposalId, false)
}
const decision = view => ({ bookId: view.bookId, proposalId: view.proposalId, expectedCandidateHash: view.candidateHash })

for (const mode of ['draft', 'continue', 'rewrite', 'polish'] as const) {
  test(`${mode} retains separate candidate and preserves all text outside authorized range`, async t => {
    const { store, books, text, request } = await fixture(t)
    const range = mode === 'draft' ? { start: 0, end: text.length } : mode === 'continue' ? { start: text.length, end: text.length } : {}
    const view = await complete(store, { ...request, ...range, mode })
    assert.equal((await books.readChapter(request.bookId, request.chapterId)).content, text)
    assert.equal(view.candidate, text.slice(0, view.start) + view.replacement + text.slice(view.end))
    const accepted = await store.decide(decision(view), true, signal())
    assert.equal(accepted.state, 'accepted')
    assert.equal((await books.readChapter(request.bookId, request.chapterId)).content, view.candidate)
    assert.equal((await books.readBook(request.bookId)).revision, request.expectedRevision + 1)
    assert.deepEqual(await store.decide(decision(view), true, signal()), accepted)
    assert.equal((await books.readBook(request.bookId)).revision, request.expectedRevision + 1)
    await assert.rejects(store.decide(decision(view), false, signal()), matches('proposal-finalized'))
  })
}

test('reopening and listing are pure; creation IDs reject different requests and ranges split no Unicode code point', async t => {
  const { root, store, text, request } = await fixture(t)
  await store.create('session-a', request, signal())
  const reopened = await ProposalStore.at(root, hash(root))
  const file = join(root, 'novels', request.bookId, 'proposals', `${request.proposalId}.json`)
  const before = await readFile(file, 'utf8')
  assert.equal((await reopened.view(request.bookId, request.proposalId, false)).state, 'interrupted')
  assert.equal((await reopened.list(request.bookId, request.chapterId, () => false)).length, 1)
  assert.equal(await readFile(file, 'utf8'), before)
  assert.equal((await reopened.create('session-b', request, signal())).created, false)
  await assert.rejects(reopened.create('session-a', { ...request, instruction: 'different' }, signal()), matches('operation-conflict'))
  await assert.rejects(reopened.create('session-a', { ...request, proposalId: randomUUID(), start: text.length - 1, end: text.length }, signal()), matches('invalid-range'))
  await assert.rejects(reopened.create('session-a', { ...request, proposalId: randomUUID(), mode: 'continue' }, signal()), matches('invalid-range'))
  await assert.rejects(reopened.create('session-a', { ...request, proposalId: randomUUID(), mode: 'draft' }, signal()), matches('invalid-range'))
  const foreign = await ProposalStore.at(root, hash('another workspace'))
  await assert.rejects(foreign.view(request.bookId, request.proposalId, false), matches('invalid-format'))
  await assert.rejects(store.view(randomUUID(), request.proposalId, false), matches('proposal-not-found'))
})

test('external changes expire candidates; rejection changes no prose and candidate hashes are checked', async t => {
  const { root, store, books, request } = await fixture(t)
  const view = await complete(store, request)
  await assert.rejects(store.decide({ ...decision(view), expectedCandidateHash: hash('wrong') }, true, signal()), matches('operation-conflict'))
  await writeFile(join(root, 'novels', request.bookId, 'chapters', `${request.chapterId}.md`), '外部作者新稿。')
  assert.equal((await store.view(request.bookId, request.proposalId, false)).state, 'expired')
  await assert.rejects(store.decide(decision(view), true, signal()), matches('proposal-stale'))
  assert.equal((await store.decide(decision(view), false, signal())).state, 'rejected')
  assert.equal((await books.readChapter(request.bookId, request.chapterId)).content, '外部作者新稿。')
  await assert.rejects(store.decide(decision(view), true, signal()), matches('proposal-finalized'))
})

for (const stage of ['prepared', 'chapter', 'manifest', 'completed'] as const) {
  test(`adoption interruption at ${stage} replays one save and reconciles its durable receipt`, async t => {
    const { root, store, request } = await fixture(t)
    const view = await complete(store, request)
    const brokenBooks = await BookStore.at(root, { afterStage: async value => { if (value === stage) throw new Error('disk fault') } })
    const broken = await ProposalStore.at(root, hash(root), brokenBooks)
    await assert.rejects(broken.decide(decision(view), true, signal()), /disk fault/)
    const reopened = await ProposalStore.at(root, hash(root))
    if (stage !== 'completed') {
      await assert.rejects(reopened.decide(decision(view), true, signal()), matches('recovery-required'))
      await reopened.books.recover(request.bookId, signal())
    }
    assert.equal((await reopened.view(request.bookId, request.proposalId, false)).state, 'accepted')
    assert.equal((await reopened.decide(decision(view), true, signal())).state, 'accepted')
    assert.equal((await reopened.books.readBook(request.bookId)).revision, request.expectedRevision + 1)
    assert.equal((await reopened.books.readChapter(request.bookId, request.chapterId)).content, view.candidate)
  })
}

test('detached task keeps target identity, deduplicates calls, and cancel retains an incomplete prefix', async t => {
  const { store, books, request, text } = await fixture(t)
  const tasks = new ProposalTasks()
  t.after(() => tasks.dispose())
  let calls = 0
  const generate = async (proposal, abort, progress) => {
    calls++
    assert.equal(proposal.request.chapterId, request.chapterId)
    await progress('部分候选')
    await new Promise((resolve, reject) => { if (abort.aborted) reject(abort.reason); else abort.addEventListener('abort', () => reject(abort.reason), { once: true }) })
    throw new Error('unreachable')
  }
  await tasks.start(store, 'session-a', request, generate, signal())
  await tasks.start(store, 'session-b', request, generate, signal())
  await assert.rejects(tasks.start(store, 'session-b', { ...request, instruction: '不同请求' }, generate, signal()), matches('operation-conflict'))
  const stopped = await tasks.stop(store, request.bookId, request.proposalId)
  assert.equal(calls, 1)
  assert.equal(stopped.state, 'interrupted')
  assert.equal(stopped.reason, 'generation-cancelled')
  assert.equal(stopped.replacement, '部分候选')
  assert.equal((await books.readChapter(request.bookId, request.chapterId)).content, text)
  await assert.rejects(store.decide(decision(stopped), true, signal()), matches('proposal-incomplete'))
  assert.equal((await store.decide(decision(stopped), false, signal())).state, 'rejected')
})

test('timeout, empty output and failed completion never become reviewable; no restart resubmits a model call', async t => {
  const { store, request } = await fixture(t)
  const tasks = new ProposalTasks(20)
  t.after(() => tasks.dispose())
  const done = new Promise(resolve => {
    tasks.start(store, 'session-a', request, async (_proposal, abort, progress) => {
      await progress('前缀')
      await new Promise((yes, no) => { if (abort.aborted) no(abort.reason); else abort.addEventListener('abort', () => no(abort.reason), { once: true }) })
      return { replacement: '', complete: false, reason: '', usage: { state: 'unknown' } }
    }, signal()).then(resolve)
  })
  await done
  // Wait for the durable terminal checkpoint; disk latency can exceed the timeout itself.
  const deadline = Date.now() + 5000
  while (tasks.active(store, request.bookId, request.proposalId) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(tasks.active(store, request.bookId, request.proposalId), false)
  const view = await store.view(request.bookId, request.proposalId, false)
  assert.equal(view.reason, 'generation-timeout')
  assert.equal(view.state, 'interrupted')
  const empty = { ...request, proposalId: randomUUID() }
  await tasks.start(store, 'session-a', empty, async () => ({ replacement: '', complete: false, reason: 'empty-output', usage: { state: 'unknown' } }), signal())
  await tasks.dispose()
  assert.equal((await store.view(empty.bookId, empty.proposalId, false)).state, 'interrupted')
})

test('tampered candidate or newer proposal format is rejected', async t => {
  const { root, store, request } = await fixture(t)
  await complete(store, request)
  const path = join(root, 'novels', request.bookId, 'proposals', `${request.proposalId}.json`)
  const proposal = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, json({ ...proposal, replacement: '伪造内容' }))
  await assert.rejects(store.view(request.bookId, request.proposalId, false), matches('invalid-format'))
  await writeFile(path, json({ ...proposal, schemaVersion: 2 }))
  await assert.rejects(store.view(request.bookId, request.proposalId, false), matches('unsupported-format'))
})
