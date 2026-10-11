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
import Llm, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import SuperNovel from '../lib/index.js'
import { BookStore } from '../lib/host/book-store.js'
import { BookReviewStore, parseBookReviewRecord } from '../lib/host/book-review-store.js'
import { ProposalStore } from '../lib/host/proposal-store.js'
import { BackupStore } from '../lib/host/backup-store.js'
import { IntentStore } from '../lib/host/intent-store.js'
import { FactStore } from '../lib/host/fact-store.js'
import { ReviewStore } from '../lib/host/review-store.js'
import { StoryStore } from '../lib/host/story-store.js'
import { chapterImpacts } from '../lib/host/chapter-impacts.js'
import { structureImpacts } from '../lib/host/structure-impacts.js'
import { BookFiles } from '../lib/host/book-files.js'
import { emptyIntent } from '../lib/domain/intents.js'
import { bookReviewDimensions, bookReviewRequestSchema, bookReviewFingerprint } from '../lib/domain/book-reviews.js'
import { hash, json } from '../lib/domain/books.js'

const signal = () => new AbortController().signal, reason = code => error => error.code === code
const checked = () => bookReviewDimensions.map(dimension => ({ dimension, state: 'checked' }))
const response = output => ({ replacement: json(output), complete: true, reason: '', usage: { state: 'reported', inputTokens: 10, outputTokens: 20 } })
async function fixture(t) {
  await mkdir('.test-output', { recursive: true }); const root = await mkdtemp(resolve('.test-output/book-review-')); t.after(() => rm(root, { recursive: true, force: true }))
  const books = await BookStore.at(root), ids = [randomUUID(), randomUUID(), randomUUID()], texts = ['林舟左腕骨折，不能握住东西。', '开头保留。\n林舟用左手举起沉重的铁箱。\n结尾保留。', '范围外的整章保持原样。']
  let book = await books.createBook({ operationId: randomUUID(), title: '跨章改稿验收' }, signal())
  for (let at = 0; at < ids.length; at++) book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId: ids[at], expectedRevision: book.revision, action: 'create', title: `第${at + 1}章`, content: texts[at], expectedHash: '', beforeChapterId: '' }, signal())
  const workspaceId = hash(root), reviews = await BookReviewStore.at(root, workspaceId, books), proposals = await ProposalStore.at(root, workspaceId, books)
  const scope = { workspaceId, bookId: book.bookId, expectedRevision: book.revision, chapterIds: ids.slice(0, 2), storylineId: '', focus: '核对左腕伤势和动作。' }
  const query = async extra => { const current = { ...scope, ...extra }, preview = await reviews.preview(current, signal()); return { ...current, reviewId: randomUUID(), previewHash: preview.previewHash, maxCalls: 1 } }
  const issue = { dimension: 'causality', severity: 'error', message: '左腕动作与前章伤势矛盾。', suggestion: '改用右手，并让箱子留在地上。', impact: '保持前章伤势，避免凭空恢复。', authorQuestion: '是否有未选中的康复过程？', targetChapterId: ids[1], evidence: [{ chapterId: ids[0], start: 0, end: texts[0].length, quote: texts[0] }, { chapterId: ids[1], start: 6, end: 6 + '林舟用左手举起沉重的铁箱。'.length, quote: '林舟用左手举起沉重的铁箱。' }] }
  const generate = async prompt => { const input = JSON.parse(prompt); assert.equal(input.task, 'review-book-range'); assert(!input.chapters.some(chapter => chapter.chapterId === ids[2])); return response({ dimensions: checked(), issues: [issue], unknowns: [] }) }
  const decide = (view, action = 'confirm') => ({ workspaceId, bookId: book.bookId, reviewId: view.reviewId, issueId: view.issues[0].issueId, resultHash: view.resultHash, operationId: randomUUID(), action })
  return { root, books, book, ids, texts, workspaceId, reviews, proposals, scope, query, issue, generate, decide }
}

