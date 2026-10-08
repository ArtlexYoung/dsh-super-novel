import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BookStore } from '../lib/host/book-store.js'
import { FactStore } from '../lib/host/fact-store.js'
import { hash } from '../lib/domain/books.js'
import { extractFacts } from '../lib/host/fact-extraction.js'
import { ProposalStore } from '../lib/host/proposal-store.js'
const signal = () => new AbortController().signal
const reason = code => error => error.code === code
async function fixture(t) {
  await mkdir('.test-output', { recursive: true })
  const root = await mkdtemp(resolve('.test-output/facts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const books = await BookStore.at(root)
  let book = await books.createBook({ operationId: randomUUID(), title: '事实渡河' }, signal())
  const chapterId = randomUUID()
  book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId, expectedRevision: book.revision, action: 'create', title: '第一章', content: '', expectedHash: '', beforeChapterId: '' }, signal())
  const content = '左腕受伤。雨落在船板上。'
  book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId, expectedRevision: book.revision, action: 'save', title: '', content, expectedHash: hash(''), beforeChapterId: '' }, signal())
  const facts = await FactStore.at(root, hash(root), books)
  const nextId = randomUUID()
  book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId: nextId, expectedRevision: book.revision, action: 'create', title: '第二章', content: '', expectedHash: '', beforeChapterId: '' }, signal())
  return { root, books, facts, book, chapterId, content, nextId }
}
function request(f, extra = {}) {
  const start = f.content.indexOf('左腕受伤。')
  return { proposalId: randomUUID(), bookId: f.book.bookId, sourceChapterId: f.chapterId, expectedRevision: f.book.revision, expectedHash: hash(f.content), coverage: 'chapter', summary: { text: '主角左腕受伤，雨落船板。', quote: f.content, start: 0, end: f.content.length }, facts: [{ subject: '主角', predicate: '伤势', value: '左腕受伤', scope: { kind: 'reader' }, sourceChapterId: f.chapterId, quote: f.content.slice(start, start + 5), start, end: start + 5 }], ...extra }
}
test('evidence fact candidates validate quote, source and idempotent adoption', async t => {
  const f = await fixture(t)
  const proposal = await f.facts.propose(request(f), signal())
  assert.equal(proposal.state, 'review')
  assert.equal(proposal.facts[0].quote, '左腕受伤。')
  const accepted = await f.facts.decide(f.book.bookId, proposal.proposalId, proposal.factsHash, true, signal())
  assert.equal(accepted.state, 'accepted')
  assert.equal((await f.books.readBook(f.book.bookId)).chapters.length, 3)
  assert.deepEqual(await f.facts.decide(f.book.bookId, proposal.proposalId, proposal.factsHash, true, signal()), accepted)
  await assert.rejects(f.facts.decide(f.book.bookId, proposal.proposalId, proposal.factsHash, false, signal()), reason('fact-finalized'))
  await assert.rejects(f.facts.context(f.book.bookId, randomUUID(), 'reader', 131072), reason('chapter-not-found'))
})
test('character and reader knowledge are isolated; changed source expires and fake evidence is refused', async t => {
  const f = await fixture(t)
  const characterId = randomUUID()
  f.book = await f.books.mutate({ operationId: randomUUID(), bookId: f.book.bookId, chapterId: characterId, expectedRevision: (await f.books.readBook(f.book.bookId)).revision, action: 'create', title: '林舟', kind: 'character', content: '', expectedHash: '', beforeChapterId: '' }, signal())
  await assert.rejects(f.facts.propose(request(f, { facts: [{ ...request(f).facts[0], quote: '伪造原文', scope: { kind: 'character', characterId } }] }), signal()), reason('invalid-evidence'))
  const characterRequest = request(f, { facts: [{ ...request(f).facts[0], scope: { kind: 'character', characterId } }] })
  f.book = await f.books.mutate({ operationId: randomUUID(), bookId: f.book.bookId, chapterId: f.chapterId, expectedRevision: f.book.revision, action: 'save', title: '', content: f.content, expectedHash: hash(f.content), beforeChapterId: '' }, signal())
  characterRequest.expectedRevision = f.book.revision
  const proposal = await f.facts.propose(characterRequest, signal())
  const factChapter = f.book.chapters.find(item => item.kind === 'facts')
  assert.equal(factChapter, undefined)
  await f.facts.decide(f.book.bookId, proposal.proposalId, proposal.factsHash, true, signal())
  const target = await f.books.readBook(f.book.bookId)
  const context = await f.facts.context(f.book.bookId, f.nextId, characterId, 131072)
  assert.equal(context.facts[0].scope.kind, 'character')
  const reader = await f.facts.context(f.book.bookId, f.nextId, 'reader', 131072)
  assert.equal(reader.facts.length, 0)
  assert.equal(context.summaries.length, 0)
  await writeFile(join(f.root, 'novels', f.book.bookId, 'chapters', `${f.chapterId}.md`), '改过的正文')
  assert.equal((await f.facts.list(f.book.bookId, f.chapterId))[0].state, 'expired')
  assert.equal(target.chapters.some(item => item.kind === 'facts'), true)
})
test('fact context reports missing, stale and byte-budget states without inventing facts', async t => {
  const f = await fixture(t)
  assert.equal((await f.facts.context(f.book.bookId, f.nextId, 'reader', 131072)).state, 'degraded')
  const proposal = await f.facts.propose(request(f), signal())
  await f.facts.decide(f.book.bookId, proposal.proposalId, proposal.factsHash, true, signal())
  assert.equal((await f.facts.context(f.book.bookId, f.nextId, 'reader', 131072)).state, 'complete')
  assert.equal((await f.facts.context(f.book.bookId, f.nextId, 'reader', 1)).state, 'over-budget')
  const record = (await f.books.readBook(f.book.bookId)).chapters.find(item => item.kind === 'facts')!
  const stored = JSON.parse(await readFile(join(f.root, 'novels', f.book.bookId, 'chapters', `${record.chapterId}.md`), 'utf8'))
  assert.equal(stored.schemaVersion, 1)
  await writeFile(join(f.root, 'novels', f.book.bookId, 'chapters', `${f.chapterId}.md`), '改过正文')
  assert.equal((await f.facts.context(f.book.bookId, f.nextId, 'reader', 131072)).state, 'expired')
})

