import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projection from '@deepseek-ai/dsh-session-projection'
import Policy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import SuperNovel from '../lib/index.js'
import { BookStore } from '../lib/host/book-store.js'
import { BookStructureStore } from '../lib/host/book-structure.js'
import { BackupStore } from '../lib/host/backup-store.js'
import { DraftStore } from '../lib/host/draft-store.js'
import { ProposalStore } from '../lib/host/proposal-store.js'
import { StoryStore } from '../lib/host/story-store.js'
import { IntentStore } from '../lib/host/intent-store.js'
import { STRUCTURE_LIMITS } from '../lib/host/structure-impacts.js'
import { emptyChapterStructure, hash, json, parseBook } from '../lib/domain/books.js'
import { structureOf } from '../lib/domain/book-structure.js'
import { emptyIntent } from '../lib/domain/intents.js'
import { groupOutline, moveOutlineChapter, rebindOutline } from '../src/client/outline-plan.ts'
import { FormDraftCache, readFormEnvelope } from '../src/client/form-cache.ts'
import { DraftWriter } from '../src/client/draft-writer.ts'

const signal = () => new AbortController().signal
const reason = code => error => error.code === code
async function fixture(t, version = 3) {
  await mkdir('.test-output', { recursive: true }); const root = await mkdtemp(resolve('.test-output/structure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const books = await BookStore.at(root), workspaceId = hash(root), ids = [randomUUID(), randomUUID(), randomUUID()], materialId = randomUUID(), sceneId = randomUUID()
  let book = await books.createBook({ operationId: randomUUID(), title: '提纲测试' }, signal())
  for (const [at, id] of ids.entries()) {
    book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId: id, expectedRevision: book.revision, action: 'create', title: at === 2 ? '收回钥匙' : '同名章节', content: `林舟交还钥匙。第${at}章。`, expectedHash: '', beforeChapterId: '' }, signal())
    if (!at) book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId: materialId, expectedRevision: book.revision, action: 'create', title: '资料', kind: 'seed', content: '作者灵感', expectedHash: '', beforeChapterId: '' }, signal())
  }
  book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId: sceneId, linkedChapterId: ids[0], expectedRevision: book.revision, action: 'create', title: '渡口场景', kind: 'scene', content: '在渡口交还钥匙。', expectedHash: '', beforeChapterId: '' }, signal())
  if (version > 1) book = await books.upgrade(book.bookId, book.revision, randomUUID(), signal(), version)
  const structure = await BookStructureStore.at(root, workspaceId, books)
  return { root, books, book, ids, materialId, sceneId, workspaceId, structure }
}
const request = (f, extra = {}) => ({ workspaceId: f.workspaceId, bookId: f.book.bookId, operationId: randomUUID(), expectedRevision: f.book.revision, structure: extra.structure ?? structureOf(f.book), ...extra })
async function commit(f, input) {
  const preview = await f.structure.preview(input, signal())
  return await f.structure.update({ ...input, previewHash: preview.previewHash }, signal())
}
const query = (f, extra = {}) => ({ workspaceId: f.workspaceId, bookId: f.book.bookId, offset: 0, query: '', volumeId: 'all', storylineId: 'all', progress: 'all', ...extra })