test('range preview is read-only, ordered, explicit about missing sources and gaps, and bounded before a model call', async t => {
  const f = await fixture(t), before = await readdir(join(f.root, 'novels', f.book.bookId)), preview = await f.reviews.preview({ ...f.scope, chapterIds: [...f.scope.chapterIds].reverse() }, signal())
  assert.deepEqual(preview.chapters.map(item => item.chapterId), f.ids.slice(0, 2)); assert(preview.ready); assert(preview.contiguous); assert.equal(preview.totalChapters, 3); assert.equal(preview.maxCalls, 1)
  assert(preview.sources.some(source => source.kind === 'facts' && source.state === 'missing')); assert.deepEqual(await readdir(join(f.root, 'novels', f.book.bookId)), before)
  assert(!(await f.reviews.preview({ ...f.scope, chapterIds: [f.ids[0], f.ids[2]] }, signal())).contiguous)
  for (const chapterIds of [[f.ids[0]], [f.ids[0], f.ids[0]], [f.ids[0], randomUUID()]]) await assert.rejects(f.reviews.preview({ ...f.scope, chapterIds }, signal()))
  await assert.rejects(f.reviews.preview({ ...f.scope, workspaceId: hash('another') }, signal()), reason('location-changed'))
  await assert.rejects(f.reviews.preview(f.scope, AbortSignal.abort()), { name: 'AbortError' })
  const large = '大'.repeat(100_000), book = await f.books.mutate({ operationId: randomUUID(), bookId: f.book.bookId, chapterId: f.ids[0], expectedRevision: f.book.revision, action: 'save', title: '', content: large, expectedHash: hash(f.texts[0]), beforeChapterId: '' }, signal())
  const request = await f.query({ expectedRevision: book.revision }), oversized = await f.reviews.preview({ ...f.scope, expectedRevision: book.revision }, signal())
  assert(!oversized.ready); assert(oversized.bytes > oversized.maxBytes)
  await assert.rejects(f.reviews.run(request, () => assert.fail('oversized request called model'), signal()), reason('context-too-large'))
})

test('author intent and accepted facts keep plans and character knowledge separate; their changes expire previews and reviews', async t => {
  const f = await fixture(t), intents = await IntentStore.at(f.root, f.workspaceId, f.books)
  await intents.save({ workspaceId: f.workspaceId, bookId: f.book.bookId, chapterId: f.ids[0], expectedRevision: f.book.revision, expectedHash: hash(f.texts[0]), expectedVersion: 0, operationId: randomUUID(), intent: { ...emptyIntent(), goal: '将来恢复左手', hardConstraints: '现在左腕不能受力。' } }, signal())
  const characterId = randomUUID(); let book = await f.books.mutate({ operationId: randomUUID(), bookId: f.book.bookId, chapterId: characterId, expectedRevision: f.book.revision, action: 'create', title: '林舟', kind: 'character', content: '林舟', expectedHash: '', beforeChapterId: '' }, signal())
  const facts = await FactStore.at(f.root, f.workspaceId, f.books), proposed = await facts.propose({ proposalId: randomUUID(), bookId: book.bookId, sourceChapterId: f.ids[0], expectedRevision: book.revision, expectedHash: hash(f.texts[0]), facts: [{ subject: '林舟', predicate: '伤势', value: '左腕骨折', scope: { kind: 'character', characterId }, sourceChapterId: f.ids[0], quote: f.texts[0], start: 0, end: f.texts[0].length }] }, signal())
  await facts.decide(book.bookId, proposed.proposalId, proposed.factsHash, true, signal()); book = await f.books.readBook(book.bookId)
  const request = await f.query({ expectedRevision: book.revision }), view = await f.reviews.run(request, async prompt => {
    const sources = JSON.parse(prompt).supportingSources, intent = JSON.parse(sources.find(source => source.kind === 'intent' && source.state === 'included').content), accepted = JSON.parse(sources.find(source => source.kind === 'facts' && source.state === 'included').content)
    assert(intent.planOnly); assert.equal(accepted.facts[0].scope.characterId, characterId); assert.equal(accepted.facts[0].scope.kind, 'character'); return f.generate(prompt)
  }, signal())
  assert.equal(view.state, 'issues')
  await intents.save({ workspaceId: f.workspaceId, bookId: book.bookId, chapterId: f.ids[0], expectedRevision: book.revision, expectedHash: hash(f.texts[0]), expectedVersion: 1, operationId: randomUUID(), intent: emptyIntent() }, signal())
  assert.equal((await f.reviews.get(book.bookId, view.reviewId, signal())).state, 'expired')
  await assert.rejects(f.reviews.run({ ...request, reviewId: randomUUID() }, f.generate, signal()), reason('review-stale'))
})

