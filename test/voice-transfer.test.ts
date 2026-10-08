import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BookStore } from '../lib/host/book-store.js'
import { BookTransfer } from '../lib/host/book-transfer.js'
import { VoiceStore } from '../lib/host/voice-store.js'
import { ProposalStore } from '../lib/host/proposal-store.js'
import { ReviewStore } from '../lib/host/review-store.js'
import { generationPrompt } from '../lib/domain/proposals.js'
import { exportDocuments, importDocuments } from '../lib/domain/transfer.js'
import { hash } from '../lib/domain/books.js'
const signal = () => new AbortController().signal
const reason = code => error => error.code === code
async function fixture(t, hooks = {}) {
  await mkdir('.test-output', { recursive: true }); const root = await mkdtemp(resolve('.test-output/voice-transfer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const books = await BookStore.at(root, hooks), transfer = await BookTransfer.at(root, books), voices = new VoiceStore(books)
  return { root, books, transfer, voices }
}
test('import preview is pure, headings preserve fenced content and exports roundtrip exactly', async t => {
  const f = await fixture(t), request = { operationId: randomUUID(), title: '书', text: '\ufeff开头\r\n# 第一章\r\n正文🙂\r\n```\n# fenced\n```\n# 第二章\n尾声\n', mode: 'headings' }
  const preview = f.transfer.preview(request); assert.equal(preview.chapters.length, 3); assert.equal(preview.analysis, 'not-analyzed')
  assert.deepEqual(await readdir(f.root), [])
  const book = await f.transfer.import(request, signal()), result = await f.transfer.export(book.bookId, book.chapters.map(item => item.chapterId))
  const documents = importDocuments({ ...request, text: result.text, mode: 'archive' })
  assert.equal(documents.map(item => item.content).join(''), request.text)
  assert.equal((await f.transfer.import(request, signal())).revision, book.revision)
  await assert.rejects(f.transfer.import({ ...request, title: 'changed' }, signal()), reason('operation-conflict'))
  const imported = await f.transfer.import({ ...request, operationId: randomUUID(), text: result.text, mode: 'archive' }, signal())
  for (let i = 0; i < book.chapters.length; i++) assert.equal((await f.books.readChapter(book.bookId, book.chapters[i].chapterId)).content, (await f.books.readChapter(imported.bookId, imported.chapters[i].chapterId)).content)
})
test('malformed, future, damaged and oversized imports fail without creating a book', async t => {
  const f = await fixture(t), request = { operationId: randomUUID(), title: '书', text: '', mode: 'archive' }
  for (const text of ['bad', '<!-- dsh-super-novel-export {"schemaVersion":2} -->\n', exportDocuments('书', [{ title: '章', content: '字' }]).replace('字', '坏')]) assert.throws(() => f.transfer.preview({ ...request, text }))
  assert.throws(() => f.transfer.preview({ ...request, mode: 'single', text: 'x'.repeat(8 * 1024 * 1024 + 1) }))
  assert.throws(() => f.transfer.preview({ ...request, mode: 'single', text: '\0' }))
  assert.deepEqual(await f.books.list(), [])
})
test('interrupted import resumes via ordinary book recovery without duplicate chapters', async t => {
  let enabled = false, seen = 0
  const f = await fixture(t, { afterStage(stage) { if (enabled && stage === 'completed' && ++seen === 1) throw new Error('interruption') } })
  const request = { operationId: randomUUID(), title: '书', text: '# 第一章\n一\n# 第二章\n二', mode: 'headings' }
  enabled = true; await assert.rejects(f.transfer.import(request, signal()), /interruption/)
  enabled = false
  const clean = await BookStore.at(f.root)
  if ((await clean.readBook(request.operationId)).recoveryRequired) await clean.recover(request.operationId, signal())
  const book = await (await BookTransfer.at(f.root, clean)).import(request, signal())
  assert.equal(book.chapters.length, 2)
  assert.equal((await (await BookTransfer.at(f.root, clean)).import(request, signal())).revision, book.revision)
})
test('authorized voice is opt-in, keeps narration separate, expires and can be revoked', async t => {
  const f = await fixture(t), request = { operationId: randomUUID(), title: '书', text: '风，风。慢一点。', mode: 'single' }
  let book = await f.transfer.import(request, signal()); const chapterId = book.chapters[0].chapterId
  const authorization = { operationId: randomUUID(), bookId: book.bookId, expectedRevision: book.revision, sourceChapterId: chapterId, expectedHash: hash(request.text), start: 0, end: request.text.length, channel: 'narration', characterId: '', sourceDescription: '作者自有正文', authorized: true }
  await assert.rejects(f.voices.authorize({ ...authorization, authorized: false }, signal()))
  book = await f.voices.authorize(authorization, signal()); assert.equal((await f.voices.authorize(authorization, signal())).revision, book.revision)
  const [voice] = await f.voices.list(book.bookId); assert.equal(voice.state, 'active')
  const proposals = await ProposalStore.at(f.root, hash(f.root), f.books)
  const generation = { proposalId: randomUUID(), bookId: book.bookId, chapterId, expectedRevision: book.revision, expectedHash: hash(request.text), mode: 'continue', instruction: '继续', materials: '', start: request.text.length, end: request.text.length }
  const plain = await proposals.create('a', generation, signal()); assert(!generationPrompt(plain.proposal).includes('authorVoices'))
  const selected = await proposals.create('a', { ...generation, proposalId: randomUUID(), voiceIds: [voice.voiceId] }, signal())
  assert.equal(JSON.parse(generationPrompt(selected.proposal)).authorVoices[0].channel, 'narration')
  await proposals.checkpoint(book.bookId, selected.proposal.request.proposalId, '尾声', 'review', '', { state: 'unknown' }, 0)
  book = await f.voices.revoke(book.bookId, voice.voiceId, book.revision, voice.hash, randomUUID(), signal())
  assert.equal((await f.voices.read(book.bookId, voice.voiceId)).state, 'revoked')
  assert.equal((await proposals.view(book.bookId, selected.proposal.request.proposalId, false)).state, 'expired')
  await assert.rejects(f.voices.selected(book.bookId, [voice.voiceId]), reason('voice-unavailable'))
  await assert.rejects(f.transfer.export(book.bookId, [voice.voiceId]), reason('invalid-material'))
})
test('voice cannot cite another book, stale prose or a missing dialogue character', async t => {
  const f = await fixture(t)
  const book = await f.transfer.import({ operationId: randomUUID(), title: '书', text: '原文', mode: 'single' }, signal())
  const request = { operationId: randomUUID(), bookId: book.bookId, expectedRevision: book.revision, sourceChapterId: book.chapters[0].chapterId, expectedHash: hash('原文'), start: 0, end: 2, channel: 'dialogue', characterId: randomUUID(), sourceDescription: '自有', authorized: true }
  await assert.rejects(f.voices.authorize(request, signal()), reason('invalid-material'))
  await f.voices.authorize({ ...request, channel: 'narration', characterId: '' }, signal())
  await writeFile(join(f.root, 'novels', book.bookId, 'chapters', `${book.chapters[0].chapterId}.md`), '新稿')
  assert.equal((await f.voices.list(book.bookId))[0].state, 'expired')
  await assert.rejects(f.voices.authorize({ ...request, operationId: randomUUID(), channel: 'narration', characterId: '' }, signal()), reason('revision-conflict'))
  await assert.rejects(f.voices.read(randomUUID(), request.operationId), reason('book-not-found'))
})
test('dialogue authorization reaches isolated review and preserves an intentional rough expression', async t => {
  const f = await fixture(t)
  let book = await f.transfer.import({ operationId: randomUUID(), title: '书', text: '走，走。甭磨叽！', mode: 'single' }, signal())
  const chapterId = book.chapters[0].chapterId, characterId = randomUUID()
  book = await f.books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId: characterId, expectedRevision: book.revision, action: 'create', kind: 'character', title: '船夫', content: '船夫说话直白。', expectedHash: '', beforeChapterId: '' }, signal())
  book = await f.voices.authorize({ operationId: randomUUID(), bookId: book.bookId, expectedRevision: book.revision, sourceChapterId: chapterId, expectedHash: hash('走，走。甭磨叽！'), start: 0, end: 8, channel: 'dialogue', characterId, sourceDescription: '作者自有对白', authorized: true }, signal())
  const [voice] = await f.voices.list(book.bookId), proposals = await ProposalStore.at(f.root, hash(f.root), f.books)
  const { proposal } = await proposals.create('a', { proposalId: randomUUID(), bookId: book.bookId, chapterId, expectedRevision: book.revision, expectedHash: hash('走，走。甭磨叽！'), mode: 'draft', instruction: '写对白', materials: '船夫说话直白。', start: 0, end: 8, voiceIds: [voice.voiceId] }, signal())
  await proposals.checkpoint(book.bookId, proposal.request.proposalId, '走，走。甭磨叽！', 'review', '', { state: 'unknown' }, 0)
  const reviews = await ReviewStore.at(f.root, hash(f.root), f.books)
  const view = await reviews.run({ reviewId: randomUUID(), bookId: book.bookId, chapterId, proposalId: proposal.request.proposalId, expectedRevision: book.revision, expectedHash: hash('走，走。甭磨叽！'), minCharacters: 0, maxCharacters: 0, minParagraphs: 0, maxParagraphs: 0 }, async (prompt, system) => {
    const context = JSON.parse(JSON.parse(prompt).context)
    assert.equal(context.voices[0].characterId, characterId); assert.equal(context.voices[0].sample, '走，走。甭磨叽！')
    assert(system.includes('deliberate repetition'))
    return { replacement: JSON.stringify({ dimensions: ['continuity', 'character', 'causality', 'language'].map(dimension => ({ dimension, state: 'checked' })), issues: [] }), complete: true, reason: '', usage: { state: 'unknown' } }
  }, signal())
  assert.equal(view.state, 'passed')
})
