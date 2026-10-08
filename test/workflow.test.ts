import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BookStore } from '../lib/host/book-store.js'
import { ProposalStore } from '../lib/host/proposal-store.js'
import { ProposalTasks } from '../lib/host/proposal-tasks.js'
import { ReviewStore } from '../lib/host/review-store.js'
import { hash } from '../lib/domain/books.js'
const signal = () => new AbortController().signal
async function fixture(t) {
  await mkdir('.test-output', { recursive: true }); const root = await mkdtemp(resolve('.test-output/workflow-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const books = await BookStore.at(root), bookId = randomUUID(), chapterId = randomUUID(), text = '旧版正文。'
  await mkdir(join(root, 'novels', bookId, 'chapters'), { recursive: true })
  await mkdir(join(root, 'novels', bookId, 'transactions'), { recursive: true })
  const manifest = JSON.stringify({ schemaVersion: 1, bookId, title: '旧作品', revision: 1, chapters: [{ chapterId, title: '首章', revision: 1, hash: hash(text) }] })
  await writeFile(join(root, 'novels', bookId, 'project.json'), manifest); await writeFile(join(root, 'novels', bookId, 'chapters', `${chapterId}.md`), text)
  return { root, books, bookId, chapterId, text, manifest, store: await ProposalStore.at(root, hash(root), books) }
}
test('legacy schema-1 book without kind is read without migration and remains writable', async t => {
  const f = await fixture(t)
  assert.equal((await f.books.readChapter(f.bookId, f.chapterId)).content, f.text)
  assert.equal(await readFile(join(f.root, 'novels', f.bookId, 'project.json'), 'utf8'), f.manifest)
  const book = await f.books.mutate({ operationId: randomUUID(), bookId: f.bookId, chapterId: f.chapterId, expectedRevision: 1, action: 'save', title: '', content: '新版作者稿。', expectedHash: hash(f.text), beforeChapterId: '' }, signal())
  assert.equal(book.revision, 2); assert.equal(book.chapters[0].kind, undefined)
})
test('unload cancels and settles detached tasks, retains durable prefix and releases runtime ownership', async t => {
  const f = await fixture(t), tasks = new ProposalTasks(), request = { proposalId: randomUUID(), bookId: f.bookId, chapterId: f.chapterId, expectedRevision: 1, expectedHash: hash(f.text), mode: 'draft', instruction: '写', materials: '', start: 0, end: f.text.length }
  let started; const ready = new Promise(resolve => { started = resolve })
  await tasks.start(f.store, 'a', request, async (_proposal, abort, progress) => {
    await progress('收到的前缀。'); started(true)
    await new Promise((resolve, reject) => { if (abort.aborted) reject(abort.reason); else abort.addEventListener('abort', () => reject(abort.reason), { once: true }) })
    throw new Error('unexpected finish')
  }, signal())
  await ready; await tasks.dispose()
  const view = await f.store.view(f.bookId, request.proposalId, false)
  assert.equal(view.state, 'interrupted'); assert.equal(view.reason, 'host-unloaded'); assert.equal(view.replacement, '收到的前缀。')
  assert.equal(await f.store.runningElsewhere(f.bookId, request.proposalId), false)
  assert.equal((await f.books.readChapter(f.bookId, f.chapterId)).content, f.text)
  await assert.rejects(tasks.start(f.store, 'a', request, async () => { throw new Error('must not run') }, signal()), error => error.code === 'generation-unavailable')
})
test('review ID lock blocks a second host and cancellation releases it without a completed assessment', async t => {
  const f = await fixture(t), first = await ReviewStore.at(f.root, hash(f.root), f.books), second = await ReviewStore.at(f.root, hash(f.root), f.books)
  const request = { reviewId: randomUUID(), bookId: f.bookId, chapterId: f.chapterId, proposalId: '', expectedRevision: 1, expectedHash: hash(f.text), minCharacters: 0, maxCharacters: 0, minParagraphs: 0, maxParagraphs: 0 }, controller = new AbortController()
  let started; const ready = new Promise(resolve => { started = resolve })
  const task = first.run(request, async (_prompt, _system, abort) => { started(true); await new Promise((resolve, reject) => abort.addEventListener('abort', () => reject(abort.reason), { once: true })); throw new Error('unexpected finish') }, controller.signal)
  await ready; await assert.rejects(second.run(request, false, signal()), error => error.code === 'busy')
  controller.abort(); await assert.rejects(task, { name: 'AbortError' })
  assert.deepEqual(await second.list(f.bookId, f.chapterId), [])
  assert.equal((await second.run(request, false, signal())).state, 'unknown')
})