test('one durable request calls once, missing evidence degrades rather than claiming a whole-book pass, and queries preserve all prose', async t => {
  const f = await fixture(t), request = await f.query(); let calls = 0
  const generate = async prompt => { calls++; return f.generate(prompt) }, view = await f.reviews.run(request, generate, signal())
  assert.equal(view.calls, 1); assert.equal(view.state, 'degraded'); assert(view.unknowns.includes('book-review-no-facts')); assert.equal(view.issues[0].decision, 'unconfirmed')
  assert.deepEqual(await f.reviews.run(request, generate, signal()), view); assert.equal(calls, 1)
  await f.reviews.list(f.book.bookId, signal()); await f.reviews.get(f.book.bookId, view.reviewId, signal()); assert.equal(calls, 1)
  await assert.rejects(f.reviews.run({ ...request, focus: '其他要求' }, generate, signal()), reason('operation-conflict'))
  assert(!bookReviewRequestSchema.safeParse({ ...request, maxCalls: 2 }).success)
  for (let at = 0; at < f.ids.length; at++) assert.equal((await f.books.readChapter(f.book.bookId, f.ids[at])).content, f.texts[at])
})

test('an empty accepted fact document does not imply grounded checks', async t => {
  const f = await fixture(t), facts = await FactStore.at(f.root, f.workspaceId, f.books)
  const proposal = await facts.propose({ proposalId: randomUUID(), bookId: f.book.bookId, sourceChapterId: f.ids[0], expectedRevision: f.book.revision, expectedHash: hash(f.texts[0]), facts: [] }, signal())
  await facts.decide(f.book.bookId, proposal.proposalId, proposal.factsHash, true, signal())
  const book = await f.books.readBook(f.book.bookId), view = await f.reviews.run(await f.query({ expectedRevision: book.revision }), f.generate, signal())
  assert.equal(view.state, 'degraded'); assert(view.unknowns.includes('book-review-no-facts'))
})

test('range context excludes outside events and never opens their changed prose', async t => {
  const f = await fixture(t), story = await StoryStore.at(f.root, f.workspaceId, f.books)
  const event = { eventId: randomUUID(), title: '范围外秘密', time: { kind: 'unknown' }, evidence: { chapterId: f.ids[2], revision: 1, hash: hash(f.texts[2]), start: 0, end: f.texts[2].length, quote: f.texts[2] }, changes: [] }
  await story.save({ workspaceId: f.workspaceId, bookId: f.book.bookId, operationId: randomUUID(), expectedVersion: 0, expectedRevision: f.book.revision, event }, signal())
  await writeFile(join(f.root, 'novels', f.book.bookId, 'chapters', `${f.ids[2]}.md`), '范围外已外改，不准作为本次证据。')
  const preview = await f.reviews.preview(f.scope, signal())
  assert(preview.ready); assert(preview.complete); assert(!json(preview.sources).includes('范围外秘密'))
  await f.reviews.run(await f.query(), async prompt => { assert(!prompt.includes('范围外秘密')); assert(!prompt.includes('范围外已外改')); return f.generate(prompt) }, signal())
})

