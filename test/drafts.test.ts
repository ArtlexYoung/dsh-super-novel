import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BookStore } from '../lib/host/book-store.js'
import { DraftStore } from '../lib/host/draft-store.js'
import { hash } from '../lib/domain/books.js'
import { DraftWriter } from '../src/client/draft-writer.ts'

const signal = () => new AbortController().signal
const code = expected => error => error.code === expected
const version = draft => ({ workspaceId: draft.workspaceId, bookId: draft.bookId, chapterId: draft.chapterId, branchId: draft.branchId, sequence: draft.sequence })

async function fixture(t) {
  await mkdir('.test-output', { recursive: true })
  const root = await mkdtemp(resolve('.test-output/drafts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const books = await BookStore.at(root), workspaceId = hash(root), chapterId = randomUUID()
  let book = await books.createBook({ operationId: randomUUID(), title: '草稿' }, signal())
  book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, expectedRevision: book.revision, action: 'create', chapterId, title: '首章', beforeChapterId: '', content: '正式正文。', expectedHash: '' }, signal())
  const drafts = await DraftStore.at(root, workspaceId, books)
  const request = { workspaceId, bookId: book.bookId, chapterId, branchId: randomUUID(), sequence: 1, baseHash: hash('正式正文。'), bookRevision: book.revision, content: '未保存输入。', operationId: randomUUID() }
  return { root, books, book, drafts, request }
}

test('reading drafts is side-effect free; checkpoints retain independent window branches without changing the formal chapter', async t => {
  const { root, books, book, drafts, request } = await fixture(t)
  const folder = join(root, 'novels', book.bookId)
  const before = await readdir(folder)
  const query = { workspaceId: request.workspaceId, bookId: request.bookId, chapterId: request.chapterId }
  assert.deepEqual(await drafts.list(query), { drafts: [], unreadable: 0 })
  assert.deepEqual(await readdir(folder), before)
  const receipt = await drafts.put(request, signal())
  assert.equal(receipt.contentHash, hash(request.content))
  assert.deepEqual(await drafts.put(request, signal()), receipt)
  const second = { ...request, branchId: randomUUID(), content: '另一窗口的输入。', operationId: randomUUID() }
  await drafts.put(second, signal())
  assert.equal((await drafts.list(query)).drafts.length, 2)
  assert.equal((await drafts.read(version(request))).content, request.content)
  assert.equal((await drafts.read(version(second))).content, second.content)
  assert.deepEqual(await books.readBook(book.bookId), book)
  assert.equal((await books.readChapter(book.bookId, request.chapterId)).content, '正式正文。')
})

test('sequence and operation checks reject stale or conflicting writes, while a failed receipt can be retried after reopening', async t => {
  const { root, books, drafts, request } = await fixture(t)
  const interrupted = await DraftStore.at(root, request.workspaceId, books, { afterPublication: async () => { throw new Error('lost receipt') } })
  await assert.rejects(interrupted.put(request, signal()), /lost receipt/)
  const receipt = await drafts.put(request, signal())
  assert.equal(receipt.contentHash, hash(request.content))
  await assert.rejects(drafts.put({ ...request, content: 'different' }, signal()), code('operation-conflict'))
  const next = { ...request, sequence: 2, content: '第二检查点。', operationId: randomUUID() }
  await drafts.put(next, signal())
  await assert.rejects(drafts.put(request, signal()), code('draft-sequence-conflict'))
  assert.equal((await drafts.list({ workspaceId: request.workspaceId, bookId: request.bookId, chapterId: request.chapterId })).drafts.length, 2)
  assert.equal((await drafts.read(version(request))).savedAt, receipt.savedAt)
})

test('settling a saved checkpoint requires the actual disk hash and never settles later input', async t => {
  const { books, book, drafts, request } = await fixture(t)
  const receipt = await drafts.put(request, signal())
  const settle = { ...version(request), contentHash: receipt.contentHash, action: 'saved' as const }
  await assert.rejects(drafts.settle(settle, signal()), code('revision-conflict'))
  await books.mutate({ operationId: request.operationId, bookId: book.bookId, chapterId: request.chapterId, expectedRevision: book.revision, expectedHash: request.baseHash, action: 'save', title: '', beforeChapterId: '', content: request.content }, signal())
  const next = { ...request, sequence: 2, content: '保存中继续输入。', operationId: randomUUID() }
  await drafts.put(next, signal())
  await drafts.settle(settle, signal())
  const list = await drafts.list({ workspaceId: request.workspaceId, bookId: request.bookId, chapterId: request.chapterId })
  assert.deepEqual(list.drafts.map(item => item.sequence), [2])
  assert.equal((await drafts.read(version(request))).content, request.content)
  await drafts.settle({ ...version(next), contentHash: hash(next.content), action: 'dismissed' }, signal())
  assert.deepEqual(await drafts.list({ workspaceId: request.workspaceId, bookId: request.bookId, chapterId: request.chapterId }), { drafts: [], unreadable: 0 })
})

