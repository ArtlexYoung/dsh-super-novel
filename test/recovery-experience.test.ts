import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, readFile, writeFile, readdir, rename, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projection from '@deepseek-ai/dsh-session-projection'
import Policy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import SuperNovel from '../lib/index.js'
import { BookStore } from '../lib/host/book-store.js'
import { BackupStore } from '../lib/host/backup-store.js'
import { MilestoneStore } from '../lib/host/milestone-store.js'
import { DraftStore } from '../lib/host/draft-store.js'
import { saveDetails } from '../lib/host/save-details.js'
import { hash, json } from '../lib/domain/books.js'
import { DraftWriter } from '../src/client/draft-writer.ts'
import { DraftBarrier } from '../src/client/draft-barrier.ts'

const signal = () => new AbortController().signal
const reason = code => error => error.code === code
async function fixture(t) {
  await mkdir('.test-output', { recursive: true }); const root = await mkdtemp(resolve('.test-output/recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const books = await BookStore.at(root), chapterId = randomUUID(), workspaceId = hash(root)
  let book = await books.createBook({ operationId: randomUUID(), title: '恢复验收' }, signal())
  book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId, expectedRevision: book.revision, action: 'create', title: '雨夜', content: '林舟归还铜钥匙。', expectedHash: '', beforeChapterId: '' }, signal())
  const query = { workspaceId, bookId: book.bookId, chapterId, branchId: randomUUID(), operationId: randomUUID() }
  return { root, books, book, chapterId, workspaceId, query, backups: await BackupStore.at(root), drafts: await DraftStore.at(root, workspaceId, books) }
}
const checkpoint = f => ({ ...f.query, sequence: 1, baseHash: hash('林舟归还铜钥匙。'), bookRevision: f.book.revision, content: '林舟归还铜钥匙。未保存后半章。' })
const milestone = f => ({ workspaceId: f.workspaceId, bookId: f.book.bookId, backupId: randomUUID(), expectedRevision: f.book.revision, label: '初稿完成' })
async function copy(f) {
  const backup = await f.backups.create(f.book.bookId, randomUUID(), signal()), preview = await f.backups.inspect(f.book.bookId, backup.backupId, signal()), restored = await f.backups.restore(f.book.bookId, backup.backupId, preview.manifestHash, signal())
  return { workspaceId: f.workspaceId, bookId: f.book.bookId, backupId: backup.backupId, manifestHash: preview.manifestHash, root: restored.root }
}

test('save details do not write, confirm only this branch and input, and scope backups to the current book', async t => {
  const f = await fixture(t), before = await readdir(f.root), empty = await saveDetails(f.root, f.books, f.query, signal())
  assert.equal(empty.formal.state, 'saved'); assert.equal(empty.draft.state, 'not-recorded'); assert.equal(empty.backup.state, 'none'); assert.deepEqual(await readdir(f.root), before)
  await f.drafts.put(checkpoint(f), signal())
  assert.equal((await saveDetails(f.root, f.books, f.query, signal())).draft.state, 'confirmed')
  for (const extra of [{ operationId: randomUUID() }, { branchId: randomUUID() }]) assert.equal((await saveDetails(f.root, f.books, { ...f.query, ...extra }, signal())).draft.state, 'not-recorded')
  const other = await f.books.createBook({ operationId: randomUUID(), title: f.book.title }, signal()); await f.backups.create(other.bookId, randomUUID(), signal())
  assert.equal((await saveDetails(f.root, f.books, f.query, signal())).backup.state, 'none')
  const backup = await f.backups.create(f.book.bookId, randomUUID(), signal()), details = await saveDetails(f.root, f.books, f.query, signal())
  assert.equal(details.backup.state, 'verified'); assert.equal(details.backup.summary.backupId, backup.backupId)
  await writeFile(join(f.root, 'novels', f.book.bookId, 'chapters', `${f.chapterId}.md`), '外部新稿')
  assert.equal((await saveDetails(f.root, f.books, f.query, signal())).formal.state, 'external')
  const controller = new AbortController(); controller.abort(); await assert.rejects(saveDetails(f.root, f.books, f.query, controller.signal), /abort/i)
  await assert.rejects(saveDetails(f.root, f.books, { ...f.query, workspaceId: hash('other') }, signal()), reason('location-changed'))
})

