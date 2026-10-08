import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BookStore } from '../lib/host/book-store.js'
import { ChapterHistory } from '../lib/host/chapter-history.js'
import { ChapterConflicts } from '../lib/host/chapter-conflicts.js'
import { hash } from '../lib/domain/books.js'

const signal = () => new AbortController().signal
const reason = code => error => error.code === code
async function fixture(t) {
  await mkdir('.test-output', { recursive: true })
  const root = await mkdtemp(resolve('.test-output/history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const books = await BookStore.at(root)
  let book = await books.createBook({ operationId: randomUUID(), title: '渡河' }, signal())
  const chapterId = randomUUID()
  const change = (content, expectedRevision, expectedHash) => ({ operationId: randomUUID(), bookId: book.bookId, chapterId,
    expectedRevision, expectedHash, action: 'save', title: '', beforeChapterId: '', content })
  book = await books.mutate({ ...change('', 1, ''), action: 'create', title: '渡口' }, signal())
  const first = change('\uFEFF原稿\r\n手腕还在疼。', book.revision, hash(''))
  book = await books.mutate(first, signal())
  const second = change('新版正文。', book.revision, hash(first.content))
  book = await books.mutate(second, signal())
  const history = new ChapterHistory(books)
  const conflicts = await ChapterConflicts.at(root, hash(root), books)
  const restore = { operationId: randomUUID(), bookId: book.bookId, chapterId, sourceOperationId: first.operationId,
    expectedSourceHash: hash(first.content), expectedRevision: book.revision, expectedHash: hash(second.content) }
  const path = join(root, 'novels', book.bookId, 'chapters', `${chapterId}.md`)
  return { root, books, book, chapterId, first, second, history, conflicts, restore, path }
}

test('old receipts form exact immutable history; restoring creates a new revision and replays once', async t => {
  const f = await fixture(t)
  const before = await f.history.list(f.book.bookId, f.chapterId, 0)
  assert.deepEqual(before.map(item => item.chapterRevision), [3, 2, 1])
  assert.equal(before[0].source, 'save')
  const old = await f.history.read(f.book.bookId, f.chapterId, f.first.operationId)
  assert.equal(old.content, f.first.content)
  const next = await f.history.restore(f.restore, signal())
  assert.equal(next.revision, f.book.revision + 1)
  assert.equal(next.chapters[0].revision, 4)
  assert.equal(await readFile(f.path, 'utf8'), f.first.content)
  assert.deepEqual(await f.history.restore(f.restore, signal()), next)
  await assert.rejects(f.history.restore({ ...f.restore, sourceOperationId: f.second.operationId, expectedSourceHash: hash(f.second.content) }, signal()), reason('operation-conflict'))
  assert.equal((await f.history.list(f.book.bookId, f.chapterId, 0))[0].source, 'restore')
  assert.equal((await f.history.list(f.book.bookId, f.chapterId, f.book.revision)).length, 2)
})

for (const stage of ['prepared', 'chapter', 'manifest', 'completed'] as const) {
  test(`restore survives a failure at ${stage} without duplicate versions`, async t => {
    const f = await fixture(t)
    const broken = await BookStore.at(f.root, { afterStage: async value => { if (value === stage) throw Object.assign(new Error('disk-full'), { code: 'ENOSPC' }) } })
    await assert.rejects(new ChapterHistory(broken).restore(f.restore, signal()), /disk-full/)
    if (stage !== 'completed') {
      await assert.rejects(f.history.read(f.book.bookId, f.chapterId, f.first.operationId), reason('recovery-required'))
      await f.books.recover(f.book.bookId, signal())
    }
    assert.equal((await f.history.restore(f.restore, signal())).revision, f.book.revision + 1)
    assert.equal(await readFile(f.path, 'utf8'), f.first.content)
  })
}

test('conflict records keep both texts, resolve once and reject subsequent disk changes', async t => {
  const f = await fixture(t)
  await writeFile(f.path, '外部新稿。')
  const preserve = { conflictId: randomUUID(), bookId: f.book.bookId, chapterId: f.chapterId,
    baselineRevision: f.book.revision, baselineHash: hash(f.second.content), localContent: '未保存本地稿。' }
  const record = await f.conflicts.preserve(preserve, signal())
  assert.equal(record.diskContent, '外部新稿。')
  assert.deepEqual(await f.conflicts.preserve(preserve, signal()), record)
  await assert.rejects(f.conflicts.preserve({ ...preserve, localContent: '改过的稿' }, signal()), reason('operation-conflict'))
  const request = { operationId: randomUUID(), bookId: f.book.bookId, conflictId: record.conflictId,
    expectedRevision: f.book.revision, expectedHash: record.diskHash, choice: 'merged', mergedContent: '外部新稿。\n未保存本地稿。' }
  await writeFile(f.path, '外部再改。')
  await assert.rejects(f.conflicts.resolve(request, signal()), reason('revision-conflict'))
  await assert.rejects(f.conflicts.resolve({ ...request, expectedHash: hash('外部再改。'), choice: 'disk', mergedContent: '' }, signal()), reason('revision-conflict'))
  const nextRequest = { ...request, expectedHash: hash('外部再改。'), mergedContent: '外部再改。\n未保存本地稿。' }
  const next = await f.conflicts.resolve(nextRequest, signal())
  assert.equal(await readFile(f.path, 'utf8'), nextRequest.mergedContent)
  assert.deepEqual(await f.conflicts.resolve(nextRequest, signal()), next)
  await assert.rejects(f.conflicts.resolve({ ...nextRequest, operationId: randomUUID() }, signal()), reason('conflict-resolved'))
  assert.equal((await f.conflicts.list(f.book.bookId, f.chapterId))[0].resolved, true)
  assert.equal((await f.conflicts.list(f.book.bookId, f.chapterId))[0].localContent, preserve.localContent)
})

test('two hosts cannot resolve a conflict twice; disk failure keeps both drafts after reopening', async t => {
  const f = await fixture(t)
  const record = await f.conflicts.preserve({ conflictId: randomUUID(), bookId: f.book.bookId, chapterId: f.chapterId,
    baselineRevision: f.book.revision, baselineHash: hash(f.second.content), localContent: '作者本地稿' }, signal())
  const request = { operationId: randomUUID(), bookId: f.book.bookId, conflictId: record.conflictId,
    expectedRevision: f.book.revision, expectedHash: record.diskHash, choice: 'local', mergedContent: '' }
  const broken = await BookStore.at(f.root, { afterStage: async stage => { if (stage === 'chapter') throw new Error('power-loss') } })
  await assert.rejects((await ChapterConflicts.at(f.root, hash(f.root), broken)).resolve(request, signal()), /power-loss/)
  await f.books.recover(f.book.bookId, signal())
  assert.deepEqual(await f.conflicts.resolve(request, signal()), await f.books.readBook(f.book.bookId))
  const other = await ChapterConflicts.at(f.root, hash(f.root), await BookStore.at(f.root))
  await assert.rejects(other.resolve({ ...request, operationId: randomUUID() }, signal()), reason('conflict-resolved'))
  assert.equal((await other.list(f.book.bookId, f.chapterId))[0].diskContent, f.second.content)
})

test('future transaction formats stop history and restoration', async t => {
  const f = await fixture(t)
  const receipt = join(f.root, 'novels', f.book.bookId, 'transactions', `${f.first.operationId}.json`)
  const value = JSON.parse(await readFile(receipt, 'utf8'))
  await writeFile(receipt, JSON.stringify({ ...value, schemaVersion: 99 }))
  await assert.rejects(f.history.list(f.book.bookId, f.chapterId, 0), reason('unsupported-format'))
  await assert.rejects(f.history.restore(f.restore, signal()), reason('unsupported-format'))
  assert.equal(await readFile(f.path, 'utf8'), f.second.content)
})

for (const stage of ['prepared', 'chapter', 'manifest', 'completed'] as const) {
  test(`explicit interrupted-save resolution survives failure at ${stage} and keeps the original journal`, async t => {
    const f = await fixture(t)
    const initial = await BookStore.at(f.root, { afterStage: async stage => { if (stage === 'chapter') throw new Error('initial-crash') } })
    const original = { ...f.second, operationId: randomUUID(), expectedRevision: f.book.revision, expectedHash: hash(f.second.content), content: '计划新稿' }
    await assert.rejects(initial.mutate(original, signal()), /initial-crash/)
    await writeFile(f.path, '作者再次修改')
    await assert.rejects(f.books.recover(f.book.bookId, signal()), reason('recovery-conflict'))
    const view = await f.books.interrupted(f.book.bookId)
    assert.equal(view.preparedContent, original.content)
    assert.equal(view.diskContent, '作者再次修改')
    const request = { operationId: randomUUID(), bookId: f.book.bookId, pendingHash: view.pendingHash, diskHash: view.diskHash, content: '作者再次修改\n计划新稿' }
    const broken = await BookStore.at(f.root, { afterStage: async value => { if (value === stage) throw new Error('second-crash') } })
    await assert.rejects(broken.settleInterrupted(request, signal()), /second-crash/)
    const reopened = await BookStore.at(f.root)
    const restored = await reopened.settleInterrupted(request, signal())
    assert.equal(restored.revision, f.book.revision + 2)
    assert.equal(restored.recoveryRequired, false)
    assert.equal(await readFile(f.path, 'utf8'), request.content)
    assert.deepEqual(await reopened.settleInterrupted(request, signal()), restored)
    const archive = JSON.parse(await readFile(join(f.root, 'novels', f.book.bookId, 'recoveries', `${original.operationId}.json`), 'utf8'))
    assert.equal(archive.changes[0].before.text, f.second.content)
    assert.equal(archive.changes[0].after, original.content)
    await assert.rejects(reopened.settleInterrupted({ ...request, content: 'reused-id' }, signal()), reason('operation-conflict'))
  })
}