test('v3 requires explicit activation, stable groups, prose-only metadata and canonical volume order', async t => {
  const f = await fixture(t, 1), raw = parseBook(await readFile(join(f.root, 'novels', f.book.bookId, 'project.json'), 'utf8'), f.book.bookId)
  assert.throws(() => parseBook(json({ ...raw, volumes: [] }), raw.bookId), /invalid-format/)
  await assert.rejects(f.structure.outline(query(f), signal()), reason('structure-migration-required'))
  const bytes = await readFile(join(f.root, 'novels', raw.bookId, 'chapters', `${f.ids[0]}.md`))
  f.book = await f.books.upgrade(raw.bookId, raw.revision, randomUUID(), signal(), 3)
  assert.equal(f.book.schemaVersion, 3); assert(f.book.chapters.filter(item => !item.kind).every(item => item.structure.progress === 'unwritten'))
  assert.deepEqual(await readFile(join(f.root, 'novels', raw.bookId, 'chapters', `${f.ids[0]}.md`)), bytes)
  assert.equal((await f.books.upgrade(raw.bookId, f.book.revision, randomUUID(), signal())).schemaVersion, 3)
  const a = { volumeId: randomUUID(), title: '同名卷' }, b = { volumeId: randomUUID(), title: '同名卷' }, line = { storylineId: randomUUID(), title: '主线' }
  const plan = { ...structureOf(f.book), volumes: [a, b], storylines: [line], chapters: structureOf(f.book).chapters.map((item, at) => ({ ...item, volumeId: at < 2 ? a.volumeId : b.volumeId, storylineIds: [line.storylineId] })) }
  const saved = await commit(f, request(f, { structure: plan }))
  for (const structure of [
    { ...plan, chapters: plan.chapters.slice(1) }, { ...plan, chapters: [plan.chapters[0], plan.chapters[0], plan.chapters[2]] },
    { ...plan, chapters: [plan.chapters[2], plan.chapters[0], plan.chapters[1]] }, { ...plan, volumes: [a, a] },
    { ...plan, chapters: plan.chapters.map(item => ({ ...item, storylineIds: [randomUUID()] })) }, { ...plan, chapters: plan.chapters.map(item => ({ ...item, volumeId: randomUUID() })) },
  ]) await assert.rejects(f.structure.preview(request(f, { expectedRevision: saved.revision, structure }), signal()))
  const malformed = structuredClone(saved); delete malformed.recoveryRequired
  malformed.chapters.find(item => item.chapterId === f.materialId).structure = emptyChapterStructure()
  assert.throws(() => parseBook(json(malformed), saved.bookId), /invalid-format/)
})

for (const version of [1, 2]) for (const stage of ['prepared', 'manifest', 'completed']) test(`v${version} activation interrupted at ${stage} recovers without touching text`, async t => {
  const f = await fixture(t, version), operationId = randomUUID(), broken = await BookStore.at(f.root, { afterStage: async point => { if (point === stage) throw new Error('cut') } })
  await assert.rejects(broken.upgrade(f.book.bookId, f.book.revision, operationId, signal(), 3), /cut/)
  if ((await f.books.readBook(f.book.bookId)).recoveryRequired) await f.books.recover(f.book.bookId, signal())
  assert.equal((await f.books.upgrade(f.book.bookId, f.book.revision, operationId, signal(), 3)).schemaVersion, 3)
  for (const [at, id] of f.ids.entries()) assert.equal((await f.books.readChapter(f.book.bookId, id)).content, `林舟交还钥匙。第${at}章。`)
})

test('structure preview is pure; one transaction preserves document slots, references and bytes, with strict replay and stale rejection', async t => {
  const f = await fixture(t), before = await readFile(join(f.root, 'novels', f.book.bookId, 'project.json')), names = await readdir(join(f.root, 'novels', f.book.bookId))
  const input = request(f, { structure: moveOutlineChapter(structureOf(f.book), f.ids[1], -1) }), preview = await f.structure.preview(input, signal())
  assert.equal(preview.movedChapterIds.length, 2); assert.equal(preview.changes.length, 3)
  assert(preview.impacts.items.some(item => item.id === f.sceneId)); assert(preview.impacts.complete)
  assert.deepEqual(await readFile(join(f.root, 'novels', f.book.bookId, 'project.json')), before); assert.deepEqual(await readdir(join(f.root, 'novels', f.book.bookId)), names)
  const submitted = { ...input, previewHash: preview.previewHash }, saved = await f.structure.update(submitted, signal())
  assert.deepEqual(saved.chapters.map(item => item.chapterId), [f.ids[1], f.materialId, f.ids[0], f.ids[2], f.sceneId])
  assert.equal(saved.chapters.find(item => item.chapterId === f.sceneId).linkedChapterId, f.ids[0])
  for (const [at, id] of f.ids.entries()) assert.equal((await f.books.readChapter(f.book.bookId, id)).content, `林舟交还钥匙。第${at}章。`)
  assert.deepEqual(await f.structure.update(submitted, signal()), saved)
  await assert.rejects(f.structure.update({ ...submitted, previewHash: hash('changed') }, signal()), reason('operation-conflict'))
  await assert.rejects(f.structure.preview({ ...input, operationId: randomUUID() }, signal()), reason('revision-conflict'))
  await assert.rejects(f.books.mutate({ operationId: randomUUID(), bookId: saved.bookId, chapterId: f.ids[0], expectedRevision: saved.revision, action: 'move', beforeChapterId: '', content: '', title: '', expectedHash: '' }, signal()), reason('structure-preview-required'))
  await assert.rejects(f.structure.preview({ ...input, workspaceId: hash('other') }, signal()), reason('location-changed'))
})