test('a subsequent local review keeps cross-chapter dependencies and the two-round limit', async t => {
  const f = await fixture(t), view = await f.reviews.run(await f.query(), f.generate, signal()); await f.reviews.decide(f.decide(view), signal())
  const first = await f.reviews.revision(f.book.bookId, view.reviewId, view.issues[0].issueId, signal()), { proposal } = await f.proposals.create('test', first.request, signal())
  await f.proposals.checkpoint(f.book.bookId, proposal.request.proposalId, '[TODO]', 'review', '', { state: 'unknown' }, 1)
  const reviews = await ReviewStore.at(f.root, f.workspaceId, f.books), candidate = await f.proposals.view(f.book.bookId, proposal.request.proposalId, false)
  const assess = async value => await reviews.run({ reviewId: randomUUID(), bookId: f.book.bookId, chapterId: f.ids[1], proposalId: value.proposalId, expectedRevision: f.book.revision, expectedHash: value.candidateHash, minCharacters: 0, maxCharacters: 0, minParagraphs: 0, maxParagraphs: 0 }, false, signal())
  const checked = await assess(candidate), next = await reviews.revision(f.book.bookId, checked.reviewId, checked.issues.find(item => item.quote === '[TODO]').issueId)
  assert.equal(next.round, 2); assert.equal(next.request.bookReviewId, view.reviewId); assert.equal(next.request.bookIssueId, view.issues[0].issueId)
  const second = await f.proposals.create('test', next.request, signal()); await f.proposals.checkpoint(f.book.bookId, second.proposal.request.proposalId, '[TODO]', 'review', '', { state: 'unknown' }, 1)
  const last = await assess(await f.proposals.view(f.book.bookId, second.proposal.request.proposalId, false))
  await assert.rejects(reviews.revision(f.book.bookId, last.reviewId, last.issues.find(item => item.quote === '[TODO]').issueId), reason('revision-limit'))
  await f.books.mutate({ operationId: randomUUID(), bookId: f.book.bookId, chapterId: f.ids[0], expectedRevision: f.book.revision, action: 'save', title: '', content: '前章伤势变化。', expectedHash: hash(f.texts[0]), beforeChapterId: '' }, signal())
  assert.equal((await f.proposals.view(f.book.bookId, second.proposal.request.proposalId, false)).state, 'expired')
})

for (const variant of ['fabricated', 'outside', 'single-chapter', 'duplicate-dimension', 'malformed', 'unfinished']) test(`invalid ${variant} output stays unknown and cannot authorize revision`, async t => {
  const f = await fixture(t), request = await f.query(), issue = structuredClone(f.issue), output = { dimensions: checked(), issues: [issue], unknowns: [] }
  if (variant === 'fabricated') issue.evidence[0].quote = '伪造引用'
  if (variant === 'outside') issue.evidence[0].chapterId = f.ids[2]
  if (variant === 'single-chapter') issue.evidence[0] = issue.evidence[1]
  if (variant === 'duplicate-dimension') output.dimensions[0] = output.dimensions[1]
  const generate = async () => variant === 'malformed' ? { ...response(output), replacement: '{bad' } : variant === 'unfinished' ? { ...response(output), complete: false, reason: 'truncated' } : response(output)
  const view = await f.reviews.run(request, generate, signal()); assert.equal(view.state, 'unknown'); assert.equal(view.issues.length, 0)
  assert.equal((await f.reviews.run(request, () => assert.fail('failed result resent'), signal())).state, 'unknown')
})

for (const stage of ['reserved', 'completed']) test(`an interruption at ${stage} replays without another model call`, async t => {
  const f = await fixture(t), request = await f.query(); let calls = 0
  const broken = await BookReviewStore.at(f.root, f.workspaceId, f.books, undefined, { afterStage: async point => { if (point === stage) throw new Error('cut') } })
  await assert.rejects(broken.run(request, async prompt => { calls++; return f.generate(prompt) }, signal()), /cut/)
  const view = await f.reviews.run(request, () => assert.fail('interrupted request resent'), signal())
  assert.equal(calls, stage === 'reserved' ? 0 : 1); assert.equal(view.state, stage === 'reserved' ? 'unknown' : 'degraded')
  assert.equal((await readdir(join(f.root, 'novels', f.book.bookId, 'book-reviews'))).filter(name => name.endsWith('.json')).length, 1)
})