test('corrupt checkpoint and mismatched location are rejected; linked draft directories cannot redirect writes', async t => {
  const { root, drafts, request } = await fixture(t)
  await assert.rejects(drafts.put({ ...request, workspaceId: hash('another root') }, signal()), code('location-changed'))
  await drafts.put(request, signal())
  const path = join(root, 'novels', request.bookId, 'drafts', request.chapterId, request.branchId, '0000000000000001.json')
  const text = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...text, content: '篡改' }))
  await assert.rejects(drafts.read(version(request)), code('invalid-format'))
  const branch = randomUUID(), outside = join(root, 'outside')
  await mkdir(outside)
  await symlink(outside, join(root, 'novels', request.bookId, 'drafts', request.chapterId, branch))
  await assert.rejects(drafts.put({ ...request, branchId: branch }, signal()), code('unsafe-path'))
  assert.deepEqual(await readdir(outside), [])
})

test('invalid text, cancelled calls, busy branch and failed publication do not report a saved checkpoint', async t => {
  const { root, drafts, request } = await fixture(t)
  await assert.rejects(drafts.put({ ...request, content: '\0' }, signal()))
  await assert.rejects(drafts.put({ ...request, content: '\ud800' }, signal()))
  await assert.rejects(drafts.put({ ...request, content: 'a'.repeat(4 * 1024 * 1024 + 1) }, signal()))
  const controller = new AbortController(); controller.abort()
  await assert.rejects(drafts.put(request, controller.signal), { name: 'AbortError' })
  const query = { workspaceId: request.workspaceId, bookId: request.bookId, chapterId: request.chapterId }
  assert.deepEqual(await drafts.list(query), { drafts: [], unreadable: 0 })
  const folder = join(root, 'novels', request.bookId, 'drafts', request.chapterId, request.branchId)
  await mkdir(join(folder, '.write.lock'), { recursive: true })
  await assert.rejects(drafts.put(request, signal()), code('busy'))
  assert.deepEqual(await drafts.list(query), { drafts: [], unreadable: 0 })
})

test('a damaged latest checkpoint reports the problem while keeping the previous complete draft recoverable', async t => {
  const { root, drafts, request } = await fixture(t)
  await drafts.put(request, signal())
  await drafts.put({ ...request, sequence: 2, content: '后一检查点。', operationId: randomUUID() }, signal())
  const folder = join(root, 'novels', request.bookId, 'drafts', request.chapterId, request.branchId)
  await writeFile(join(folder, '0000000000000002.json'), '{incomplete')
  const query = { workspaceId: request.workspaceId, bookId: request.bookId, chapterId: request.chapterId }
  const listing = await drafts.list(query)
  assert.equal(listing.unreadable, 1)
  assert.deepEqual(listing.drafts.map(item => item.sequence), [1])
  assert.equal((await drafts.read(version(request))).content, request.content)
  assert.equal(await readFile(join(folder, '0000000000000002.json'), 'utf8'), '{incomplete')
})

function controlledWriter() {
  const identity = { workspaceId: hash('test'), bookId: randomUUID(), chapterId: randomUUID(), branchId: randomUUID() }
  const gates = [], states = [], cached = [], settled = [], forgotten = []
  const writer = new DraftWriter(identity, {
    cache: async request => { cached.push(request); return true }, forget: async request => { forgotten.push(request); return true },
    checkpoint: request => new Promise((resolve, reject) => gates.push({ request, resolve: () => resolve({ ...version(request), baseHash: request.baseHash, bookRevision: request.bookRevision, contentHash: hash(request.content), savedAt: Date.now(), operationId: request.operationId }), reject })),
    settle: async request => { settled.push(request); return request }, changed: state => states.push(state),
  })
  return { writer, gates, states, cached, settled, forgotten }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const entry = content => ({ content, operationId: randomUUID(), baseHash: hash('formal'), bookRevision: 2 })

test('an old checkpoint receipt never confirms or erases newer input; save settles only its captured operation', async t => {
  const { writer, gates, states, settled, forgotten } = controlledWriter()
  t.after(() => writer.clearTimers())
  const first = entry('first'), second = entry('second')
  writer.update(first); const old = writer.flush(); await tick()
  writer.update(second); const current = writer.flush()
  gates[0].resolve(); await old; await tick()
  assert(['saving', 'browser'].includes(states.at(-1).kind))
  assert.equal(gates[1].request.content, 'second')
  await writer.settle(first, 'saved')
  assert.equal(settled[0].sequence, 1)
  assert.equal(forgotten.length, 0)
  assert.equal(writer.latest.content, 'second')
  gates[1].resolve(); await current
  assert.equal(states.at(-1).kind, 'disk')
  await writer.settle(second, 'saved')
  assert.equal(forgotten[0].content, 'second')
  assert.equal(writer.state.kind, 'formal')
})

test('checkpoint failures keep input retryable; IME composition does not publish incomplete text', async t => {
  const { writer, gates } = controlledWriter()
  t.after(() => writer.clearTimers())
  writer.composing = true; writer.update(entry('组字'))
  await assert.rejects(writer.flush(), /draft-composing/)
  assert.equal(gates.length, 0)
  writer.composing = false; const failed = writer.flush(); await tick(); gates[0].reject(new Error('disk full'))
  await assert.rejects(failed, /disk full/)
  assert.equal(writer.state.kind, 'failed')
  assert.equal(writer.latest.content, '组字')
  const retry = writer.flush(); await tick(); gates[1].resolve(); await retry
  assert.equal(writer.state.kind, 'disk')
})