for (const stage of ['prepared', 'manifest', 'completed']) test(`structure transaction interrupted at ${stage} has explicit recovery and idempotent replay`, async t => {
  const f = await fixture(t), input = request(f, { structure: moveOutlineChapter(structureOf(f.book), f.ids[2], -1) }), preview = await f.structure.preview(input, signal())
  const broken = await BookStore.at(f.root, { afterStage: async point => { if (point === stage) throw new Error('cut') } }), service = await BookStructureStore.at(f.root, f.workspaceId, broken), submitted = { ...input, previewHash: preview.previewHash }
  await assert.rejects(service.update(submitted, signal()), /cut/)
  const current = await f.books.readBook(f.book.bookId)
  if (current.recoveryRequired) { await assert.rejects(f.structure.preview(input, signal()), reason('recovery-required')); await f.books.recover(f.book.bookId, signal()) }
  const saved = await f.structure.update(submitted, signal())
  assert.deepEqual(structureOf(saved).chapters.map(item => item.chapterId), [f.ids[0], f.ids[2], f.ids[1]])
})

test('last structure change yields a new previewable plan while preserving later prose edits; new identities block undo', async t => {
  const f = await fixture(t), initial = structureOf(f.book), input = request(f, { structure: moveOutlineChapter(initial, f.ids[2], -1) })
  let saved = await commit(f, input)
  saved = await f.books.mutate({ operationId: randomUUID(), bookId: saved.bookId, chapterId: f.ids[0], expectedRevision: saved.revision, action: 'save', beforeChapterId: '', content: '之后保存的新正文。', title: '', expectedHash: hash('林舟交还钥匙。第0章。') }, signal())
  const undo = await f.structure.undo({ workspaceId: f.workspaceId, bookId: saved.bookId }, signal())
  assert(undo.available); assert.deepEqual(undo.structure, initial)
  saved = await commit(f, request(f, { expectedRevision: saved.revision, structure: undo.structure }))
  assert.equal((await f.books.readChapter(saved.bookId, f.ids[0])).content, '之后保存的新正文。')
  saved = await f.books.mutate({ operationId: randomUUID(), bookId: saved.bookId, chapterId: randomUUID(), expectedRevision: saved.revision, action: 'create', beforeChapterId: '', content: '', title: '新章', expectedHash: '' }, signal())
  assert.equal(saved.chapters.at(-1).structure.progress, 'unwritten'); assert.equal((await f.structure.undo({ workspaceId: f.workspaceId, bookId: saved.bookId }, signal())).available, false)
})

test('reordering reports references and changes original preceding-candidate and foreshadow validity without modifying evidence', async t => {
  const f = await fixture(t), proposals = await ProposalStore.at(f.root, f.workspaceId, f.books), stories = await StoryStore.at(f.root, f.workspaceId, f.books)
  const candidate = { workspaceId: f.workspaceId, proposalId: randomUUID(), bookId: f.book.bookId, chapterId: f.ids[1], expectedRevision: f.book.revision, expectedHash: hash('林舟交还钥匙。第1章。'), mode: 'continue', instruction: '继续', materials: '', start: '林舟交还钥匙。第1章。'.length, end: '林舟交还钥匙。第1章。'.length, precedingChapterIds: [f.ids[0]] }
  await proposals.create('structure-test', candidate, signal()); await proposals.checkpoint(f.book.bookId, candidate.proposalId, '新的候选', 'review', '', { state: 'unknown' }, 1)
  const evidence = at => ({ chapterId: f.ids[at], revision: 1, hash: hash(`林舟交还钥匙。第${at}章。`), start: 0, end: 7, quote: '林舟交还钥匙。' })
  const foreshadow = { foreshadowId: randomUUID(), title: '钥匙', note: '', status: 'resolved', planted: evidence(0), resolved: evidence(1) }
  await stories.save({ workspaceId: f.workspaceId, bookId: f.book.bookId, expectedRevision: f.book.revision, operationId: randomUUID(), expectedVersion: 0, foreshadow }, signal())
  const input = request(f, { structure: moveOutlineChapter(structureOf(f.book), f.ids[1], -1) }), preview = await f.structure.preview(input, signal())
  assert(preview.impacts.items.some(item => item.kind === 'proposal')); assert(preview.impacts.items.some(item => item.kind === 'foreshadow'))
  assert.equal((await proposals.view(f.book.bookId, candidate.proposalId, false)).state, 'review')
  await f.structure.update({ ...input, previewHash: preview.previewHash }, signal())
  assert.equal((await proposals.view(f.book.bookId, candidate.proposalId, false)).state, 'expired')
  assert.equal((await stories.read(f.book.bookId)).foreshadows[0].state, 'expired')
  assert.deepEqual((await stories.read(f.book.bookId)).foreshadows[0].planted, foreshadow.planted)
})