test('damaged, incomplete and offline backup layers remain visible while formal text remains readable', async t => {
  const f = await fixture(t), backup = await f.backups.create(f.book.bookId, randomUUID(), signal())
  await writeFile(backup.path, 'damaged')
  const damaged = await saveDetails(f.root, f.books, f.query, signal()); assert.equal(damaged.backup.state, 'unavailable'); assert.equal(damaged.formal.state, 'saved')
  const good = await f.backups.create(f.book.bookId, randomUUID(), signal()), folder = join(f.root, '.super-novel-backups', f.book.bookId)
  await rm(join(folder, `${good.backupId}.summary.json`))
  assert.equal((await saveDetails(f.root, f.books, f.query, signal())).backup.reason, 'backup-list-incomplete')
  await f.backups.create(f.book.bookId, good.backupId, signal()); assert((await f.backups.list(f.book.bookId)).some(item => item.backupId === good.backupId), 'archive publication interrupted before sidecar can retry')
  const external = join(f.root, 'external'); await mkdir(external); await f.backups.configure(external, false, 'danger-full-access'); await rename(external, join(f.root, 'offline'))
  const offline = await saveDetails(f.root, f.books, f.query, signal()); assert.equal(offline.backup.state, 'unavailable'); assert.equal(offline.formal.state, 'saved')
})

for (const stage of ['prepared', 'archived', 'completed']) test(`milestone interrupted at ${stage} replays one complete archive with its original name`, async t => {
  const f = await fixture(t), request = milestone(f), broken = await MilestoneStore.at(f.root, f.books, { afterStage: async point => { if (point === stage) throw new Error('cut') } })
  await f.drafts.put(checkpoint(f), signal())
  await assert.rejects(broken.create(request, signal()), /cut/)
  const store = await MilestoneStore.at(f.root, f.books), first = await store.create(request, signal())
  assert.deepEqual(await store.create(request, signal()), first)
  assert.equal((await store.list(f.book.bookId, signal())).items.length, 1)
  await assert.rejects(store.create({ ...request, label: '其他名称' }, signal()), reason('operation-conflict'))
  const preview = await f.backups.inspect(request.bookId, request.backupId, signal()); assert(preview.files.some(path => path.includes('/drafts/'))); assert.equal(first.manifestHash, preview.manifestHash)
  assert.equal((await readdir(join(f.root, '.super-novel-backups', f.book.bookId))).filter(name => name.endsWith('.tar.gz')).length, 1)
  assert.equal((await f.books.readBook(f.book.bookId)).revision, f.book.revision)
})

test('milestones allow same names with distinct identities, reject conflicts and damage, and never show a prepared request as complete', async t => {
  const f = await fixture(t), store = await MilestoneStore.at(f.root, f.books), request = milestone(f)
  await store.create(request, signal()); await store.create(milestone(f), signal()); assert.equal((await store.list(f.book.bookId, signal())).items.length, 2)
  await assert.rejects(store.create({ ...milestone(f), expectedRevision: 1 }, signal()), reason('revision-conflict'))
  await assert.rejects(store.create({ ...milestone(f), workspaceId: hash('other') }, signal()), reason('location-changed'))
  const folder = join(f.root, '.super-novel-backups', f.book.bookId); await writeFile(join(folder, `${randomUUID()}.milestone.json`), 'damaged')
  const listing = await store.list(f.book.bookId, signal()); assert.equal(listing.unreadable, 1); assert(!listing.complete)
  await writeFile(join(folder, `${request.backupId}.tar.gz`), 'damaged'); await assert.rejects(store.create(request, signal()))
})

test('verified restored previews preserve originals, reject modified or extra files and arbitrary or linked roots', async t => {
  const f = await fixture(t), original = await readFile(join(f.root, 'novels', f.book.bookId, 'project.json')), request = await copy(f)
  const preview = await f.backups.previewRestored(request, signal()); assert(preview.ready); assert.equal(preview.chapterCount, 1); assert.equal(preview.documents[0].excerpt, '林舟归还铜钥匙。')
  await assert.rejects(f.backups.previewRestored({ ...request, root: f.root }, signal()), reason('unsafe-path'))
  await assert.rejects(f.backups.previewRestored({ ...request, manifestHash: hash('other') }, signal()), reason('invalid-backup'))
  const name = join(request.root, 'novels', request.bookId, 'chapters', `${f.chapterId}.md`)
  await writeFile(name, 'changed'); await assert.rejects(f.backups.previewRestored(request, signal()), reason('restored-copy-changed')); await writeFile(name, '林舟归还铜钥匙。')
  const extra = join(request.root, 'novels', request.bookId, 'unexpected.json'); await writeFile(extra, '{}'); await assert.rejects(f.backups.previewRestored(request, signal()), reason('restored-copy-changed')); await rm(extra)
  const linked = join(f.root, '.super-novel/restored', randomUUID()); await symlink(request.root, linked); await assert.rejects(f.backups.previewRestored({ ...request, root: linked }, signal()), reason('unsafe-path'))
  assert.deepEqual(await readFile(join(f.root, 'novels', f.book.bookId, 'project.json')), original)
  assert((await f.backups.previewRestored(request, signal())).ready)
})

