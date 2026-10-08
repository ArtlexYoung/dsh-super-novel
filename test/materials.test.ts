import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { BookStore } from '../lib/host/book-store.js'
import { ProposalStore } from '../lib/host/proposal-store.js'
import { ChapterHistory } from '../lib/host/chapter-history.js'
import { generationPrompt } from '../lib/domain/proposals.js'
import { hash } from '../lib/domain/books.js'
const signal = () => new AbortController().signal
const reason = code => error => error.code === code
async function fixture(t) {
  await mkdir('.test-output', { recursive: true })
  const root = await mkdtemp(resolve('.test-output/materials-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const books = await BookStore.at(root)
  let book = await books.createBook({ operationId: randomUUID(), title: '渡河' }, signal())
  const create = async (kind, content, linkedChapterId) => {
    const chapterId = randomUUID()
    book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId, expectedRevision: book.revision,
      action: 'create', title: kind, content, expectedHash: '', beforeChapterId: '', kind, ...(linkedChapterId ? { linkedChapterId } : {}) }, signal())
    return chapterId
  }
  const chapterId = await create('chapter', '')
  const ids = []
  for (const kind of ['seed', 'book-card', 'character', 'world', 'outline', 'chapter-outline', 'scene'] as const) ids.push(await create(kind, `已采纳的${kind}`, kind === 'scene' || kind === 'chapter-outline' ? chapterId : undefined))
  const store = await ProposalStore.at(root, hash(root), books)
  const request = { proposalId: randomUUID(), bookId: book.bookId, chapterId, expectedRevision: book.revision, expectedHash: hash(''),
    mode: 'draft', instruction: '起草', materials: '', start: 0, end: 0, materialIds: ids }
  return { root, books, book, store, request, ids }
}
test('all planning kinds share version history and explicit snapshot selection; plans stay separate from prose', async t => {
  const f = await fixture(t)
  const { proposal } = await f.store.create('a', f.request, signal())
  const prompt = JSON.parse(generationPrompt(proposal))
  assert.equal(prompt.selectedMaterials.length, 7)
  assert.equal(prompt.selectedMaterials[6].kind, 'scene')
  assert(prompt.planningBoundary.includes('not events'))
  assert.equal((await f.books.readChapter(f.book.bookId, f.request.chapterId)).content, '')
  assert.equal((await new ChapterHistory(f.books).list(f.book.bookId, f.ids[0], 0)).length, 1)
  await f.store.checkpoint(f.book.bookId, proposal.request.proposalId, '下一章正文', 'review', '', { state: 'unknown' }, 1)
  const scene = await f.books.readChapter(f.book.bookId, f.ids[6])
  await f.books.mutate({ operationId: randomUUID(), bookId: f.book.bookId, chapterId: f.ids[6], action: 'save',
    expectedRevision: f.book.revision, expectedHash: scene.hash, content: '修改场景', title: '', beforeChapterId: '' }, signal())
  assert.equal((await f.store.view(f.book.bookId, proposal.request.proposalId, false)).state, 'expired')
})
test('cross-book materials, duplicate selections and externally changed material are refused', async t => {
  const f = await fixture(t)
  const other = await f.books.createBook({ operationId: randomUUID(), title: '另一书' }, signal())
  const foreign = randomUUID()
  await f.books.mutate({ operationId: randomUUID(), bookId: other.bookId, chapterId: foreign, action: 'create', kind: 'world',
    expectedRevision: other.revision, expectedHash: '', content: '别书资料', title: '世界', beforeChapterId: '' }, signal())
  await assert.rejects(f.store.create('a', { ...f.request, materialIds: [foreign] }, signal()), reason('chapter-not-found'))
  await assert.rejects(f.store.create('a', { ...f.request, materialIds: [f.ids[0], f.ids[0]] }, signal()))
  const { proposal } = await f.store.create('a', f.request, signal())
  await f.store.checkpoint(f.book.bookId, proposal.request.proposalId, '候选', 'review', '', { state: 'unknown' }, 1)
  await writeFile(join(f.root, 'novels', f.book.bookId, 'chapters', `${f.ids[0]}.md`), '外部资料变更')
  assert.equal((await f.store.view(f.book.bookId, proposal.request.proposalId, false)).state, 'expired')
  await assert.rejects(f.store.create('a', { ...f.request, proposalId: randomUUID() }, signal()), reason('revision-conflict'))
})
test('planning proposals can be adopted through the same guarded save protocol; chapter link is validated', async t => {
  const f = await fixture(t)
  const target = await f.books.readChapter(f.book.bookId, f.ids[6])
  const { proposal } = await f.store.create('a', { ...f.request, chapterId: f.ids[6], materialIds: [f.ids[0]], expectedHash: target.hash, end: target.content.length }, signal())
  assert.equal(JSON.parse(generationPrompt(proposal)).documentKind, 'scene')
  await f.store.checkpoint(f.book.bookId, proposal.request.proposalId, '## 转折\n船索断裂。', 'review', '', { state: 'unknown' }, 1)
  const view = await f.store.view(f.book.bookId, proposal.request.proposalId, false)
  await f.store.decide({ bookId: f.book.bookId, proposalId: view.proposalId, expectedCandidateHash: view.candidateHash }, true, signal())
  assert.equal((await f.books.readChapter(f.book.bookId, f.ids[6])).content, '## 转折\n船索断裂。')
  const latest = await f.books.readBook(f.book.bookId)
  await assert.rejects(f.books.mutate({ operationId: randomUUID(), bookId: f.book.bookId, chapterId: randomUUID(), kind: 'scene', linkedChapterId: f.ids[0],
    action: 'create', expectedRevision: latest.revision, expectedHash: '', content: '', title: '无效关联', beforeChapterId: '' }, signal()), reason('invalid-format'))
})