test('cancellation settles an unknown record and another host cannot call the same request concurrently', async t => {
  const f = await fixture(t), request = await f.query(), controller = new AbortController(); let entered
  const started = new Promise(resolve => { entered = resolve }), task = f.reviews.run(request, async (_prompt, _system, signal) => { entered(); await new Promise((_yes, no) => signal.addEventListener('abort', () => no(signal.reason), { once: true })); return response({ dimensions: checked(), issues: [], unknowns: [] }) }, controller.signal)
  await started
  const other = await BookReviewStore.at(f.root, f.workspaceId, f.books)
  const inFlight = await other.run(request, () => assert.fail('second host called'), signal())
  assert.equal(inFlight.state, 'unknown'); assert.equal(inFlight.reason, 'book-review-interrupted')
  controller.abort(); await assert.rejects(task, { name: 'AbortError' })
  const view = await other.run(request, () => assert.fail('cancelled request resent'), signal()); assert.equal(view.state, 'unknown'); assert.equal(view.reason, 'book-review-stopped'); assert.equal(view.calls, 1)
})

test('confirmation is durable and idempotent; local candidate and adoption preserve all text outside its target', async t => {
  const f = await fixture(t), view = await f.reviews.run(await f.query(), f.generate, signal()), decision = f.decide(view)
  await assert.rejects(f.reviews.revision(f.book.bookId, view.reviewId, view.issues[0].issueId, signal()), reason('book-issue-unconfirmed'))
  const confirmed = await f.reviews.decide(decision, signal()); assert.equal(confirmed.issues[0].decision, 'confirmed'); assert.deepEqual(await f.reviews.decide(decision, signal()), confirmed)
  await assert.rejects(f.reviews.decide({ ...decision, action: 'dismiss' }, signal()), reason('book-issue-finalized'))
  const revision = await f.reviews.revision(f.book.bookId, view.reviewId, view.issues[0].issueId, signal())
  await assert.rejects(f.proposals.create('test', { ...revision.request, instruction: '篡改范围', proposalId: randomUUID() }, signal()), reason('invalid-request'))
  const { proposal } = await f.proposals.create('test', revision.request, signal()), replacement = '林舟用右手扶住铁箱，没有将它抬起。'
  await f.proposals.checkpoint(f.book.bookId, proposal.request.proposalId, replacement, 'review', '', { state: 'unknown' }, 1)
  const candidate = await f.proposals.view(f.book.bookId, proposal.request.proposalId, false), target = f.issue.evidence[1]
  assert.equal(candidate.candidate, f.texts[1].slice(0, target.start) + replacement + f.texts[1].slice(target.end))
  await f.proposals.decide({ bookId: f.book.bookId, proposalId: candidate.proposalId, expectedCandidateHash: candidate.candidateHash }, true, signal())
  assert.equal((await f.books.readChapter(f.book.bookId, f.ids[1])).content, candidate.candidate)
  for (const at of [0, 2]) assert.equal((await f.books.readChapter(f.book.bookId, f.ids[at])).content, f.texts[at])
  assert.equal((await f.reviews.get(f.book.bookId, view.reviewId, signal())).state, 'expired')
})

