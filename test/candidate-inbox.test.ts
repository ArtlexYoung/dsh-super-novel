import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BookStore } from '../lib/host/book-store.js'
import { ProposalStore } from '../lib/host/proposal-store.js'
import { FactStore } from '../lib/host/fact-store.js'
import { IntentStore } from '../lib/host/intent-store.js'
import { StoryStore } from '../lib/host/story-store.js'
import { CandidateInboxStore, INBOX_LIMITS } from '../lib/host/candidate-inbox.js'
import { BackupStore } from '../lib/host/backup-store.js'
import { emptyIntent } from '../lib/domain/intents.js'
import { hash, json } from '../lib/domain/books.js'
const signal = () => new AbortController().signal
const reason = code => error => error.code === code
const response = value => ({ replacement: json(value), complete: true, reason: '', usage: { state: 'unknown' } })

async function fixture(t) {
  await mkdir('.test-output', { recursive: true })
  const root = await mkdtemp(resolve('.test-output/inbox-')); t.after(() => rm(root, { recursive: true, force: true }))
  const books = await BookStore.at(root), chapterId = randomUUID(), materialId = randomUUID(), text = '林舟交还钥匙。船头刻着白花。'
  let book = await books.createBook({ title: '待确认作品', operationId: randomUUID() }, signal())
  book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId, expectedRevision: book.revision, action: 'create', title: '渡口', content: text, beforeChapterId: '', expectedHash: '' }, signal())
  book = await books.upgrade(book.bookId, book.revision, randomUUID(), signal())
  const evidence = { chapterId, revision: 1, hash: hash(text), start: 0, end: 7, quote: text.slice(0, 7) }
  book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId: materialId, kind: 'seed', expectedRevision: book.revision, action: 'create', title: '钥匙线索', content: '作者的灵感保留。', beforeChapterId: '', expectedHash: '', sourceEvidence: evidence }, signal())
  const workspaceId = hash(root), proposals = await ProposalStore.at(root, workspaceId, books), facts = await FactStore.at(root, workspaceId, books)
  const intents = await IntentStore.at(root, workspaceId, books), stories = await StoryStore.at(root, workspaceId, books), inbox = await CandidateInboxStore.at(root, workspaceId, books)
  const source = { workspaceId, bookId: book.bookId, chapterId, expectedRevision: book.revision, expectedHash: hash(text) }
  const generation = { ...source, proposalId: randomUUID(), mode: 'draft', instruction: '保留动机，起草下一步。', materials: '', start: 0, end: text.length }
  await proposals.create('inbox-fixture', generation, signal()); await proposals.checkpoint(book.bookId, generation.proposalId, '可编辑正文候选。', 'review', '', { state: 'unknown' }, 1)
  const fact = await facts.propose({ proposalId: randomUUID(), bookId: book.bookId, sourceChapterId: chapterId, expectedRevision: book.revision, expectedHash: hash(text), coverage: 'selection', facts: [{ subject: '林舟', predicate: '行动', value: '交还钥匙', scope: { kind: 'reader' }, sourceChapterId: chapterId, ...{ quote: evidence.quote, start: evidence.start, end: evidence.end } }] }, signal())
  let calls = 0
  const directionRequest = { ...source, proposalId: randomUUID(), expectedVersion: 0, instruction: '给出一条方向。' }
  const direction = await intents.suggest(directionRequest, async () => { calls++; return response({ directions: [{ ...emptyIntent(), goal: '追查钥匙' }] }) }, signal())
  const storyRequest = { ...source, proposalId: randomUUID() }
  const story = await stories.suggest(storyRequest, async () => { calls++; return response({ events: [{ title: '交还钥匙', evidence: { start: 0, end: 7, quote: evidence.quote }, changes: [] }], foreshadows: [{ title: '白花标志', note: '需要作者核对', evidence: { start: 7, end: text.length, quote: text.slice(7) } }] }) }, signal())
  const query = { workspaceId, bookId: book.bookId, kind: 'all', cursor: '' }
  return { root, books, book, chapterId, materialId, text, source, generation, proposals, facts, intents, stories, inbox, direction, directionRequest, story, storyRequest, fact, query, calls: () => calls }
}

