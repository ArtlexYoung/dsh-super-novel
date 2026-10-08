import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BookStore } from '../lib/host/book-store.js'
import { ProposalStore } from '../lib/host/proposal-store.js'
import { ReviewStore } from '../lib/host/review-store.js'
import { hash } from '../lib/domain/books.js'
import { mechanicalReview } from '../lib/domain/reviews.js'
import { BookFiles } from '../lib/host/book-files.js'
const signal = () => new AbortController().signal
const reason = code => error => error.code === code
async function fixture(t) {
  await mkdir('.test-output', { recursive: true })
  const root = await mkdtemp(resolve('.test-output/reviews-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const books = await BookStore.at(root)
  let book = await books.createBook({ operationId: randomUUID(), title: '审校渡河' }, signal())
  const chapterId = randomUUID(), text = '前文保持。\n\n[TODO]\n\n后文保持。'
  book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId, expectedRevision: book.revision, action: 'create', title: '第一章', content: text, expectedHash: '', beforeChapterId: '' }, signal())
  const proposals = await ProposalStore.at(root, hash(root), books), reviews = await ReviewStore.at(root, hash(root), books)
  const request = { reviewId: randomUUID(), bookId: book.bookId, chapterId, proposalId: '', expectedRevision: book.revision, expectedHash: hash(text), minCharacters: 0, maxCharacters: 0, minParagraphs: 0, maxParagraphs: 0 }
  return { root, books, book, chapterId, text, proposals, reviews, request }
}
const checked = () => ['continuity', 'character', 'causality', 'language'].map(dimension => ({ dimension, state: 'checked' }))
const fixed = (issues = [], dimensions = checked()) => async prompt => { assert.equal(JSON.parse(prompt).task, 'review-fiction'); return { replacement: JSON.stringify({ dimensions, issues }), complete: true, reason: '', usage: { state: 'unknown' } } }
test('mechanical checks count nonwhitespace Unicode code points and blank-line paragraphs', () => {
  const request = { minCharacters: 4, maxCharacters: 4, minParagraphs: 2, maxParagraphs: 2 }
  assert.deepEqual(mechanicalReview('中🙂\r\n\r\nA B', request), { characters: 4, paragraphs: 2, issues: [] })
  const issues = mechanicalReview('[TODO]\n\n待写', { ...request, maxCharacters: 5 }).issues
  assert(issues.some(item => item.message === 'placeholder'))
  assert(issues.some(item => item.message === 'character-limit'))
})
test('missing model or context cannot claim a passed review; review queries never change prose', async t => {
  const f = await fixture(t)
  const unknown = await f.reviews.run(f.request, false, signal())
  assert.equal(unknown.state, 'unknown')
  assert.equal(unknown.reason, 'generation-unavailable')
  const degraded = await f.reviews.run({ ...f.request, reviewId: randomUUID() }, fixed(), signal())
  assert.equal(degraded.state, 'degraded')
  assert.equal((await f.reviews.list(f.book.bookId, f.chapterId)).length, 2)
  assert.equal((await f.books.readChapter(f.book.bookId, f.chapterId)).content, f.text)
})
test('review prompt defines completed checks separately from issue severity, and invalid dimension states stay unknown', async t => {
  const f = await fixture(t)
  const issue = { dimension: 'language', severity: 'error', message: '补全占位符', suggestion: '写成动作', quote: '[TODO]', start: f.text.indexOf('[TODO]'), end: f.text.indexOf('[TODO]') + 6, references: [] }
  const generate = async prompt => {
    const input = JSON.parse(prompt)
    assert.deepEqual(Object.keys(input.dimensionStates).sort(), ['checked', 'degraded', 'unknown'])
    return fixed([issue], input.format.dimensions.map(item => ({ ...item, state: 'checked' })))(prompt)
  }
  const complete = await f.reviews.run(f.request, generate, signal())
  assert.equal(complete.state, 'degraded')
  assert(complete.issues.some(item => item.dimension === 'language' && item.severity === 'error'))
  assert.equal(complete.dimensions.find(item => item.dimension === 'language')!.state, 'checked')
  for (const state of ['error', 'warning', 'passed', 'failed']) {
    const dimensions = checked().map(item => item.dimension === 'language' ? { ...item, state } : item)
    const invalid = await f.reviews.run({ ...f.request, reviewId: randomUUID() }, fixed([issue], dimensions), signal())
    assert.equal(invalid.state, 'unknown')
    assert.equal(invalid.reason, 'invalid-output')
    assert(invalid.issues.every(item => item.dimension === 'mechanical'))
  }
})
test('fabricated citations, duplicate dimensions, malformed output and unfinished calls remain unknown', async t => {
  const f = await fixture(t)
  const issue = { dimension: 'continuity', severity: 'error', message: '冲突', suggestion: '核对', quote: '伪造', start: 0, end: 2, references: [] }
  for (const generate of [fixed([issue]), fixed([], [...checked().slice(0, 3), checked()[0]]), async () => ({ replacement: '{bad', complete: true, reason: '', usage: { state: 'unknown' } }), async () => ({ replacement: '', complete: false, reason: 'truncated', usage: { state: 'unknown' } })]) {
    const view = await f.reviews.run({ ...f.request, reviewId: randomUUID() }, generate, signal())
    assert.equal(view.state, 'unknown')
    assert.equal(view.issues.every(item => item.dimension === 'mechanical'), true)
  }
  await assert.rejects(f.reviews.run({ ...f.request, reviewId: randomUUID() }, fixed(), AbortSignal.abort()), { name: 'AbortError' })
})
test('review ID replay does not rerun the model and different requests conflict; external edits expire', async t => {
  const f = await fixture(t)
  let calls = 0
  const generator = async prompt => { calls++; return fixed()(prompt) }
  await f.reviews.run(f.request, generator, signal())
  await f.reviews.run(f.request, generator, signal())
  assert.equal(calls, 1)
  await assert.rejects(f.reviews.run({ ...f.request, minCharacters: 5 }, generator, signal()), reason('operation-conflict'))
  await writeFile(join(f.root, 'novels', f.book.bookId, 'chapters', `${f.chapterId}.md`), '外部作者新稿')
  assert.equal((await f.reviews.list(f.book.bookId, f.chapterId))[0].state, 'expired')
})
test('candidate revisions keep text outside the issue exactly and stop after two rounds', async t => {
  const f = await fixture(t)
  const create = { proposalId: randomUUID(), bookId: f.book.bookId, chapterId: f.chapterId, expectedRevision: f.book.revision, expectedHash: hash(f.text), mode: 'draft', instruction: '起草', materials: '左腕受伤，不可游泳。', start: 0, end: f.text.length }
  let { proposal } = await f.proposals.create('a', create, signal())
  await f.proposals.checkpoint(f.book.bookId, proposal.request.proposalId, f.text, 'review', '', { state: 'unknown' }, 1)
  let word = '[TODO]'
  for (let round = 1; round <= 3; round++) {
    const view = await f.proposals.view(f.book.bookId, proposal.request.proposalId, false)
    const at = view.candidate.indexOf(word)
    const issue = { dimension: 'language', severity: 'error', message: '改动作', suggestion: '补全动作', quote: word, start: at, end: at + word.length, references: [] }
    const review = await f.reviews.run({ ...f.request, reviewId: randomUUID(), proposalId: view.proposalId, expectedHash: view.candidateHash }, fixed([issue]), signal())
    assert.equal(review.state, 'issues')
    const chosen = review.issues.find(item => item.dimension === 'language')!
    if (round === 3) { await assert.rejects(f.reviews.revision(f.book.bookId, review.reviewId, chosen.issueId), reason('revision-limit')); break }
    const revision = await f.reviews.revision(f.book.bookId, review.reviewId, chosen.issueId)
    const changed = await f.proposals.create('a', revision.request, signal())
    assert.equal(changed.proposal.revisionRound, round)
    await f.proposals.checkpoint(f.book.bookId, changed.proposal.request.proposalId, '改文', 'review', '', { state: 'unknown' }, 1)
    const child = await f.proposals.view(f.book.bookId, changed.proposal.request.proposalId, false)
    assert.equal(child.candidate, view.candidate.slice(0, at) + '改文' + view.candidate.slice(at + word.length))
    proposal = changed.proposal; word = '改文'
  }
  assert.equal((await f.books.readChapter(f.book.bookId, f.chapterId)).content, f.text)
  const final = await f.proposals.view(f.book.bookId, proposal.request.proposalId, false)
  await f.proposals.decide({ bookId: f.book.bookId, proposalId: final.proposalId, expectedCandidateHash: final.candidateHash }, true, signal())
  assert.equal((await f.books.readChapter(f.book.bookId, f.chapterId)).content, final.candidate)
})
test('damaged assessment counts, status and future checker formats are rejected', async t => {
  const f = await fixture(t)
  await f.reviews.run(f.request, fixed(), signal())
  const path = join(f.root, 'novels', f.book.bookId, 'reviews', `${f.request.reviewId}.json`)
  const record = JSON.parse(await readFile(path, 'utf8'))
  for (const damaged of [{ ...record, checkerVersion: 2 }, { ...record, result: { ...record.result, characters: 999 } }, { ...record, result: { ...record.result, state: 'passed' } }]) {
    await writeFile(path, JSON.stringify(damaged))
    await assert.rejects(f.reviews.list(f.book.bookId, f.chapterId), reason(damaged.checkerVersion === 2 ? 'unsupported-format' : 'invalid-format'))
  }
})
test('review input budget preserves mechanical findings without contacting a model', async t => {
  const f = await fixture(t), text = '正文。'.repeat(30_000)
  const book = await f.books.mutate({ operationId: randomUUID(), bookId: f.book.bookId, chapterId: f.chapterId, expectedRevision: f.book.revision, action: 'save', title: '', content: text, expectedHash: hash(f.text), beforeChapterId: '' }, signal())
  const view = await f.reviews.run({ ...f.request, expectedRevision: book.revision, expectedHash: hash(text), maxCharacters: 10 }, async () => { throw new Error('must not call') }, signal())
  assert.equal(view.state, 'unknown'); assert.equal(view.reason, 'context-too-large')
  assert(view.issues.some(item => item.message === 'character-limit'))
})
test('background reads remain valid while a candidate file is atomically replaced', async t => {
  const f = await fixture(t), files = await BookFiles.at(f.root)
  await writeFile(join(f.root, 'candidate.json'), '0')
  await Promise.all([async function () {
    for (let i = 1; i <= 60; i++) await files.replace('candidate.json', String(i), { exists: true, text: String(i - 1) })
  }(), async function () {
    for (let i = 0; i < 200; i++) assert.match((await files.read('candidate.json')).text, /^\d+$/)
  }()])
})
