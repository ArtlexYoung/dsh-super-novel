import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readdir, rm, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BookStore } from '../lib/host/book-store.js'
import { IntentStore } from '../lib/host/intent-store.js'
import { ProposalStore } from '../lib/host/proposal-store.js'
import { ReviewStore } from '../lib/host/review-store.js'
import { BackupStore } from '../lib/host/backup-store.js'
import { emptyIntent } from '../lib/domain/intents.js'
import { generationPrompt } from '../lib/domain/proposals.js'
import { mechanicalReview } from '../lib/domain/reviews.js'
import { hash, json } from '../lib/domain/books.js'
const signal = () => new AbortController().signal
const reason = code => error => error.code === code
async function fixture(t) {
  await mkdir('.test-output', { recursive: true })
  const root = await mkdtemp(resolve('.test-output/methods-')); t.after(() => rm(root, { force: true, recursive: true }))
  const books = await BookStore.at(root); let book = await books.createBook({ operationId: randomUUID(), title: '渡口' }, signal())
  const previousId = randomUUID(), chapterId = randomUUID(), text = '前文逐字保留。\n\n[TODO]\n\n后文逐字保留。'
  for (const [id, content] of [[previousId, '左腕已受伤。'], [chapterId, text]]) book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId: id, expectedRevision: book.revision, action: 'create', title: '章', beforeChapterId: '', expectedHash: '', content }, signal())
  const intents = await IntentStore.at(root, hash(root), books), proposals = await ProposalStore.at(root, hash(root), books), reviews = await ReviewStore.at(root, hash(root), books)
  const request = { workspaceId: hash(root), bookId: book.bookId, chapterId, expectedRevision: book.revision, expectedHash: hash(text), expectedVersion: 0 }
  const generation = { proposalId: randomUUID(), bookId: book.bookId, chapterId, expectedRevision: book.revision, expectedHash: hash(text), mode: 'draft', instruction: '起草', materials: '', start: 0, end: text.length }
  return { root, books, book, previousId, chapterId, text, intents, proposals, reviews, request, generation }
}
const checked = ['continuity', 'character', 'causality', 'language'].map(dimension => ({ dimension, state: 'checked' }))
test('intent reads and context previews do not write, immutable saves replay and competing versions conflict', async t => {
  const f = await fixture(t), folder = join(f.root, 'novels', f.book.bookId), before = await readdir(folder)
  assert.equal((await f.intents.read(f.book.bookId, f.chapterId)).version, 0)
  assert.equal(await f.intents.list(f.book.bookId, f.chapterId).then(items => items.length), 0)
  const preview = await f.proposals.preview(f.generation, signal())
  assert.equal(preview.state, 'ready'); assert.deepEqual(await readdir(folder), before)
  const input = { ...f.request, operationId: randomUUID(), intent: { ...emptyIntent(), goal: '交信', hardConstraints: '左腕不可用力。' } }
  assert.deepEqual(await f.intents.save(input, signal()), await f.intents.save(input, signal()))
  await assert.rejects(f.intents.save({ ...input, intent: { ...input.intent, goal: '不同内容' } }, signal()), reason('operation-conflict'))
  await assert.rejects(f.intents.save({ ...input, operationId: randomUUID() }, signal()), reason('revision-conflict'))
  await assert.rejects(f.intents.save({ ...input, workspaceId: hash('foreign') }, signal()), reason('location-changed'))
  assert.equal((await f.books.readChapter(f.book.bookId, f.chapterId)).content, f.text)
  const backups = await BackupStore.at(f.root), backup = await backups.create(f.book.bookId, randomUUID(), signal())
  assert(backup.verifiedAt > 0)
  assert((await backups.inspect(f.book.bookId, backup.backupId, signal())).files.some(name => name.includes(`/intents/${f.chapterId}/00000001.json`)))
  assert.equal((await readFile(join(folder, 'intents', f.chapterId, '00000001.json'), 'utf8')).includes('左腕不可用力'), true)
})
test('scene directions are bounded editable proposals, preserve constraints, replay without another call and expire on source changes', async t => {
  const f = await fixture(t), intent = { ...emptyIntent(), goal: '交信', hardConstraints: '不使用左腕。' }
  await f.intents.save({ ...f.request, operationId: randomUUID(), intent }, signal())
  let calls = 0
  const generate = async prompt => { calls++; assert.equal(JSON.parse(prompt).task, 'suggest-scene-intent'); return { replacement: json({ directions: [{ ...intent, goal: '等船靠岸' }] }), complete: true, reason: '', usage: { state: 'unknown' } } }
  const request = { ...f.request, expectedVersion: 1, proposalId: randomUUID(), instruction: '给两个选择' }
  const value = await f.intents.suggest(request, generate, signal()); assert.equal(value.state, 'review')
  assert.deepEqual(await f.intents.suggest(request, generate, signal()), value); assert.equal(calls, 1)
  for (const directions of [[], Array(4).fill(intent), [{ ...intent, hardConstraints: '' }]]) {
    await assert.rejects(f.intents.suggest({ ...request, proposalId: randomUUID() }, async () => ({ replacement: json({ directions }), complete: true, reason: '', usage: { state: 'unknown' } }), signal()))
  }
  await writeFile(join(f.root, 'novels', f.book.bookId, 'chapters', `${f.chapterId}.md`), '外部改稿')
  assert.equal((await f.intents.list(f.book.bookId, f.chapterId))[0].state, 'expired')
})
test('context preview matches generation, preserves hard constraints, validates preceding prose and expires changed intent', async t => {
  const f = await fixture(t), intent = { ...emptyIntent(), goal: '交信', hardConstraints: '左腕已受伤。' }
  await f.intents.save({ ...f.request, operationId: randomUUID(), intent }, signal())
  const request = { ...f.generation, intentVersion: 1, hardConstraints: '不加入新人物。', precedingChapterIds: [f.previousId] }
  const preview = await f.proposals.preview(request, signal()), { proposal } = await f.proposals.create('a', request, signal())
  assert.equal(preview.bytes, Buffer.byteLength(generationPrompt(proposal)))
  const prompt = JSON.parse(generationPrompt(proposal))
  assert.deepEqual(prompt.hardConstraints, ['不加入新人物。', '左腕已受伤。']); assert.equal(prompt.sceneIntent.goal, '交信')
  assert.equal(prompt.selectedMaterials[0].content, '左腕已受伤。')
  await f.proposals.checkpoint(f.book.bookId, request.proposalId, '候选', 'review', '', { state: 'unknown' }, 1)
  await f.intents.save({ ...f.request, expectedVersion: 1, operationId: randomUUID(), intent: { ...intent, goal: '等船' } }, signal())
  assert.equal((await f.proposals.view(f.book.bookId, request.proposalId, false)).reason, 'intent-changed')
  await assert.rejects(f.proposals.preview({ ...f.generation, precedingChapterIds: [f.chapterId] }, signal()), reason('invalid-material'))
  const oversized = { ...f.generation, instruction: '起草', materials: '字'.repeat(65_536), hardConstraints: '不遗漏。'.repeat(1000) }
  // Add large baseline to exceed the common prompt budget without truncating a constraint.
  const text = '正文。'.repeat(30_000), book = await f.books.mutate({ operationId: randomUUID(), bookId: f.book.bookId, chapterId: f.chapterId, expectedRevision: f.book.revision, action: 'save', title: '', beforeChapterId: '', expectedHash: hash(f.text), content: text }, signal())
  const big = { ...oversized, expectedRevision: book.revision, expectedHash: hash(text), end: text.length, proposalId: randomUUID() }
  const over = await f.proposals.preview(big, signal()); assert.equal(over.state, 'over-budget'); assert.equal(over.sections[0].content, big.hardConstraints)
  await assert.rejects(f.proposals.create('a', big, signal()), reason('context-too-large'))
})
test('local review rejects issues outside the selection and revisions preserve surrounding text', async t => {
  const f = await fixture(t), start = f.text.indexOf('[TODO]'), end = start + 6
  const request = { reviewId: randomUUID(), bookId: f.book.bookId, chapterId: f.chapterId, proposalId: '', expectedRevision: f.book.revision, expectedHash: hash(f.text), minCharacters: 0, maxCharacters: 0, minParagraphs: 0, maxParagraphs: 0, start, end }
  const issue = { dimension: 'language', severity: 'warning', message: '改为动作', suggestion: '写完整', start: 0, end: 2, quote: f.text.slice(0, 2), references: [] }
  const invalid = await f.reviews.run(request, async prompt => { assert.deepEqual(JSON.parse(prompt).range, { start, end }); return { replacement: json({ dimensions: checked, issues: [issue] }), complete: true, reason: '', usage: { state: 'unknown' } } }, signal())
  assert.equal(invalid.reason, 'invalid-evidence'); assert(invalid.issues.every(item => item.start >= start && item.end <= end))
  const view = await f.reviews.run({ ...request, reviewId: randomUUID() }, false, signal())
  const revision = await f.reviews.revision(f.book.bookId, view.reviewId, view.issues[0].issueId)
  const { proposal } = await f.proposals.create('a', revision.request, signal())
  await f.proposals.checkpoint(f.book.bookId, proposal.request.proposalId, '他抬起右手。', 'review', '', { state: 'unknown' }, 1)
  assert.equal((await f.proposals.view(f.book.bookId, proposal.request.proposalId, false)).candidate, f.text.slice(0, start) + '他抬起右手。' + f.text.slice(end))
  await assert.rejects(f.reviews.run({ ...request, reviewId: randomUUID(), start: 1, end: f.text.length + 1 }, false, signal()), reason('invalid-range'))
})
test('intentional repetition remains an author exception, not an automatic rewriting rule', () => {
  const paragraph = '雨声从空屋里传来，始终没有停下。', text = `${paragraph}\n\n${paragraph}`
  const limits = { minCharacters: 0, maxCharacters: 0, minParagraphs: 0, maxParagraphs: 0 }
  assert(mechanicalReview(text, limits).issues.some(issue => issue.message === 'repeated-expression' && issue.severity === 'warning'))
  assert.deepEqual(mechanicalReview(text, { ...limits, intentionalRepetitions: [paragraph] }).issues, [])
})