test('inbox reads canonical candidates, identifies stale sources, is pure and refuses another library', async t => {
  const f = await fixture(t), folder = join(f.root, 'novels', f.book.bookId), before = await readdir(folder)
  let result = await f.inbox.query(f.query, signal())
  assert.deepEqual(new Set(result.items.map(item => item.kind)), new Set(['writing', 'facts', 'intent', 'story']))
  assert(result.complete); assert.equal(result.unreadable, 0); assert.equal(result.nextCursor, '')
  assert.equal(f.calls(), 2); assert.deepEqual(await readdir(folder), before)
  await assert.rejects(f.inbox.query({ ...f.query, workspaceId: hash('other') }, signal()), reason('location-changed'))
  const foreign = await f.books.createBook({ title: '同名也不能串书', operationId: randomUUID() }, signal())
  assert.equal((await f.inbox.query({ ...f.query, bookId: foreign.bookId }, signal())).items.length, 0)
  await writeFile(join(folder, 'chapters', `${f.chapterId}.md`), '外部改稿。')
  result = await f.inbox.query(f.query, signal())
  assert.equal(result.items.length, 5); assert(result.items.every(item => item.state === 'expired'))
  const source = result.items.find(item => item.kind === 'source')
  assert.equal(source.chapterId, f.materialId); assert.equal(source.preview, f.text.slice(0, 7))
  assert.equal(await readFile(join(folder, 'chapters', `${f.materialId}.md`), 'utf8'), '作者的灵感保留。')
  assert.equal(f.calls(), 2)
})

test('rejected intent and story suggestions persist, replay without calls and block old bound forms', async t => {
  const f = await fixture(t)
  await assert.rejects(f.intents.dismiss(f.book.bookId, f.direction.proposalId, hash('wrong'), signal()), reason('operation-conflict'))
  const a = await f.intents.dismiss(f.book.bookId, f.direction.proposalId, f.direction.candidateHash, signal())
  const b = await f.stories.dismiss(f.book.bookId, f.story.proposalId, f.story.candidateHash, signal())
  assert.equal(a.state, 'rejected'); assert.equal(b.state, 'rejected')
  assert.equal((await f.intents.dismiss(f.book.bookId, a.proposalId, a.candidateHash, signal())).state, 'rejected')
  assert.equal((await (await StoryStore.at(f.root, hash(f.root), f.books)).suggestions(f.book.bookId, f.chapterId))[0].state, 'rejected')
  const never = async () => { throw new Error('must not dispatch') }
  assert.equal((await f.intents.suggest(f.directionRequest, never, signal())).state, 'rejected')
  assert.equal((await f.stories.suggest(f.storyRequest, never, signal())).state, 'rejected')
  await assert.rejects(f.intents.save({ ...f.source, expectedVersion: 0, operationId: randomUUID(), intent: { ...emptyIntent(), goal: '编辑后的方向' }, sourceProposalId: a.proposalId }, signal()), reason('proposal-stale'))
  await assert.rejects(f.stories.save({ workspaceId: hash(f.root), bookId: f.book.bookId, expectedVersion: 0, expectedRevision: f.book.revision, operationId: randomUUID(), event: f.story.events[0], sourceProposalId: b.proposalId }, signal()), reason('proposal-stale'))
  assert.deepEqual(new Set((await f.inbox.query(f.query, signal())).items.map(item => item.kind)), new Set(['writing', 'facts']))
  assert.equal((await f.books.readChapter(f.book.bookId, f.chapterId)).content, f.text)
  const backups = await BackupStore.at(f.root), backup = await backups.create(f.book.bookId, randomUUID(), signal())
  const preview = await backups.inspect(f.book.bookId, backup.backupId, signal())
  assert(preview.files.some(name => name.includes(`/intent-proposals/${a.proposalId}.json`)))
  assert(preview.files.some(name => name.includes(`/story-proposals/${b.proposalId}.json`)))
})

test('edited intent confirmation is recorded atomically and stays finalized after later intent or source changes', async t => {
  const f = await fixture(t), input = { ...f.source, expectedVersion: 0, operationId: randomUUID(), sourceProposalId: f.direction.proposalId, intent: { ...emptyIntent(), goal: '作者改成寻找证人' } }
  assert.deepEqual(await f.intents.save(input, signal()), await f.intents.save(input, signal()))
  assert.equal((await f.intents.suggestion(f.book.bookId, f.direction.proposalId)).state, 'accepted')
  await f.intents.save({ ...f.source, expectedVersion: 1, operationId: randomUUID(), intent: { ...emptyIntent(), goal: '再改计划' } }, signal())
  await writeFile(join(f.root, 'novels', f.book.bookId, 'chapters', `${f.chapterId}.md`), '新的正式来源。')
  assert.equal((await f.intents.list(f.book.bookId, f.chapterId))[0].state, 'accepted')
  assert(!(await f.inbox.query(f.query, signal())).items.some(item => item.kind === 'intent'))
  await assert.rejects(f.intents.dismiss(f.book.bookId, f.direction.proposalId, f.direction.candidateHash, signal()), reason('proposal-finalized'))
})