for (const stage of ['prepared', 'chapter', 'manifest', 'completed'] as const) {
  test(`fact adoption failure at ${stage} recovers one version and retains the prose`, async t => {
    const f = await fixture(t)
    const proposal = await f.facts.propose(request(f), signal())
    const broken = await BookStore.at(f.root, { afterStage: async value => { if (value === stage) throw new Error('injected-crash') } })
    const other = await FactStore.at(f.root, hash(f.root), broken)
    await assert.rejects(other.decide(f.book.bookId, proposal.proposalId, proposal.factsHash, true, signal()), /injected-crash/)
    await f.books.recover(f.book.bookId, signal())
    assert.equal((await f.facts.decide(f.book.bookId, proposal.proposalId, proposal.factsHash, true, signal())).state, 'accepted')
    assert.equal((await f.books.readBook(f.book.bookId)).revision, f.book.revision + 1)
    assert.equal((await f.books.readChapter(f.book.bookId, f.chapterId)).content, f.content)
  })
}
test('explicit extraction never reruns an existing candidate and rejects malformed, fabricated or unfinished output', async t => {
  const f = await fixture(t)
  const input = request(f)
  const { facts, summary, coverage, ...generation } = input
  let calls = 0
  const generate = async prompt => { calls++; assert.equal(JSON.parse(prompt).task, 'extract-facts'); return { replacement: JSON.stringify({ facts, summary }), complete: true, reason: '', usage: { state: 'unknown' } } }
  const result = await extractFacts(f.books, f.facts, generation, generate, signal())
  assert.equal(result.state, 'review')
  await extractFacts(f.books, f.facts, generation, generate, signal())
  assert.equal(calls, 1)
  await assert.rejects(extractFacts(f.books, f.facts, { ...generation, expectedHash: hash('wrong') }, generate, signal()), reason('operation-conflict'))
  for (const [output, code] of [['{bad', 'invalid-output'], [JSON.stringify({ facts: [{ ...facts[0], quote: '伪造' }], summary }), 'invalid-evidence']]) {
    await assert.rejects(extractFacts(f.books, f.facts, { ...generation, proposalId: randomUUID() }, async () => ({ replacement: output, complete: true, reason: '', usage: { state: 'unknown' } }), signal()), reason(code))
  }
  await assert.rejects(extractFacts(f.books, f.facts, { ...generation, proposalId: randomUUID() }, async () => ({ replacement: '', complete: false, reason: 'truncated', usage: { state: 'unknown' } }), signal()), reason('truncated'))
})
test('selected-range facts remain degraded until full-chapter coverage is adopted', async t => {
  const f = await fixture(t)
  const proposal = await f.facts.propose(request(f, { coverage: 'selection' }), signal())
  await f.facts.decide(f.book.bookId, proposal.proposalId, proposal.factsHash, true, signal())
  assert.equal((await f.facts.context(f.book.bookId, f.nextId, 'reader', 131072)).state, 'degraded')
})
test('dependent generation blocks missing facts and captures adopted facts; later external edits expire the candidate', async t => {
  const f = await fixture(t)
  const proposals = await ProposalStore.at(f.root, hash(f.root), f.books)
  let generate = { proposalId: randomUUID(), bookId: f.book.bookId, chapterId: f.nextId, expectedRevision: f.book.revision,
    expectedHash: hash(''), mode: 'draft', instruction: '起草', materials: '', start: 0, end: 0, useFacts: true, knowledgeScope: 'reader' }
  await assert.rejects(proposals.create('a', generate, signal()), reason('facts-incomplete'))
  const fact = await f.facts.propose(request(f), signal())
  await f.facts.decide(f.book.bookId, fact.proposalId, fact.factsHash, true, signal())
  generate = { ...generate, proposalId: randomUUID(), expectedRevision: (await f.books.readBook(f.book.bookId)).revision }
  const { proposal } = await proposals.create('a', generate, signal())
  assert.equal(proposal.factContext.sources.length, 1)
  assert(proposal.factContext.content.includes('左腕受伤'))
  await proposals.checkpoint(f.book.bookId, proposal.request.proposalId, '继续渡河', 'review', '', { state: 'unknown' }, 1)
  await writeFile(join(f.root, 'novels', f.book.bookId, 'chapters', `${f.chapterId}.md`), '外部修改')
  assert.equal((await proposals.view(f.book.bookId, proposal.request.proposalId, false)).state, 'expired')
})