test('waiting for a review never locks author saves or complete backups; changed sources expire the arriving result', async t => {
  const f = await fixture(t), request = await f.query(); let release, entered
  const waiting = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { entered = resolve })
  const task = f.reviews.run(request, async prompt => { entered(); await waiting; return f.generate(prompt) }, signal())
  await started
  try {
    let book = await f.books.mutate({ operationId: randomUUID(), bookId: f.book.bookId, chapterId: f.ids[2], expectedRevision: f.book.revision, action: 'save', title: '', content: '等待审校时仍能保存范围外正文。', expectedHash: hash(f.texts[2]), beforeChapterId: '' }, signal())
    assert.notEqual((await f.reviews.get(book.bookId, request.reviewId, signal())).state, 'expired')
    const backups = await BackupStore.at(f.root), backup = await backups.create(book.bookId, randomUUID(), signal())
    assert((await backups.inspect(book.bookId, backup.backupId, signal())).files.some(name => name.endsWith(`book-reviews/${request.reviewId}.json`)))
    book = await f.books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId: f.ids[0], expectedRevision: book.revision, action: 'save', title: '', content: '左腕已有新的状态。', expectedHash: hash(f.texts[0]), beforeChapterId: '' }, signal())
    assert.equal((await f.books.readChapter(book.bookId, f.ids[0])).content, '左腕已有新的状态。')
  } finally { release() }
  const view = await task; assert.equal(view.state, 'expired'); assert.equal(view.issues.length, 1)
  await assert.rejects(f.reviews.decide(f.decide(view), signal()), reason('review-stale'))
})

test('selected-source changes block confirmation and adoption; unrelated prose changes do not expire the review', async t => {
  const f = await fixture(t), view = await f.reviews.run(await f.query(), f.generate, signal()); await f.reviews.decide(f.decide(view), signal())
  let book = await f.books.mutate({ operationId: randomUUID(), bookId: f.book.bookId, chapterId: f.ids[2], expectedRevision: f.book.revision, action: 'save', title: '', content: '范围外的新稿。', expectedHash: hash(f.texts[2]), beforeChapterId: '' }, signal())
  assert.notEqual((await f.reviews.get(book.bookId, view.reviewId, signal())).state, 'expired')
  const revision = await f.reviews.revision(book.bookId, view.reviewId, view.issues[0].issueId, signal()), { proposal } = await f.proposals.create('test', revision.request, signal())
  await f.proposals.checkpoint(book.bookId, proposal.request.proposalId, '局部新动作。', 'review', '', { state: 'unknown' }, 1)
  book = await f.books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId: f.ids[0], expectedRevision: book.revision, action: 'save', title: '', content: '伤势已有变化。', expectedHash: hash(f.texts[0]), beforeChapterId: '' }, signal())
  const expired = await f.proposals.view(book.bookId, proposal.request.proposalId, false); assert.equal(expired.state, 'expired')
  await assert.rejects(f.proposals.decide({ bookId: book.bookId, proposalId: expired.proposalId, expectedCandidateHash: expired.candidateHash }, true, signal()), reason('proposal-stale'))
  const fresh = await f.reviews.run(await f.query({ expectedRevision: book.revision }), async () => response({ dimensions: checked(), issues: [], unknowns: [] }), signal())
  await writeFile(join(f.root, 'novels', book.bookId, 'chapters', `${f.ids[1]}.md`), '外部新稿。')
  assert.equal((await f.reviews.get(book.bookId, fresh.reviewId, signal())).state, 'expired')
})