test('auxiliary changes expire a structural preview; damage, scan budgets and cancellation are visible and read-only', async t => {
  const f = await fixture(t), proposals = await ProposalStore.at(f.root, f.workspaceId, f.books), input = request(f, { structure: moveOutlineChapter(structureOf(f.book), f.ids[1], -1) }), preview = await f.structure.preview(input, signal())
  const proposalId = randomUUID()
  await proposals.create('structure-test', { proposalId, bookId: f.book.bookId, chapterId: f.ids[0], expectedRevision: f.book.revision, expectedHash: hash('林舟交还钥匙。第0章。'), mode: 'draft', instruction: '写作', materials: '', start: 0, end: '林舟交还钥匙。第0章。'.length }, signal())
  await assert.rejects(f.structure.update({ ...input, previewHash: preview.previewHash }, signal()), reason('structure-preview-stale'))
  const folder = join(f.root, 'novels', f.book.bookId, 'proposals'), original = JSON.parse(await readFile(join(folder, `${proposalId}.json`), 'utf8'))
  await writeFile(join(folder, `${randomUUID()}.json`), 'broken')
  const damaged = await f.structure.preview(input, signal()); assert(!damaged.impacts.complete); assert.equal(damaged.impacts.unreadable, 1); assert(damaged.impacts.items.some(item => item.id === proposalId))
  for (let at = 0; at <= STRUCTURE_LIMITS.scans; at++) {
    const id = randomUUID(), copy = { ...original, request: { ...original.request, proposalId: id }, acceptanceId: randomUUID() }
    copy.requestHash = hash(json(copy.request)); await writeFile(join(folder, `${id}.json`), json(copy))
  }
  const bounded = await f.structure.preview(input, signal()); assert(!bounded.impacts.complete); assert(bounded.impacts.scanned <= STRUCTURE_LIMITS.scans)
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.structure.preview(input, controller.signal), /abort/i)
  assert.equal((await f.books.readBook(f.book.bookId)).revision, f.book.revision)
})

test('outline reuses existing intents and scene links, pages and filters 1000 chapters, tolerates unreadable plans', async t => {
  const f = await fixture(t), intents = await IntentStore.at(f.root, f.workspaceId, f.books)
  await intents.save({ workspaceId: f.workspaceId, bookId: f.book.bookId, chapterId: f.ids[0], expectedRevision: f.book.revision, expectedVersion: 0, expectedHash: hash('林舟交还钥匙。第0章。'), operationId: randomUUID(), intent: { ...emptyIntent(), goal: '交还钥匙', viewpoint: '林舟' } }, signal())
  const initial = await f.structure.outline(query(f), signal()); assert.equal(initial.items[0].goal, '交还钥匙'); assert.deepEqual(initial.items[0].sceneIds, [f.sceneId])
  const path = join(f.root, 'novels', f.book.bookId, 'project.json'), raw = parseBook(await readFile(path, 'utf8'), f.book.bookId), volumeId = randomUUID(), storylineId = randomUUID()
  raw.volumes = [{ volumeId, title: '长卷' }]; raw.storylines = [{ storylineId, title: '线索' }]
  raw.chapters.filter(item => !item.kind).forEach(item => { item.structure.volumeId = volumeId })
  for (let at = 3; at < 1000; at++) {
    const id = randomUUID(); raw.chapters.push({ chapterId: id, title: '同名章节', revision: 1, hash: hash(''), structure: { ...emptyChapterStructure(), volumeId, storylineIds: at % 2 ? [storylineId] : [], summary: `摘要 ${at} 线索`, progress: at % 2 ? 'draft' : 'complete' } })
    await writeFile(join(f.root, 'novels', f.book.bookId, 'chapters', `${id}.md`), '')
  }
  await writeFile(path, json(raw))
  const page = await f.structure.outline(query(f, { offset: 25 }), signal()); assert.equal(page.total, 1000); assert.equal(page.items.length, 25); assert.equal(page.items[0].position, 26)
  const subset = await f.structure.outline(query(f, { storylineId, progress: 'draft', query: '线索' }), signal()); assert.equal(subset.total, 499)
  await writeFile(join(f.root, 'novels', f.book.bookId, 'intents', f.ids[0], '00000001.json'), 'broken')
  const damaged = await f.structure.outline(query(f), signal()); assert(!damaged.complete); assert.equal(damaged.unreadable, 1); assert.equal(damaged.items[0].goal, '')
})

