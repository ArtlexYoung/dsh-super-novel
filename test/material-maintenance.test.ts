import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BookStore } from '../lib/host/book-store.js'
import { MaterialCatalog } from '../lib/host/material-catalog.js'
import { DraftStore } from '../lib/host/draft-store.js'
import { BackupStore } from '../lib/host/backup-store.js'
import { hash, json } from '../lib/domain/books.js'
import { parseFormDraft } from '../lib/domain/form-drafts.js'
import { FormDraftCache, materialForm, readFormEnvelope } from '../src/client/form-cache.ts'
import { MaterialViews, defaultMaterialFilters } from '../src/client/material-views.ts'
const signal = () => new AbortController().signal
const query = request => ({ workspaceId: request.workspaceId, bookId: request.bookId, chapterId: request.chapterId })
const version = request => ({ ...query(request), branchId: request.branchId, sequence: request.sequence })
async function fixture(t) {
  await mkdir('.test-output', { recursive: true })
  const root = await mkdtemp(resolve('.test-output/maintenance-')); t.after(() => rm(root, { recursive: true, force: true }))
  const books = await BookStore.at(root), bookId = randomUUID(), chapterId = randomUUID(), ids = [randomUUID(), randomUUID()]
  let book = await books.createBook({ operationId: bookId, title: '资料维护' }, signal())
  for (const [id, kind, content] of [[chapterId, 'chapter', '渡口出现铜钥匙。'], [ids[0], 'character', '人物卡内容'], [ids[1], 'world', '世界资料内容']]) {
    book = await books.mutate({ operationId: randomUUID(), bookId, chapterId: id, kind, title: kind, content, action: 'create', expectedRevision: book.revision, expectedHash: '', beforeChapterId: '' }, signal())
  }
  book = await books.upgrade(bookId, book.revision, randomUUID(), signal())
  const workspaceId = hash(root), base = materialForm(book.chapters.find(item => item.chapterId === ids[0]))
  const request = { workspaceId, bookId, chapterId: ids[0], branchId: randomUUID(), sequence: 1, bookRevision: book.revision, baseHash: hash('人物卡内容'), operationId: randomUUID(),
    content: JSON.stringify({ schemaVersion: 1, kind: 'material', base, form: { ...base, tags: '未确认标签' } }) }
  const batch = { workspaceId, bookId, expectedRevision: book.revision, operationId: randomUUID(), chapterIds: ids, action: 'add-tags', tags: ['线索'], linkedChapterId: '' }
  return { root, books, book, ids, chapterId, workspaceId, request, batch, catalog: await MaterialCatalog.at(root, books) }
}
test('form checkpoints are isolated from manuscripts and kinds; independent branches, lost receipts and sequence conflicts preserve inputs', async t => {
  const f = await fixture(t), forms = await DraftStore.formsAt(f.root, f.workspaceId, f.books, 'material'), prose = await DraftStore.at(f.root, f.workspaceId, f.books)
  const before = await readdir(join(f.root, 'novels', f.book.bookId))
  assert.deepEqual(await forms.list(query(f.request)), { drafts: [], unreadable: 0 })
  assert.deepEqual(await readdir(join(f.root, 'novels', f.book.bookId)), before)
  const interrupted = await DraftStore.formsAt(f.root, f.workspaceId, f.books, 'material', { afterPublication: async () => { throw new Error('lost receipt') } })
  await assert.rejects(interrupted.put(f.request, signal()), /lost receipt/)
  const receipt = await forms.put(f.request, signal()); assert.deepEqual(await forms.put(f.request, signal()), receipt)
  const other = { ...f.request, branchId: randomUUID(), operationId: randomUUID() }; await forms.put(other, signal())
  assert.equal((await forms.list(query(f.request))).drafts.length, 2)
  assert.equal((await prose.list(query(f.request))).drafts.length, 0)
  await assert.rejects(forms.put({ ...f.request, content: f.request.content.replace('未确认标签', '另一标签') }, signal()), /operation-conflict/)
  const later = { ...f.request, sequence: 2, operationId: randomUUID() }; await forms.put(later, signal())
  await assert.rejects(forms.put(f.request, signal()), /draft-sequence-conflict/)
  await assert.rejects(forms.settle({ ...version(f.request), contentHash: receipt.contentHash, action: 'saved' }, signal()), /invalid-format/)
  await forms.settle({ ...version(f.request), contentHash: receipt.contentHash, action: 'dismissed' }, signal())
  assert((await forms.list(query(f.request))).drafts.some(item => item.sequence === 2))
  assert.deepEqual(await f.books.readBook(f.book.bookId), f.book)
  await assert.rejects(forms.put({ ...f.request, workspaceId: '0'.repeat(64) }, signal()), /location-changed/)
  await assert.rejects(forms.put({ ...f.request, chapterId: f.chapterId }, signal()), /invalid-material/)
  await assert.rejects((await DraftStore.formsAt(f.root, f.workspaceId, f.books, 'story')).put(f.request, signal()), /invalid-format/)
})
test('unfinished story fields and full Chinese form budgets are accepted; corrupt, oversized and fabricated evidence are refused', () => {
  const base = materialForm({}), links = Array.from({ length: 1000 }, () => randomUUID())
  const large = { ...base, tags: '标'.repeat(4096), aliases: '别'.repeat(8000), linkedChapterIds: links, relatedMaterialIds: links }
  const content = JSON.stringify({ schemaVersion: 1, kind: 'material', base: large, form: large })
  assert(parseFormDraft(content, 'material')); assert.equal(readFormEnvelope(content, 'material').kind, 'found')
  const evidence = { chapterId: randomUUID(), revision: 1, hash: hash('正文'), start: 0, end: 2, quote: '正文' }
  const form = { kind: 'event', eventId: randomUUID(), title: '', time: { kind: 'known', label: '', order: 0 }, evidence, changes: Array.from({ length: 100 }, () => ({ characterId: '', kind: 'location', value: '汉'.repeat(2000) })) }
  const story = JSON.stringify({ schemaVersion: 1, kind: 'story', base: 0, form })
  assert(parseFormDraft(story, 'story')); assert.equal(readFormEnvelope(story, 'story').kind, 'found')
  assert.throws(() => parseFormDraft(story.replace('"quote":"正文"', '"quote":"假"'), 'story'), /invalid-format/)
  assert.throws(() => parseFormDraft(content, 'story'), /invalid-format/)
  assert.throws(() => parseFormDraft(' '.repeat(1024 * 1024 + 1), 'material'), /too-large/)
  assert.equal(readFormEnvelope('{broken', 'material').kind, 'absent')
})
test('form drafts and both branches survive verified backup; damaged latest checkpoint leaves previous input recoverable', async t => {
  const f = await fixture(t), forms = await DraftStore.formsAt(f.root, f.workspaceId, f.books, 'material')
  await forms.put(f.request, signal())
  const later = { ...f.request, sequence: 2, operationId: randomUUID() }; await forms.put(later, signal())
  const backups = await BackupStore.at(f.root), saved = await backups.create(f.book.bookId, randomUUID(), signal()), inspected = await backups.inspect(f.book.bookId, saved.backupId, signal())
  const names = inspected.files.filter(name => name.includes('/form-drafts/')); assert.equal(names.length, 2)
  const restored = await backups.restore(f.book.bookId, saved.backupId, inspected.manifestHash, signal())
  for (const name of names) assert.deepEqual(await readFile(join(restored.root, name)), await readFile(join(f.root, name)))
  await writeFile(join(f.root, 'novels', f.book.bookId, 'form-drafts', 'material', f.request.chapterId, f.request.branchId, '0000000000000002.json'), '{bad')
  const listing = await forms.list(query(f.request)); assert.equal(listing.unreadable, 1); assert.equal(listing.drafts[0].sequence, 1)
})
test('batch preview is read-only, all three actions retain every text byte, and same request safely replays', async t => {
  const f = await fixture(t), folder = join(f.root, 'novels', f.book.bookId), before = await readFile(join(folder, 'project.json'))
  const texts = await Promise.all(f.book.chapters.map(item => readFile(join(folder, 'chapters', `${item.chapterId}.md`))))
  const preview = await f.catalog.previewBatch(f.batch, signal()); assert.equal(preview.items.length, 2); assert(preview.complete)
  assert.deepEqual(await readFile(join(folder, 'project.json')), before)
  let current = await f.books.batchMetadata(f.batch, signal()); assert.deepEqual(await f.books.batchMetadata(f.batch, signal()), current)
  for (const id of f.ids) assert.deepEqual(current.chapters.find(item => item.chapterId === id).tags, ['线索'])
  for (const action of ['link-chapter', 'archive']) {
    current = await f.books.batchMetadata({ ...f.batch, action, expectedRevision: current.revision, operationId: randomUUID(), tags: [], linkedChapterId: action === 'link-chapter' ? f.chapterId : '' }, signal())
  }
  for (const id of f.ids) { const item = current.chapters.find(item => item.chapterId === id); assert.equal(item.status, 'archived'); assert.deepEqual(item.linkedChapterIds, [f.chapterId]) }
  assert.deepEqual(await Promise.all(f.book.chapters.map(item => readFile(join(folder, 'chapters', `${item.chapterId}.md`)))), texts)
})
test('invalid batch members, limit, duplicates, metadata limits and revision conflicts reject the entire manifest', async t => {
  const f = await fixture(t), path = join(f.root, 'novels', f.book.bookId, 'project.json'), before = await readFile(path)
  for (const extra of [{ chapterIds: [f.ids[0], f.chapterId] }, { chapterIds: [] }, { chapterIds: [f.ids[0], f.ids[0]] }, { chapterIds: Array.from({ length: 101 }, () => randomUUID()) },
    { expectedRevision: f.book.revision - 1 }, { action: 'link-chapter', tags: [], linkedChapterId: f.ids[0] }, { tags: Array.from({ length: 31 }, (_, i) => `tag${i}`) }]) {
    await assert.rejects(f.books.batchMetadata({ ...f.batch, ...extra }, signal())); assert.deepEqual(await readFile(path), before)
  }
  const raw = JSON.parse(before); raw.chapters.find(item => item.chapterId === f.ids[1]).tags = Array.from({ length: 30 }, (_, i) => `tag${i}`); await writeFile(path, json(raw))
  const limited = await readFile(path); await assert.rejects(f.books.batchMetadata(f.batch, signal())); assert.deepEqual(await readFile(path), limited)
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.catalog.previewBatch(f.batch, controller.signal))
})
for (const stage of ['prepared', 'manifest', 'completed']) test(`batch interrupted at ${stage} has no partial result and recovers once with the same ID`, async t => {
  const f = await fixture(t), broken = await BookStore.at(f.root, { afterStage: async point => { if (point === stage) throw new Error('power cut') } })
  await assert.rejects(broken.batchMetadata(f.batch, signal()), /power cut/)
  const before = await f.books.readBook(f.book.bookId)
  const tagged = before.chapters.filter(item => f.ids.includes(item.chapterId) && item.tags?.includes('线索')).length
  assert([0, 2].includes(tagged))
  if (before.recoveryRequired) await f.books.recover(f.book.bookId, signal())
  const current = await f.books.batchMetadata(f.batch, signal()); assert.equal(current.revision, f.book.revision + 1)
  assert.deepEqual(await f.books.batchMetadata(f.batch, signal()), current)
  await assert.rejects(f.books.batchMetadata({ ...f.batch, tags: ['其他'] }, signal()), /operation-conflict/)
})
test('maintenance views page 1000 materials, detect external source changes, and report malformed usage as incomplete', async t => {
  const f = await fixture(t), folder = join(f.root, 'novels', f.book.bookId), raw = JSON.parse(await readFile(join(folder, 'project.json'), 'utf8'))
  for (let i = 0; i < 1000; i++) raw.chapters.push({ chapterId: randomUUID(), title: `资料${i}`, kind: 'seed', revision: 1, hash: hash('') })
  const item = raw.chapters.find(item => item.chapterId === f.ids[0])
  item.sourceEvidence = { chapterId: f.chapterId, revision: 1, hash: hash('渡口出现铜钥匙。'), start: 0, end: 2, quote: '渡口' }
  await writeFile(join(folder, 'project.json'), json(raw)); const before = await readFile(join(folder, 'project.json'))
  const search = { bookId: f.book.bookId, query: '', kind: 'all', status: 'available', favorite: false, tag: '', linkedChapterId: '', offset: 100, attention: 'untagged' }
  const result = await f.catalog.search(search, signal()); assert.equal(result.total, 1002); assert.equal(result.items.length, 100)
  assert.equal((await f.catalog.search({ ...search, attention: 'unlinked' }, signal())).total, 1002)
  assert.equal((await f.catalog.search({ ...search, attention: 'stale', offset: 0 }, signal())).total, 0)
  await writeFile(join(folder, 'chapters', `${f.chapterId}.md`), '外部已改来源。')
  assert.equal((await f.catalog.search({ ...search, attention: 'stale', offset: 0 }, signal())).items[0].chapterId, f.ids[0])
  await mkdir(join(folder, 'proposals'), { recursive: true }); await writeFile(join(folder, 'proposals', `${randomUUID()}.json`), '{"context":[null]}')
  assert.equal((await f.catalog.previewBatch(f.batch, signal())).complete, false)
  assert.deepEqual(await readFile(join(folder, 'project.json')), before)
  const hundred = raw.chapters.filter(item => item.kind === 'seed').slice(0, 100).map(item => item.chapterId)
  const updated = await f.books.batchMetadata({ ...f.batch, chapterIds: hundred }, signal())
  assert.equal(updated.chapters.filter(item => hundred.includes(item.chapterId) && item.tags?.includes('线索')).length, 100)
})
function storage() {
  const entries = new Map()
  return { get length() { return entries.size }, key: index => [...entries.keys()][index] ?? null, getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value) }, removeItem: key => { entries.delete(key) } }
}
test('form cache is scoped, retains failed browser writes in memory, and old cleanup cannot delete newer input', async t => {
  const f = await fixture(t), store = storage(), cache = new FormDraftCache('material', query(f.request), () => store)
  await cache.write(f.request); assert.equal(cache.read(f.request.branchId).kind, 'found')
  assert.equal(new FormDraftCache('material', { ...query(f.request), bookId: randomUUID() }, () => store).list().length, 0)
  assert.equal(new FormDraftCache('story', query(f.request), () => store).list().length, 0)
  const newer = { ...f.request, sequence: 2, operationId: randomUUID() }; await cache.write(newer); await cache.forget(f.request)
  assert.equal(cache.read(f.request.branchId).value.operationId, newer.operationId)
  const failed = { ...f.request, branchId: randomUUID() }, broken = new FormDraftCache('material', query(f.request), () => { throw new Error('quota') })
  await assert.rejects(broken.write(failed), /quota/); assert.equal(broken.read(failed.branchId).value.content, failed.content)
  await cache.forget(newer); assert.equal(cache.read(newer.branchId).kind, 'absent')
  store.setItem(`super-novel.form:material:${f.workspaceId}:${f.book.bookId}:${f.ids[0]}:${randomUUID()}`, '{broken')
  assert.equal(cache.list().length, 1, 'only the failed in-memory branch remains')
})
test('saved views preserve separate book identities, ignore damaged values and report storage failure', () => {
  const store = storage(), views = new MaterialViews('workspace:book', () => store), filters = defaultMaterialFilters()
  const value = { id: randomUUID(), name: '本章人物', filters: { ...filters, kind: 'character' } }
  assert.deepEqual(views.write([value]), { saved: true }); assert.deepEqual(views.read(), [value])
  assert.deepEqual(new MaterialViews('workspace:other', () => store).read(), [])
  store.setItem('super-novel.material-views:workspace:book', JSON.stringify({ version: 1, views: [{ ...value, filters: { ...filters, linkedChapterId: '1-'.repeat(18) } }] })); assert.deepEqual(views.read(), [])
  store.setItem('super-novel.material-views:workspace:book', '{broken'); assert.deepEqual(views.read(), [])
  assert.deepEqual(new MaterialViews('failed', () => { throw new Error('quota') }).write([value]), { saved: false })
})