test('all seven material targets can organize saved prose; snapshots separate prose and plans and never change the source', async t => {
  const f = await fixture(t)
  const source = f.request.chapterId, prose = '林舟左腕受伤。他知道船票藏在柜中，但苏晴尚不知道。'
  const book = await f.books.mutate({ operationId: randomUUID(), bookId: f.book.bookId, chapterId: source,
    action: 'save', expectedRevision: f.book.revision, expectedHash: hash(''), content: prose, title: '', beforeChapterId: '' }, signal())
  for (const targetId of f.ids) {
    const target = await f.books.readChapter(book.bookId, targetId)
    const { proposal } = await f.store.create('a', { ...f.request, proposalId: randomUUID(), chapterId: targetId,
      expectedRevision: book.revision, expectedHash: target.hash, end: target.content.length, materialIds: [source] }, signal())
    const prompt = JSON.parse(generationPrompt(proposal))
    assert.equal(prompt.selectedMaterials[0].kind, 'chapter')
    assert.equal(prompt.selectedMaterials[0].content, prose)
    assert.equal(prompt.selectedMaterials[0].hash, hash(prose))
    assert.match(prompt.task, /material/)
    assert.match(prompt.sourceBoundary, /unknowns/)
    assert.match(prompt.sourceBoundary, /does not update/)
    assert.match(prompt.planningBoundary, /not events/)
    await f.store.checkpoint(book.bookId, proposal.request.proposalId, '## 新增建议\n后续可以渡河。', 'review', '', { state: 'unknown' }, 1)
    const candidate = await f.store.view(book.bookId, proposal.request.proposalId, false)
    assert.equal(candidate.context[0].kind, 'chapter')
    assert.equal((await f.books.readChapter(book.bookId, targetId)).content, target.content)
  }
  assert.equal((await f.books.readChapter(book.bookId, source)).content, prose)
  assert.equal((await f.books.readBook(book.bookId)).chapters.filter(item => item.kind === 'facts').length, 0)
})

test('prose sources expire candidates after external edits; empty prose, self, facts, voice and prose-to-prose context are refused', async t => {
  const f = await fixture(t), targetId = f.ids[2]
  const target = await f.books.readChapter(f.book.bookId, targetId)
  const request = { ...f.request, chapterId: targetId, expectedHash: target.hash, end: target.content.length }
  await assert.rejects(f.store.create('a', { ...request, materialIds: [f.request.chapterId] }, signal()), reason('material-empty'))
  await assert.rejects(f.store.create('a', { ...request, materialIds: [targetId] }, signal()), reason('invalid-material'))
  let book = await f.books.mutate({ operationId: randomUUID(), bookId: f.book.bookId, chapterId: f.request.chapterId,
    action: 'save', expectedRevision: f.book.revision, expectedHash: hash(''), content: '正文已有信息。', title: '', beforeChapterId: '' }, signal())
  const ids = []
  for (const kind of ['chapter', 'facts', 'voice']) {
    const chapterId = randomUUID(); ids.push(chapterId)
    const source = book.chapters.find(item => item.chapterId === f.request.chapterId)
    const content = kind === 'facts' ? JSON.stringify({ schemaVersion: 1, sourceChapterId: source.chapterId,
      sourceRevision: source.revision, sourceHash: source.hash, facts: [], coverage: 'selection' })
      : kind === 'voice' ? JSON.stringify({ schemaVersion: 1, voiceId: chapterId, sourceChapterId: source.chapterId,
        sourceRevision: source.revision, sourceHash: source.hash, channel: 'narration', characterId: '', sourceDescription: '自有正文',
        sample: '正文已有信息。', start: 0, end: '正文已有信息。'.length, authorized: true, authorizedAt: Date.now() }) : '受限文档'
    book = await f.books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId, ...(kind === 'chapter' ? {} : { kind }),
      action: 'create', expectedRevision: book.revision, expectedHash: '', content, title: kind, beforeChapterId: '',
      ...(kind === 'facts' ? { linkedChapterId: source.chapterId } : {}) }, signal())
  }
  const currentRequest = { ...request, expectedRevision: book.revision }
  const legacySource = await f.store.create('a', { ...currentRequest, proposalId: randomUUID(), materialIds: [ids[0]] }, signal())
  assert.equal(legacySource.proposal.context[0].kind, 'chapter')
  for (const id of ids.slice(1)) await assert.rejects(f.store.create('a', { ...currentRequest, materialIds: [id] }, signal()), reason('invalid-material'))
  await assert.rejects(f.store.create('a', { ...f.request, expectedRevision: book.revision, expectedHash: hash('正文已有信息。'), end: '正文已有信息。'.length,
    materialIds: [ids[0]] }, signal()), reason('invalid-material'))
  const { proposal } = await f.store.create('a', { ...currentRequest, materialIds: [f.request.chapterId] }, signal())
  await f.store.checkpoint(book.bookId, proposal.request.proposalId, '人物候选', 'review', '', { state: 'unknown' }, 1)
  await writeFile(join(f.root, 'novels', book.bookId, 'chapters', `${f.request.chapterId}.md`), '外部修改正文。')
  assert.equal((await f.store.view(book.bookId, proposal.request.proposalId, false)).state, 'expired')
  const view = await f.store.view(book.bookId, proposal.request.proposalId, false)
  await assert.rejects(f.store.decide({ bookId: book.bookId, proposalId: view.proposalId, expectedCandidateHash: view.candidateHash }, true, signal()), reason('proposal-stale'))
  await assert.rejects(f.store.create('a', { ...currentRequest, proposalId: randomUUID(), materialIds: [f.request.chapterId] }, signal()), reason('revision-conflict'))
})
