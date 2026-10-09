import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BookStore } from '../lib/host/book-store.js'
import { BookFiles } from '../lib/host/book-files.js'
import { MaterialCatalog } from '../lib/host/material-catalog.js'
import { ProposalStore } from '../lib/host/proposal-store.js'
import { hash, json, parseBook } from '../lib/domain/books.js'
const signal = () => new AbortController().signal
async function fixture(t, hooks = {}) {
  await mkdir('.test-output', { recursive: true }); const root = await mkdtemp(resolve('.test-output/library-')); t.after(() => rm(root, { recursive: true, force: true }))
  const books = await BookStore.at(root, hooks), bookId = randomUUID(), chapterId = randomUUID(), materialId = randomUUID()
  await books.createBook({ operationId: bookId, title: '材料测试' }, signal())
  await books.mutate({ operationId: randomUUID(), bookId, expectedRevision: 1, action: 'create', chapterId, title: '正文', content: '林舟在渡口。', expectedHash: '', beforeChapterId: '' }, signal())
  const book = await books.mutate({ operationId: randomUUID(), bookId, expectedRevision: 2, action: 'create', chapterId: materialId, title: '林舟', kind: 'character', content: '左手受伤，藏着铜钥匙。', expectedHash: '', beforeChapterId: '' }, signal())
  return { root, books, book, chapterId, materialId, catalog: await MaterialCatalog.at(root, books) }
}
const metadata = (book, id, extra = {}) => ({ workspaceId: '0'.repeat(64), bookId: book.bookId, expectedRevision: book.revision, operationId: randomUUID(), chapterId: id, tags: ['渡口'], aliases: ['阿舟'], favorite: true, status: 'active', linkedChapterIds: [], relatedMaterialIds: [], ...extra })
const query = (bookId, extra = {}) => ({ bookId, query: '', kind: 'all', status: 'available', tag: '', linkedChapterId: '', favorite: false, offset: 0, ...extra })

test('explicit migration preserves text and old receipts, material metadata uses stable IDs and rejects impossible links', async t => {
  const { root, books, book, materialId, chapterId, catalog } = await fixture(t)
  await assert.rejects(books.metadata(metadata(book, materialId), signal()), /migration-required/)
  const oldText = await readFile(join(root, 'novels', book.bookId, 'chapters', `${chapterId}.md`))
  const upgraded = await books.upgrade(book.bookId, book.revision, randomUUID(), signal())
  assert.equal(upgraded.schemaVersion, 2)
  assert.deepEqual(await readFile(join(root, 'novels', book.bookId, 'chapters', `${chapterId}.md`)), oldText)
  const updated = await books.metadata(metadata(upgraded, materialId, { linkedChapterIds: [chapterId] }), signal())
  assert.equal(updated.chapters.find(item => item.chapterId === materialId).aliases[0], '阿舟')
  assert.equal((await catalog.search(query(book.bookId, { query: '铜钥匙', tag: '渡口', linkedChapterId: chapterId, favorite: true }), signal())).total, 1)
  assert.equal((await catalog.search(query(book.bookId, { query: '阿舟' }), signal())).total, 1)
  await assert.rejects(books.metadata(metadata(updated, materialId, { relatedMaterialIds: [chapterId] }), signal()))
  const raw = JSON.parse(await readFile(join(root, 'novels', book.bookId, 'project.json'), 'utf8')); raw.schemaVersion = 9
  assert.throws(() => parseBook(json(raw), book.bookId), /unsupported-format/)
})

for (const stage of ['prepared', 'manifest', 'completed']) test(`migration interrupted at ${stage} is explicitly recoverable, same ID replays`, async t => {
  const f = await fixture(t), operationId = randomUUID()
  const broken = await BookStore.at(f.root, { afterStage: async point => { if (point === stage) throw new Error('cut') } })
  await assert.rejects(broken.upgrade(f.book.bookId, f.book.revision, operationId, signal()), /cut/)
  const current = await f.books.readBook(f.book.bookId)
  if (current.recoveryRequired) await f.books.recover(f.book.bookId, signal())
  assert.equal((await f.books.upgrade(f.book.bookId, f.book.revision, operationId, signal())).schemaVersion, 2)
  assert.equal((await f.books.readChapter(f.book.bookId, f.chapterId)).content, '林舟在渡口。')
})