test('structure drafts are disk-backed and isolated from prose; removing groups and rebinding retains input', async t => {
  const f = await fixture(t), draft = await DraftStore.formsAt(f.root, f.workspaceId, f.books, 'structure'), initial = structureOf(f.book)
  const volumeId = randomUUID(), storylineId = randomUUID(), form = groupOutline({ ...initial, volumes: [{ volumeId, title: '' }], storylines: [{ storylineId, title: '线索' }], chapters: initial.chapters.map(item => ({ ...item, volumeId, summary: '未确认摘要', storylineIds: [storylineId] })) })
  const content = json({ schemaVersion: 1, kind: 'structure', base: f.book.revision, form }), input = { workspaceId: f.workspaceId, bookId: f.book.bookId, chapterId: f.book.bookId, branchId: randomUUID(), sequence: 1, baseHash: hash(json(initial)), bookRevision: f.book.revision, content, operationId: randomUUID() }
  await draft.put(input, signal()); assert.equal((await draft.read({ workspaceId: input.workspaceId, bookId: input.bookId, chapterId: input.chapterId, branchId: input.branchId, sequence: 1 })).content, content)
  assert.equal(readFormEnvelope(content, 'structure').kind, 'found'); assert.equal((await (await DraftStore.at(f.root, f.workspaceId, f.books)).list({ workspaceId: f.workspaceId, bookId: f.book.bookId, chapterId: f.ids[0] })).drafts.length, 0)
  await assert.rejects(draft.put({ ...input, chapterId: f.ids[0], sequence: 2 }, signal()), reason('invalid-structure'))
  const next = await f.books.mutate({ operationId: randomUUID(), bookId: f.book.bookId, chapterId: randomUUID(), expectedRevision: f.book.revision, action: 'create', title: '新增', content: '', expectedHash: '', beforeChapterId: '' }, signal())
  const bound = rebindOutline(form, next); assert.equal(bound.chapters.length, 4); assert.equal(bound.chapters[0].summary, '未确认摘要'); assert.equal(bound.chapters.at(-1).volumeId, '')
  const backups = await BackupStore.at(f.root), backup = await backups.create(f.book.bookId, randomUUID(), signal()); assert((await backups.inspect(f.book.bookId, backup.backupId, signal())).files.some(name => name.includes('/form-drafts/structure/')))
})

test('reopening a retired form continues its branch sequence and can checkpoint new input', async t => {
  const f = await fixture(t), store = await DraftStore.formsAt(f.root, f.workspaceId, f.books, 'structure'), branchId = randomUUID()
  const identity = { workspaceId: f.workspaceId, bookId: f.book.bookId, chapterId: f.book.bookId, branchId }, data = new Map()
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } }
  const make = () => {
    const cache = new FormDraftCache('structure', identity, () => storage)
    const writer = new DraftWriter(identity, { cache: request => cache.write(request), forget: request => cache.forget(request), checkpoint: request => store.put(request, signal()), settle: request => store.settle(request, signal()), changed: () => {} })
    writer.sequence = cache.sequence(branchId)
    return { writer, cache }
  }
  const input = { content: json({ schemaVersion: 1, kind: 'structure', base: f.book.revision, form: structureOf(f.book) }), operationId: randomUUID(), baseHash: hash(json(structureOf(f.book))), bookRevision: f.book.revision }
  const first = make(); first.writer.update(input); await first.writer.flush(); await first.writer.settle(input, 'dismissed')
  const reopened = make(); assert.equal(reopened.cache.read(branchId).kind, 'absent'); assert.equal(reopened.writer.sequence, 1)
  const next = { ...input, operationId: randomUUID() }; reopened.writer.update(next); await reopened.writer.flush()
  assert.equal(reopened.writer.state.kind, 'disk'); assert.equal((await store.read({ ...identity, sequence: 2 })).operationId, next.operationId)
})