test('storyline selection and reorder are source dependencies; reviews and decisions survive complete backup with source identity', async t => {
  const f = await fixture(t); let book = await f.books.upgrade(f.book.bookId, f.book.revision, randomUUID(), signal(), 3)
  const storylineId = randomUUID(), structure = { volumes: [], storylines: [{ storylineId, title: '伤腕线' }], chapters: book.chapters.filter(item => !item.kind || item.kind === 'chapter').map(item => ({ chapterId: item.chapterId, ...item.structure, storylineIds: f.ids.slice(0, 2).includes(item.chapterId) ? [storylineId] : [] })) }
  const { BookStructureStore } = await import('../lib/host/book-structure.js'), structures = await BookStructureStore.at(f.root, f.workspaceId, f.books)
  let request = { workspaceId: f.workspaceId, bookId: book.bookId, expectedRevision: book.revision, operationId: randomUUID(), structure }, preview = await structures.preview(request, signal()); book = await structures.update({ ...request, previewHash: preview.previewHash }, signal())
  const query = await f.query({ expectedRevision: book.revision, chapterIds: [], storylineId }), view = await f.reviews.run(query, f.generate, signal()); await f.reviews.decide(f.decide(view, 'dismiss'), signal())
  assert.equal((await f.reviews.get(book.bookId, view.reviewId, signal())).issues[0].decision, 'dismissed')
  const backups = await BackupStore.at(f.root), archive = await backups.create(book.bookId, randomUUID(), signal()), inspection = await backups.inspect(book.bookId, archive.backupId, signal())
  assert(inspection.files.some(name => name.includes('/book-reviews/')))
  const copy = await backups.restore(book.bookId, archive.backupId, inspection.manifestHash, signal()), copied = await readFile(join(copy.root, 'novels', book.bookId, 'book-reviews', `${view.reviewId}.json`), 'utf8')
  assert.equal(parseBookReviewRecord(copied, f.workspaceId, book.bookId, view.reviewId).decisions[0].action, 'dismiss')
  assert.throws(() => parseBookReviewRecord(copied, hash(copy.root), book.bookId, view.reviewId), reason('invalid-format'))
  assert((await chapterImpacts(f.root, f.workspaceId, f.books, book.bookId, f.ids[0], signal())).items.some(item => item.kind === 'book-review'))
  assert((await structureImpacts(await BookFiles.at(f.root), f.workspaceId, book, f.ids.slice(0, 2), signal())).items.some(item => item.kind === 'book-review'))
  structure.chapters.reverse(); request = { ...request, expectedRevision: book.revision, operationId: randomUUID(), structure }; preview = await structures.preview(request, signal()); await structures.update({ ...request, previewHash: preview.previewHash }, signal())
  assert.equal((await f.reviews.get(book.bookId, view.reviewId, signal())).state, 'expired')
})

test('damaged auxiliary records, scan budgets, unknown formats and cancellation are visible without unreadable completed output', async t => {
  const f = await fixture(t), folder = join(f.root, 'novels', f.book.bookId, 'reviews'); await mkdir(folder); await writeFile(join(folder, `${randomUUID()}.json`), 'damaged')
  const preview = await f.reviews.preview(f.scope, signal()); assert(!preview.complete); assert(preview.sources.some(item => item.state === 'unavailable'))
  const limited = await BookReviewStore.at(f.root, f.workspaceId, f.books, { reviewFiles: 0, reviewBytes: 1 }); assert(!(await limited.preview(f.scope, signal())).complete)
  const view = await f.reviews.run(await f.query(), false, signal()); assert.equal(view.state, 'unknown')
  const file = join(f.root, 'novels', f.book.bookId, 'book-reviews', `${view.reviewId}.json`), record = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, json({ ...record, version: 2 })); await assert.rejects(f.reviews.get(f.book.bookId, view.reviewId, signal()), reason('unsupported-format'))
  assert.equal((await f.reviews.list(f.book.bookId, signal())).unreadable, 1)
  record.result.issues = [f.issue]; await writeFile(file, json(record)); await assert.rejects(f.reviews.get(f.book.bookId, view.reviewId, signal()), reason('invalid-format'))
})

