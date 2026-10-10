import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, truncate } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BookStore } from '../lib/host/book-store.js'
import { BookSearch } from '../lib/host/book-search.js'
import { hash, json } from '../lib/domain/books.js'

const signal = () => new AbortController().signal
async function fixture(t) {
  await mkdir('.test-output', { recursive: true })
  const root = await mkdtemp(resolve('.test-output/search-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const books = await BookStore.at(root), bookId = randomUUID(), chapterId = randomUUID(), materialId = randomUUID()
  await books.createBook({ operationId: bookId, title: '搜索验收' }, signal())
  await books.mutate({ operationId: randomUUID(), bookId, chapterId, action: 'create', expectedRevision: 1, title: '同名', content: 'İstanbul。🌙林舟把[A].(key)交给她。', expectedHash: '', beforeChapterId: '' }, signal())
  let book = await books.mutate({ operationId: randomUUID(), bookId, chapterId: materialId, action: 'create', expectedRevision: 2, title: '同名', kind: 'character', content: '铜钥匙属于林舟。', expectedHash: '', beforeChapterId: '' }, signal())
  book = await books.upgrade(bookId, book.revision, randomUUID(), signal())
  book = await books.metadata({ workspaceId: hash(root), bookId, chapterId: materialId, operationId: randomUUID(), expectedRevision: book.revision,
    tags: ['渡口'], aliases: ['阿舟'], favorite: false, status: 'active', linkedChapterIds: [chapterId], relatedMaterialIds: [] }, signal())
  return { root, books, book, chapterId, materialId, search: await BookSearch.at(root, books) }
}
const query = (f, extra = {}) => ({ workspaceId: hash(f.root), bookId: f.book.bookId, query: '林舟', kind: 'all', includeArchived: false, offset: 0, ...extra })

test('Chinese text, metadata terms, literal punctuation and UTF-16 offsets share one search without writes', async t => {
  const f = await fixture(t), base = join(f.root, 'novels', f.book.bookId), before = await readFile(join(base, 'project.json'))
  const names = (await readdir(base, { recursive: true })).sort()
  const result = await f.search.search(query(f), signal())
  assert.equal(result.total, 2); assert.equal(result.items[0].chapterId, f.chapterId); assert.equal(result.items[1].chapterId, f.materialId)
  assert.equal(result.items[0].start, 'İstanbul。🌙'.length)
  const text = (await f.books.readChapter(f.book.bookId, f.chapterId)).content
  assert.equal(text.slice(result.items[0].start, result.items[0].end), result.items[0].quote)
  assert.equal((await f.search.search(query(f, { query: '[A].(key)' }), signal())).total, 1)
  assert.equal((await f.search.search(query(f, { query: '阿舟 铜钥匙 渡口' }), signal())).items[0].chapterId, f.materialId)
  assert.equal((await f.search.search(query(f, { query: '不存在' }), signal())).total, 0)
  assert.equal((await f.search.search(query(f, { query: ' ' }), signal())).scanned, 0)
  assert.deepEqual(await readFile(join(base, 'project.json')), before)
  assert.deepEqual((await readdir(base, { recursive: true })).sort(), names)
})

test('kind filters and archive opt-in never include trashed or internal documents', async t => {
  const f = await fixture(t)
  const metadata = status => ({ workspaceId: hash(f.root), bookId: f.book.bookId, chapterId: f.materialId, operationId: randomUUID(), expectedRevision: f.book.revision,
    tags: [], aliases: [], favorite: false, status, linkedChapterIds: [], relatedMaterialIds: [] })
  assert.equal((await f.search.search(query(f, { kind: 'chapter' }), signal())).total, 1)
  assert.equal((await f.search.search(query(f, { kind: 'materials' }), signal())).total, 1)
  f.book = await f.books.metadata(metadata('archived'), signal())
  assert.equal((await f.search.search(query(f), signal())).total, 1)
  assert.equal((await f.search.search(query(f, { includeArchived: true }), signal())).total, 2)
  f.book = await f.books.metadata(metadata('trashed'), signal())
  assert.equal((await f.search.search(query(f, { includeArchived: true }), signal())).total, 1)
  const source = await f.books.readChapter(f.book.bookId, f.chapterId), start = source.content.indexOf('林舟')
  f.book = await f.books.mutate({ operationId: randomUUID(), bookId: f.book.bookId, chapterId: randomUUID(), action: 'create', kind: 'facts', linkedChapterId: f.chapterId,
    title: '内部事实', content: json({ schemaVersion: 1, sourceChapterId: f.chapterId, sourceRevision: 1, sourceHash: source.hash, facts: [], coverage: 'chapter', summary: { text: '林舟', quote: '林舟', start, end: start + 2 } }), expectedRevision: f.book.revision, expectedHash: '', beforeChapterId: '' }, signal())
  assert.equal((await f.search.search(query(f), signal())).total, 1)
})

test('external edits use the actual source hash; missing, oversized and partial scans are visibly incomplete', async t => {
  const f = await fixture(t), path = join(f.root, 'novels', f.book.bookId, 'chapters', `${f.chapterId}.md`)
  await writeFile(path, '前缀。林舟重新出发。')
  const edited = await f.search.search(query(f), signal()), hit = edited.items.find(item => item.chapterId === f.chapterId)
  assert(hit.externallyModified); assert.equal(hit.hash, hash('前缀。林舟重新出发。')); assert.equal(hit.quote, '林舟')
  const bounded = await BookSearch.at(f.root, f.books, { bytes: 128 * 1024, documents: 1 })
  assert.equal((await bounded.search(query(f), signal())).complete, false)
  const bytes = await BookSearch.at(f.root, f.books, { bytes: 1, documents: 100 })
  assert.equal((await bytes.search(query(f), signal())).complete, false)
  await truncate(path, 4 * 1024 * 1024 + 1)
  const oversized = await f.search.search(query(f), signal())
  assert.equal(oversized.complete, false); assert.equal(oversized.skipped, 1)
  await rm(path)
  const missing = await f.search.search(query(f), signal())
  assert.equal(missing.complete, false); assert.equal(missing.skipped, 1)
})

test('paging stays in the selected book and cancelled/invalid requests fail explicitly', async t => {
  const f = await fixture(t), folder = join(f.root, 'novels', f.book.bookId), book = JSON.parse(await readFile(join(folder, 'project.json'), 'utf8'))
  for (let i = 0; i < 110; i++) {
    const chapterId = randomUUID(), content = `林舟 ${i}`
    book.chapters.push({ chapterId, title: `正文${i}`, revision: 1, hash: hash(content) })
    await writeFile(join(folder, 'chapters', `${chapterId}.md`), content)
  }
  await writeFile(join(folder, 'project.json'), json(book))
  const first = await f.search.search(query(f), signal()), next = await f.search.search(query(f, { offset: 50 }), signal())
  assert.equal(first.total, 112); assert.equal(first.items.length, 50); assert.equal(next.items.length, 50)
  assert(!first.items.some(item => next.items.some(other => item.chapterId === other.chapterId)))
  const other = randomUUID(); await f.books.createBook({ operationId: other, title: '另一书' }, signal())
  assert.equal((await f.search.search(query(f, { bookId: other }), signal())).total, 0)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(f.search.search(query(f), aborted.signal))
  await assert.rejects(f.search.search(query(f, { kind: 'facts' }), signal()))
  await assert.rejects(f.search.search(query(f, { offset: -1 }), signal()))
  await assert.rejects(f.search.search(query(f, { query: '长'.repeat(501) }), signal()))
  await assert.rejects(f.search.search(query(f, { workspaceId: '0'.repeat(64) }), signal()), /location-changed/)
})