test('Host activation verifies its backup and enforces read-only and selected-library identities', async t => {
  const f = await fixture(t, 2), ctx = new Context()
  ctx.provide('sessionPersistence', { stat: async () => undefined }); ctx.provide('agentPresets', { roots: [], list: async () => [] })
  ctx.plugin(Sessions); ctx.plugin(Projection); ctx.plugin(Policy, { mode: 'read-only' }); ctx.plugin(LocalFs); ctx.plugin(SuperNovel)
  t.after(() => ctx.fiber.dispose())
  await new Promise(resolve => ctx.inject(['sessions', 'sessionProjections', 'sandboxPolicy', 'fs', 'superNovel'], () => resolve(true)))
  const sessionId = SessionId('structure-session'), session = ctx.sessions.create(sessionId, { meta: { cwd: f.root } }), api = ctx.superNovel
  const input = { workspaceId: f.workspaceId, bookId: f.book.bookId, expectedRevision: f.book.revision, operationId: randomUUID(), backupId: randomUUID() }, remoteReason = code => error => error.details.reason === code
  await assert.rejects(api.enableBookStructure(sessionId, input, signal()), remoteReason('read-only'))
  setSandboxMode(session, 'workspace-write')
  await assert.rejects(api.enableBookStructure(sessionId, { ...input, workspaceId: hash('other') }, signal()), remoteReason('location-changed'))
  const enabled = await api.enableBookStructure(sessionId, input, signal()), backups = await BackupStore.at(f.root), preview = await backups.inspect(input.bookId, input.backupId, signal())
  assert.equal(enabled.schemaVersion, 3); assert.equal(preview.summary.revision, input.expectedRevision); assert(preview.summary.verifiedAt); assert(!preview.summary.recoveryRequired)
  const metadata = { workspaceId: f.workspaceId, bookId: enabled.bookId, expectedRevision: enabled.revision, operationId: randomUUID(), chapterId: f.materialId, tags: ['提纲'], aliases: [], favorite: false, status: 'active', linkedChapterIds: [f.ids[0]], relatedMaterialIds: [] }
  let updated = await api.updateMaterial(sessionId, metadata, signal()); assert.equal(updated.schemaVersion, 3)
  const original = await f.books.readChapter(enabled.bookId, f.ids[0]), newMaterialId = randomUUID()
  updated = await api.selectionMaterial(sessionId, { workspaceId: f.workspaceId, bookId: enabled.bookId, expectedRevision: updated.revision, sourceChapterId: f.ids[0], sourceHash: original.hash, start: 0, end: 2, title: '选区资料', kind: 'seed', operationId: randomUUID(), chapterId: newMaterialId }, signal())
  assert.equal((await f.books.readChapter(enabled.bookId, newMaterialId)).content, '林舟')
  assert.equal(updated.chapters.find(item => item.chapterId === newMaterialId).sourceEvidence.chapterId, f.ids[0])
  const batch = { workspaceId: f.workspaceId, bookId: enabled.bookId, expectedRevision: updated.revision, operationId: randomUUID(), chapterIds: [f.materialId, newMaterialId], action: 'add-tags', tags: ['v3资料'], linkedChapterId: '' }
  const batchPreview = await api.previewMaterialBatch(sessionId, batch, signal()); assert.equal(batchPreview.items.length, 2)
  updated = await api.updateMaterialBatch(sessionId, batch, signal())
  assert(updated.chapters.filter(item => batch.chapterIds.includes(item.chapterId)).every(item => item.tags.includes('v3资料')))
  assert.equal((await f.books.readChapter(enabled.bookId, f.ids[0])).content, original.content)
  const plan = request(f, { expectedRevision: updated.revision, structure: structureOf(updated) }), structural = await api.previewBookStructure(sessionId, plan, signal())
  setSandboxMode(session, 'read-only')
  assert.equal((await api.bookOutline(sessionId, query(f), signal())).total, 3)
  await assert.rejects(api.updateBookStructure(sessionId, { ...plan, previewHash: structural.previewHash }, signal()), remoteReason('read-only'))
  assert.equal((await f.books.readBook(f.book.bookId)).revision, updated.revision)
})