test('explicit Host stop cancels and persists without relying on request transport cancellation', async t => {
  const f = await fixture(t), ctx = new Context(); let entered, calls = 0
  const started = new Promise(resolve => { entered = resolve })
  ctx.provide('sessionPersistence', { stat: async () => undefined }); ctx.provide('agentPresets', { roots: [], list: async () => [] })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixed', model: 'deepseek-v4.1-flash' }) })
  ctx.plugin(Sessions); ctx.plugin(Projection); ctx.plugin(Policy, { mode: 'workspace-write' }); ctx.plugin(LocalFs); ctx.plugin(Llm); ctx.plugin(SuperNovel); t.after(() => ctx.fiber.dispose())
  await new Promise(resolve => ctx.inject(['sessions', 'sessionProjections', 'sandboxPolicy', 'fs', 'llm', 'superNovel'], () => resolve(true)))
  ctx.sessionProjections.register({ key: 'modelSelection', stateSchema: z.any(), init: () => ({ pending: null, lastUsed: null }), apply: state => state, stateVersion: 2 })
  class Waiting extends LlmAdapter {
    async *stream(options) {
      calls++; entered(); assert.deepEqual(options.tools, [])
      await new Promise((_yes, no) => options.signal.addEventListener('abort', () => no(options.signal.reason), { once: true }))
    }
  }
  const off = ctx.llm.registerAdapter(['fixed'], new Waiting()); t.after(off)
  const sessionId = SessionId('explicit-review-stop'); ctx.sessions.create(sessionId, { meta: { cwd: f.root } })
  const request = await f.query(), api = ctx.superNovel, controller = new AbortController(), task = api.reviewBookRange(sessionId, request, controller.signal); void task.catch(() => {})
  await started
  await assert.rejects(api.stopBookReview(sessionId, hash('another'), f.book.bookId, request.reviewId, signal()), error => error.details.reason === 'location-changed')
  const stopped = await api.stopBookReview(sessionId, f.workspaceId, f.book.bookId, request.reviewId, signal())
  assert(!controller.signal.aborted); assert.equal(stopped.state, 'unknown'); assert.equal(stopped.reason, 'book-review-stopped'); assert.equal(stopped.calls, 1)
  await assert.rejects(task, error => error.details.reason === 'book-review-stopped')
  assert.deepEqual(await api.stopBookReview(sessionId, f.workspaceId, f.book.bookId, request.reviewId, signal()), stopped)
  assert.deepEqual(await api.reviewBookRange(sessionId, request, signal()), stopped); assert.equal(calls, 1)
})

test('Host preview is read-only and model/decision/revision routes enforce read-only and cross-library identity', async t => {
  const f = await fixture(t), ctx = new Context(); ctx.provide('sessionPersistence', { stat: async () => undefined }); ctx.provide('agentPresets', { roots: [], list: async () => [] })
  ctx.plugin(Sessions); ctx.plugin(Projection); ctx.plugin(Policy, { mode: 'read-only' }); ctx.plugin(LocalFs); ctx.plugin(SuperNovel); t.after(() => ctx.fiber.dispose())
  await new Promise(resolve => ctx.inject(['sessions', 'sessionProjections', 'sandboxPolicy', 'fs', 'superNovel'], () => resolve(true)))
  const sessionId = SessionId('book-review-host'), session = ctx.sessions.create(sessionId, { meta: { cwd: f.root } }), api = ctx.superNovel, remoteReason = code => error => error.details.reason === code, request = await f.query()
  assert((await api.previewBookReview(sessionId, f.scope, signal())).ready)
  await assert.rejects(api.reviewBookRange(sessionId, request, signal()), remoteReason('read-only'))
  const view = await f.reviews.run(request, f.generate, signal()), decision = f.decide(view)
  await assert.rejects(api.decideBookIssue(sessionId, decision, signal()), remoteReason('read-only'))
  await assert.rejects(api.stopBookReview(sessionId, f.workspaceId, f.book.bookId, view.reviewId, signal()), remoteReason('read-only'))
  await assert.rejects(api.reviseBookIssue(sessionId, { workspaceId: f.workspaceId, bookId: f.book.bookId, reviewId: view.reviewId, issueId: view.issues[0].issueId, proposalId: randomUUID() }, signal()), remoteReason('read-only'))
  setSandboxMode(session, 'workspace-write'); assert.equal((await api.decideBookIssue(sessionId, decision, signal())).issues[0].decision, 'confirmed')
  await assert.rejects(api.previewBookReview(sessionId, { ...f.scope, workspaceId: hash('another') }, signal()), remoteReason('location-changed'))
  assert.equal((await api.bookReview(sessionId, f.workspaceId, f.book.bookId, view.reviewId, signal())).reviewId, view.reviewId)
})