test('trash and archive retain files, drafts and history while excluding material from new tasks; restore keeps IDs', async t => {
  const f = await fixture(t), upgraded = await f.books.upgrade(f.book.bookId, f.book.revision, randomUUID(), signal())
  const trashed = await f.books.metadata(metadata(upgraded, f.materialId, { status: 'trashed' }), signal())
  assert.equal((await f.catalog.search(query(f.book.bookId), signal())).total, 0)
  assert.equal((await f.catalog.search(query(f.book.bookId, { status: 'trashed' }), signal())).items[0].chapterId, f.materialId)
  const proposals = await ProposalStore.at(f.root, hash(f.root), f.books)
  await assert.rejects(proposals.create('test', { proposalId: randomUUID(), bookId: f.book.bookId, chapterId: f.chapterId, expectedRevision: trashed.revision, expectedHash: hash('林舟在渡口。'), mode: 'continue', instruction: '继续', materials: '', start: 6, end: 6, materialIds: [f.materialId] }, signal()), /material-unavailable/)
  const restored = await f.books.metadata(metadata(trashed, f.materialId), signal())
  assert.equal(restored.chapters.find(item => item.chapterId === f.materialId).hash, hash('左手受伤，藏着铜钥匙。'))
})

test('thousand material fulltext search pages, external content detection and cancelled reads never mutate the source', async t => {
  const f = await fixture(t), files = await BookFiles.at(f.root), book = parseBook((await files.read(`novels/${f.book.bookId}/project.json`)).text, f.book.bookId)
  book.schemaVersion = 2
  for (let i = 0; i < 1000; i++) {
    const id = randomUUID(), text = `资料正文 ${i} 关键词渡口`;
    book.chapters.push({ chapterId: id, title: '同名', kind: 'world', revision: 1, hash: hash(text) })
    await writeFile(join(f.root, 'novels', book.bookId, 'chapters', `${id}.md`), text)
  }
  await writeFile(join(f.root, 'novels', book.bookId, 'project.json'), json(book))
  const before = await readFile(join(f.root, 'novels', book.bookId, 'project.json'))
  const result = await f.catalog.search(query(book.bookId, { query: '关键词渡口', offset: 100 }), signal())
  assert.equal(result.total, 1000); assert.equal(result.items.length, 100); assert(result.complete)
  await writeFile(join(f.root, 'novels', book.bookId, 'chapters', `${f.materialId}.md`), '外部新增')
  assert((await f.catalog.search(query(book.bookId, { query: '外部新增' }), signal())).externalIds.includes(f.materialId))
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.catalog.search(query(book.bookId, { query: '渡口' }), controller.signal))
  assert.deepEqual(await readFile(join(f.root, 'novels', book.bookId, 'project.json')), before)
})

test('source evidence is exact and survives independent document edits without becoming an established fact', async t => {
  const f = await fixture(t), book = await f.books.upgrade(f.book.bookId, f.book.revision, randomUUID(), signal()), id = randomUUID()
  const request = { operationId: randomUUID(), bookId: book.bookId, expectedRevision: book.revision, chapterId: id, action: 'create', title: '铜钥匙', kind: 'seed', content: '林舟', expectedHash: '', beforeChapterId: '', linkedChapterIds: [f.chapterId], sourceEvidence: { chapterId: f.chapterId, revision: 1, hash: hash('林舟在渡口。'), start: 0, end: 2, quote: '林舟' } }
  const created = await f.books.mutate(request, signal())
  assert.equal(created.chapters.find(item => item.chapterId === id).sourceEvidence.quote, '林舟')
  await assert.rejects(f.books.mutate({ ...request, operationId: randomUUID(), chapterId: randomUUID(), expectedRevision: created.revision, sourceEvidence: { ...request.sourceEvidence, quote: '错字' } }, signal()), /invalid-evidence/)
  assert.equal(created.chapters.filter(item => item.kind === 'facts').length, 0)
})