test('partial story confirmation remains pending, rejection retains confirmed records and full confirmation finalizes', async t => {
  const f = await fixture(t), save = (version, record) => f.stories.save({ workspaceId: hash(f.root), bookId: f.book.bookId, expectedRevision: f.book.revision, expectedVersion: version, operationId: randomUUID(), sourceProposalId: f.story.proposalId, ...record }, signal())
  await save(0, { event: { ...f.story.events[0], title: '作者改过的事件' } })
  assert.equal((await f.stories.suggestion(f.book.bookId, f.story.proposalId)).state, 'review')
  assert((await f.inbox.query(f.query, signal())).items.some(item => item.kind === 'story'))
  await save(1, { foreshadow: f.story.foreshadows[0] })
  assert.equal((await f.stories.suggestion(f.book.bookId, f.story.proposalId)).state, 'accepted')
  assert(!(await f.inbox.query(f.query, signal())).items.some(item => item.kind === 'story'))
  await assert.rejects(f.stories.dismiss(f.book.bookId, f.story.proposalId, f.story.candidateHash, signal()), reason('proposal-finalized'))
  const newSuggestion = await f.stories.suggest({ ...f.storyRequest, proposalId: randomUUID() }, async () => response({ events: [{ title: '新建议', evidence: { start: 0, end: 7, quote: f.text.slice(0, 7) }, changes: [] }], foreshadows: [] }), signal())
  await f.stories.dismiss(f.book.bookId, newSuggestion.proposalId, newSuggestion.candidateHash, signal())
  const state = await f.stories.read(f.book.bookId)
  assert.equal(state.events.length, 1); assert.equal(state.events[0].title, '作者改过的事件'); assert.equal(state.foreshadows.length, 1)
})

test('inbox pagination, damaged records and cancellation preserve readable candidates', async t => {
  const f = await fixture(t), folder = join(f.root, 'novels', f.book.bookId, 'proposals'), original = JSON.parse(await readFile(join(folder, `${f.generation.proposalId}.json`), 'utf8'))
  for (let at = 0; at < 30; at++) {
    const proposalId = randomUUID(), request = { ...original.request, proposalId }, copy = { ...original, request, requestHash: hash(json(request)), acceptanceId: randomUUID() }
    await writeFile(join(folder, `${proposalId}.json`), json(copy))
  }
  const query = { ...f.query, kind: 'writing' }, first = await f.inbox.query(query, signal()), second = await f.inbox.query({ ...query, cursor: first.nextCursor }, signal())
  assert.equal(first.items.length, INBOX_LIMITS.page); assert.equal(second.items.length, 6); assert.equal(second.nextCursor, '')
  assert.equal(new Set([...first.items, ...second.items].map(item => item.key)).size, 31)
  await writeFile(join(folder, `${randomUUID()}.json`), '{bad-json')
  const damaged = await f.inbox.query({ ...f.query, kind: 'all' }, signal())
  // Scan all pages because the malformed UUID can sort after the first page.
  const remaining = damaged.nextCursor ? await f.inbox.query({ ...f.query, cursor: damaged.nextCursor }, signal()) : { unreadable: 0 }
  assert(damaged.unreadable + remaining.unreadable > 0)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(f.inbox.query(f.query, aborted.signal), /abort/i)
  await assert.rejects(f.proposals.preview({ ...f.generation, workspaceId: hash('foreign') }, signal()), reason('location-changed'))
  await f.facts.decide(f.book.bookId, f.fact.proposalId, f.fact.factsHash, false, signal())
  await writeFile(join(f.root, 'novels', f.book.bookId, 'chapters', `${f.chapterId}.md`), '来源已经变化。')
  assert.equal((await f.facts.proposal(f.book.bookId, f.fact.proposalId)).finalized, true)
  assert.equal((await f.inbox.query({ ...f.query, kind: 'facts' }, signal())).items.length, 0)
})

test('scan and file budgets expose incompleteness and allow continuing without accepting unreadable data', async t => {
  const f = await fixture(t), folder = join(f.root, 'novels', f.book.bookId, 'proposals'), original = JSON.parse(await readFile(join(folder, `${f.generation.proposalId}.json`), 'utf8'))
  const names = []
  for (let at = 0; at <= INBOX_LIMITS.scans; at++) {
    const proposalId = randomUUID(), request = { ...original.request, proposalId }, path = join(folder, `${proposalId}.json`)
    await writeFile(path, json({ ...original, request, requestHash: hash(json(request)), acceptanceId: randomUUID(), state: 'rejected' })); names.push(path)
  }
  const query = { ...f.query, kind: 'writing' }, first = await f.inbox.query(query, signal())
  assert.equal(first.scanned, INBOX_LIMITS.scans); assert(!first.complete); assert(first.nextCursor)
  const second = await f.inbox.query({ ...query, cursor: first.nextCursor }, signal())
  assert.equal(second.nextCursor, ''); assert.equal(first.items.length + second.items.length, 1)
  await writeFile(names[0], 'x'.repeat(16 * 1024 * 1024 + 1))
  let unreadable = 0, cursor = ''
  do { const page = await f.inbox.query({ ...query, cursor }, signal()); unreadable += page.unreadable; cursor = page.nextCursor } while (cursor)
  assert.equal(unreadable, 1)
})
