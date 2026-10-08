import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BookStore } from '../lib/host/book-store.js'
import type { ChapterMutationRequest } from '../src/types.js'

const signal = () => new AbortController().signal
const matches = (code: string) => (error: Error & { code?: string }) => error.code === code

async function fixture(t) {
  await mkdir('.test-output', { recursive: true })
  const root = await mkdtemp(resolve('.test-output/books-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const store = await BookStore.at(root)
  const book = await store.createBook({ operationId: randomUUID(), title: '雨夜渡河' }, signal())
  return { root, store, book }
}

function request(book, changes = {}): ChapterMutationRequest {
  return { operationId: randomUUID(), bookId: book.bookId, expectedRevision: book.revision,
    action: 'create', chapterId: randomUUID(), title: '第一章 雨夜', beforeChapterId: '', content: '', expectedHash: '', ...changes }
}

for (const stage of ['creation', 'prepared', 'manifest', 'completed'] as const) {
  test(`book initialization interrupted at ${stage} remains visible and recoverable`, async t => {
    await mkdir('.test-output', { recursive: true })
    const root = await mkdtemp(resolve('.test-output/create-books-'))
    t.after(() => rm(root, { force: true, recursive: true }))
    const creation = { operationId: randomUUID(), title: '未完成创建' }
    const store = await BookStore.at(root, { afterStage: async value => { if (value === stage) throw new Error('Interrupted initialization') } })
    await assert.rejects(store.createBook(creation, signal()), /Interrupted initialization/)
    const reopened = await BookStore.at(root)
    const library = await reopened.list()
    assert.equal(library.length, 1)
    assert.equal(library[0].title, creation.title)
    assert.equal(library[0].recoveryRequired, true)
    await assert.rejects(reopened.createBook(creation, signal()), matches('recovery-required'))
    assert.equal((await reopened.recover(creation.operationId, signal())).recoveryRequired, false)
    assert.equal((await reopened.createBook(creation, signal())).bookId, creation.operationId)
    assert.equal((await reopened.list()).length, 1)
  })
}

test('library reads are pure; books and chapters persist across fresh instances and sessions', async t => {
  await mkdir('.test-output', { recursive: true })
  const root = await mkdtemp(resolve('.test-output/empty-books-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const store = await BookStore.at(root)
  assert.deepEqual(await store.list(), [])
  assert.deepEqual(await readdir(root), [])
  const books = []
  for (const title of ['同名书', '同名书']) {
    const book = await store.createBook({ operationId: randomUUID(), title }, signal())
    const create = request(book)
    const next = await store.mutate(create, signal())
    const chapter = await store.readChapter(book.bookId, create.chapterId)
    const text = `\uFEFF${title} ${book.bookId}\n\n手腕还在疼。\r\n雨落在船板上。\n`
    const saved = await store.mutate(request(next, { action: 'save', chapterId: create.chapterId, content: text, expectedHash: chapter.hash }), signal())
    books.push({ saved, create, text })
  }
  const reopened = await BookStore.at(root)
  assert.equal((await reopened.list()).length, 2)
  for (const { saved, create, text } of books) {
    const chapter = await reopened.readChapter(saved.bookId, create.chapterId)
    assert.equal(chapter.content, text)
    assert.equal(chapter.externallyModified, false)
    assert.equal(chapter.book.revision, 3)
    assert.equal(chapter.book.chapters[0].revision, 2)
  }
})

test('rename and order preserve stable paths and chapter contents', async t => {
  const { root, store, book } = await fixture(t)
  const first = request(book)
  const next = await store.mutate(first, signal())
  const second = request(next, { title: '第二章' })
  const two = await store.mutate(second, signal())
  const moved = await store.mutate(request(two, { action: 'move', chapterId: second.chapterId, beforeChapterId: first.chapterId }), signal())
  assert.deepEqual(moved.chapters.map(item => item.chapterId), [second.chapterId, first.chapterId])
  const renamed = await store.mutate(request(moved, { action: 'rename', chapterId: first.chapterId, title: '新章名 / 不是文件名' }), signal())
  assert.equal(renamed.chapters[1].title, '新章名 / 不是文件名')
  assert.deepEqual((await readdir(join(root, 'novels', book.bookId, 'chapters'))).sort(), [first.chapterId, second.chapterId].map(id => `${id}.md`).sort())
  await assert.rejects(store.mutate(request(renamed, { action: 'move', chapterId: first.chapterId, beforeChapterId: randomUUID() }), signal()), matches('chapter-not-found'))
})

test('same operations replay exactly; reused IDs with new data are rejected', async t => {
  const { store, book } = await fixture(t)
  const creation = { operationId: book.bookId, title: book.title }
  assert.deepEqual(await store.createBook(creation, signal()), book)
  await assert.rejects(store.createBook({ ...creation, title: '另一本书' }, signal()), matches('operation-conflict'))
  const create = request(book)
  const next = await store.mutate(create, signal())
  assert.deepEqual(await store.mutate(create, signal()), next)
  await assert.rejects(store.mutate({ ...create, title: '另一个标题' }, signal()), matches('operation-conflict'))
  assert.equal((await store.readBook(book.bookId)).chapters.length, 1)
})

test('external edits and stale book revisions cannot be overwritten', async t => {
  const { root, store, book } = await fixture(t)
  const create = request(book)
  const next = await store.mutate(create, signal())
  const original = await store.readChapter(book.bookId, create.chapterId)
  const path = join(root, 'novels', book.bookId, 'chapters', `${create.chapterId}.md`)
  await writeFile(path, '作者在外部编辑器写入。')
  const save = request(next, { action: 'save', chapterId: create.chapterId, content: '候选覆盖', expectedHash: original.hash })
  await assert.rejects(store.mutate(save, signal()), matches('revision-conflict'))
  assert.equal(await readFile(path, 'utf8'), '作者在外部编辑器写入。')
  const external = await store.readChapter(book.bookId, create.chapterId)
  assert.equal(external.externallyModified, true)
  const saved = await store.mutate({ ...save, operationId: randomUUID(), content: external.content, expectedHash: external.hash }, signal())
  assert.equal((await store.readChapter(book.bookId, create.chapterId)).externallyModified, false)
  await assert.rejects(store.mutate(request(next, { action: 'rename', chapterId: create.chapterId, title: '过期改名' }), signal()), matches('revision-conflict'))
  assert.equal(saved.revision, next.revision + 1)
})

for (const stage of ['prepared', 'chapter', 'manifest', 'completed'] as const) {
  test(`interruption at ${stage} retains exact before/after text and recovers deterministically`, async t => {
    const { root, store, book } = await fixture(t)
    const create = request(book)
    const next = await store.mutate(create, signal())
    const original = await store.readChapter(book.bookId, create.chapterId)
    const save = request(next, { action: 'save', chapterId: create.chapterId, content: '新正文\n原样保存\r\n', expectedHash: original.hash })
    const broken = await BookStore.at(root, { afterStage: async value => { if (value === stage) throw new Error('Injected disk failure') } })
    await assert.rejects(broken.mutate(save, signal()), /Injected disk failure/)
    const reopened = await BookStore.at(root)
    const view = await reopened.readBook(book.bookId)
    assert.equal(view.recoveryRequired, stage !== 'completed')
    if (stage !== 'completed') await assert.rejects(reopened.readChapter(book.bookId, create.chapterId), matches('recovery-required'))
    const recovered = await reopened.recover(book.bookId, signal())
    assert.equal(recovered.recoveryRequired, false)
    assert.equal((await reopened.readChapter(book.bookId, create.chapterId)).content, save.content)
    assert.deepEqual(await reopened.mutate(save, signal()), recovered)
    const receipt = JSON.parse(await readFile(join(root, 'novels', book.bookId, 'transactions', `${save.operationId}.json`), 'utf8'))
    assert.equal(receipt.changes[0].before.text, '')
    assert.equal(receipt.changes[0].after, save.content)
  })
}

test('recovery stops at third-party edits and never overwrites them', async t => {
  const { root, store, book } = await fixture(t)
  const create = request(book)
  const next = await store.mutate(create, signal())
  const initial = await store.readChapter(book.bookId, create.chapterId)
  const broken = await BookStore.at(root, { afterStage: async stage => { if (stage === 'chapter') throw new Error('Crash') } })
  await assert.rejects(broken.mutate(request(next, { action: 'save', chapterId: create.chapterId, content: '已准备正文', expectedHash: initial.hash }), signal()))
  const path = join(root, 'novels', book.bookId, 'chapters', `${create.chapterId}.md`)
  await writeFile(path, '恢复前的作者新修改')
  await assert.rejects(store.recover(book.bookId, signal()), matches('recovery-conflict'))
  assert.equal(await readFile(path, 'utf8'), '恢复前的作者新修改')
  assert.equal((await store.readBook(book.bookId)).recoveryRequired, true)
})

test('external edits during publication leave a recoverable conflict instead of a valid mixed revision', async t => {
  const { root, store, book } = await fixture(t)
  const create = request(book)
  const next = await store.mutate(create, signal())
  const initial = await store.readChapter(book.bookId, create.chapterId)
  const path = join(root, 'novels', book.bookId, 'chapters', `${create.chapterId}.md`)
  const interrupted = await BookStore.at(root, { afterStage: async stage => { if (stage === 'chapter') await writeFile(path, '作者新稿') } })
  await assert.rejects(interrupted.mutate(request(next, { action: 'save', chapterId: create.chapterId, content: '待保存稿', expectedHash: initial.hash }), signal()), matches('recovery-conflict'))
  assert.equal(await readFile(path, 'utf8'), '作者新稿')
  assert.equal((await store.readBook(book.bookId)).recoveryRequired, true)
})

test('parallel writers settle without duplication; crash locks are never stolen', async t => {
  const { root, store, book } = await fixture(t)
  const other = await BookStore.at(root)
  const results = await Promise.allSettled([store.mutate(request(book), signal()), other.mutate(request(book), signal())])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal((await store.readBook(book.bookId)).chapters.length, 1)
  await mkdir(join(root, 'novels', book.bookId, '.write.lock'))
  await assert.rejects(store.recover(book.bookId, signal()), matches('busy'))
  assert((await readdir(join(root, 'novels', book.bookId))).includes('.write.lock'))
})

test('symlink paths, cross-book chapters, malformed formats and future versions are rejected', async t => {
  const { root, store, book } = await fixture(t)
  const other = await store.createBook({ operationId: randomUUID(), title: '另一本' }, signal())
  const create = request(book)
  const next = await store.mutate(create, signal())
  await assert.rejects(store.readChapter(other.bookId, create.chapterId), matches('chapter-not-found'))
  await assert.rejects(store.readBook('../outside'))
  const path = join(root, 'novels', book.bookId, 'chapters', `${create.chapterId}.md`)
  const sentinel = join(root, 'sentinel.md')
  await writeFile(sentinel, '保留')
  await rm(path)
  await symlink(sentinel, path)
  await assert.rejects(store.readChapter(book.bookId, create.chapterId), matches('unsafe-path'))
  assert.equal(await readFile(sentinel, 'utf8'), '保留')
  const manifest = join(root, 'novels', book.bookId, 'project.json')
  await writeFile(manifest, '{bad')
  await assert.rejects(store.readBook(book.bookId), matches('invalid-format'))
  await writeFile(manifest, JSON.stringify({ ...next, recoveryRequired: undefined, schemaVersion: 999 }))
  await assert.rejects(store.readBook(book.bookId), matches('unsupported-format'))
})

test('abort, oversized text and unwritable directories fail before publication', async t => {
  const { root, store, book } = await fixture(t)
  await assert.rejects(store.mutate(request(book), AbortSignal.abort()), { name: 'AbortError' })
  await assert.rejects(store.mutate(request(book, { content: 'a'.repeat(4 * 1024 * 1024 + 1) }), signal()))
  const folder = join(root, 'novels', book.bookId)
  await chmod(folder, 0o500)
  try { await assert.rejects(store.mutate(request(book), signal()), error => ['EACCES', 'EPERM'].includes(error.code)) }
  finally { await chmod(folder, 0o700) }
  assert.equal((await store.readBook(book.bookId)).chapters.length, 0)
  assert.equal((await store.readBook(book.bookId)).recoveryRequired, false)
})

test('escaped journals cannot exceed their read limit or leave an unreadable pending save', async t => {
  const { root, store, book } = await fixture(t)
  const create = request(book)
  const next = await store.mutate(create, signal())
  const chapter = await store.readChapter(book.bookId, create.chapterId)
  const content = '\u0001'.repeat(3 * 1024 * 1024)
  const saved = await store.mutate(request(next, { action: 'save', chapterId: create.chapterId, content, expectedHash: chapter.hash }), signal())
  await assert.rejects(store.mutate(request(saved, { action: 'save', chapterId: create.chapterId,
    content: content + '尾句', expectedHash: saved.chapters[0].hash }), signal()), matches('too-large'))
  assert.equal((await store.readBook(book.bookId)).revision, saved.revision)
  assert.equal((await store.readChapter(book.bookId, create.chapterId)).content, content)
  assert(!(await readdir(join(root, 'novels', book.bookId))).includes('pending.json'))
})

test('large chapter directories reject growth before exceeding the index read limit', async t => {
  const { root, store, book } = await fixture(t)
  const metadata = { schemaVersion: book.schemaVersion, bookId: book.bookId, title: book.title, revision: book.revision, chapters: [] }
  const chapter = { chapterId: randomUUID(), title: '章'.repeat(200), revision: 1, hash: 'a'.repeat(64) }
  const serialize = value => JSON.stringify(value, null, 2) + '\n'
  const oneSize = Buffer.byteLength(serialize({ ...metadata, chapters: [chapter] }))
  const rowSize = Buffer.byteLength(serialize({ ...metadata, chapters: [chapter, chapter] })) - oneSize
  const count = 1 + Math.floor((4 * 1024 * 1024 - oneSize) / rowSize)
  metadata.chapters = Array.from({ length: count }, () => ({ ...chapter, chapterId: randomUUID() }))
  await writeFile(join(root, 'novels', book.bookId, 'project.json'), serialize(metadata))
  const before = await store.readBook(book.bookId)
  await assert.rejects(store.mutate(request(before, { title: chapter.title }), signal()), matches('too-large'))
  assert.deepEqual(await store.readBook(book.bookId), before)
  assert(!(await readdir(join(root, 'novels', book.bookId))).includes('pending.json'))
})