test('a backup with an interrupted save can be previewed but is not ready for direct switching', async t => {
  const f = await fixture(t), broken = await BookStore.at(f.root, { afterStage: async stage => { if (stage === 'prepared') throw new Error('cut') } })
  await assert.rejects(broken.mutate({ operationId: randomUUID(), bookId: f.book.bookId, expectedRevision: f.book.revision, chapterId: f.chapterId, action: 'save', title: '', content: '后稿', expectedHash: hash('林舟归还铜钥匙。'), beforeChapterId: '' }, signal()), /cut/)
  const request = await copy(f); assert.equal((await f.backups.previewRestored(request, signal())).ready, false)
  await assert.rejects((await MilestoneStore.at(f.root, f.books)).create(milestone(f), signal()), reason('recovery-required'))
})

test('form barrier blocks switching on failure and includes departed and subsequently edited writers', async () => {
  const barrier = new DraftBarrier(); let fail = true, calls = 0
  const identity = { workspaceId: hash('barrier'), bookId: randomUUID(), chapterId: randomUUID(), branchId: randomUUID() }
  const writer = new DraftWriter(identity, { cache: async () => true, forget: async () => true, changed: () => {}, checkpoint: async request => { calls++; if (fail) throw new Error('offline'); return { ...request, savedAt: Date.now(), contentHash: hash(request.content) } } })
  const input = { content: '表单输入', baseHash: hash(''), bookRevision: 1, operationId: randomUUID() }
  writer.update(input); barrier.register(writer); let switched = false
  await assert.rejects((async () => { await barrier.flush(); switched = true })(), /offline/); assert.equal(switched, false)
  fail = false; assert.equal((await barrier.flush()).flushed, 1); assert.equal(writer.state.kind, 'disk')
  writer.update({ ...input, content: '后来输入', operationId: randomUUID() }); barrier.register(writer); await barrier.flush(); assert.equal(calls, 3)
})

test('Host recovery enforces read-only, rechecks a changed preview and selects the verified copy without changing original data', async t => {
  const f = await fixture(t), request = await copy(f), ctx = new Context()
  ctx.provide('sessionPersistence', { stat: async () => undefined }); ctx.provide('agentPresets', { roots: [], list: async () => [] })
  ctx.plugin(Sessions); ctx.plugin(Projection); ctx.plugin(Policy, { mode: 'read-only' }); ctx.plugin(LocalFs); ctx.plugin(SuperNovel); t.after(() => ctx.fiber.dispose())
  await new Promise(resolve => ctx.inject(['sessions', 'sessionProjections', 'sandboxPolicy', 'fs', 'superNovel'], () => resolve(true)))
  const sessionId = SessionId('recovery-host'), session = ctx.sessions.create(sessionId, { meta: { cwd: f.root } }), api = ctx.superNovel, remoteReason = code => error => error.details.reason === code
  assert((await api.previewRestoredCopy(sessionId, request, signal())).ready)
  await assert.rejects(api.switchToRestoredCopy(sessionId, request, signal()), remoteReason('read-only')); await assert.rejects(api.createMilestone(sessionId, milestone(f), signal()), remoteReason('read-only'))
  setSandboxMode(session, 'workspace-write'); const name = join(request.root, 'novels', request.bookId, 'chapters', `${f.chapterId}.md`)
  await writeFile(name, 'changed'); await assert.rejects(api.switchToRestoredCopy(sessionId, request, signal()), remoteReason('restored-copy-changed'))
  assert.equal((await api.storageLocation(sessionId, signal())).workspaceId, f.workspaceId); await writeFile(name, '林舟归还铜钥匙。')
  const switched = await api.switchToRestoredCopy(sessionId, request, signal()); assert.equal(switched.root, request.root); assert.notEqual(switched.workspaceId, f.workspaceId)
  await assert.rejects(api.createMilestone(sessionId, milestone(f), signal()), remoteReason('location-changed'))
  assert.equal((await f.books.readChapter(f.book.bookId, f.chapterId)).content, '林舟归还铜钥匙。')
})

test('a newer form input while awaiting a receipt blocks switching until the new input is confirmed', async () => {
  const barrier = new DraftBarrier(); let release, entered
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  const writer = new DraftWriter({ workspaceId: hash('race'), bookId: randomUUID(), chapterId: randomUUID(), branchId: randomUUID() }, {
    cache: async () => true, forget: async () => true, changed: () => {}, checkpoint: async request => { if (request.sequence === 1) { entered(); await gate }; return { ...request, contentHash: hash(request.content), savedAt: Date.now() } },
  })
  const input = { content: '原输入', baseHash: hash(''), bookRevision: 1, operationId: randomUUID() }
  writer.update(input); barrier.register(writer)
  const switching = barrier.flush(); await started
  writer.update({ ...input, content: '等待期间的新输入', operationId: randomUUID() }); barrier.register(writer); release()
  await assert.rejects(switching, error => error.reason === 'draft-changed')
  assert.equal(writer.latest.content, '等待期间的新输入'); assert(!writer.confirmed.has(writer.latest.sequence))
  await barrier.flush(); assert(writer.confirmed.has(writer.latest.sequence))
})
