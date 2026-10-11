import { readdir } from 'node:fs/promises'
import { BookError, availableDocument, hash, idSchema, json } from '../domain/books.js'
import { parseFactDocument, validateFacts } from '../domain/facts.js'
import { BOOK_REVIEW_BYTES, bookReviewFingerprint, bookReviewPrompt, bookReviewScopeSchema, type BookReviewSnapshot } from '../domain/book-reviews.js'
import type { BookReviewPreview, BookReviewScope, BookReviewSource } from '../types.js'
import { BookFiles } from './book-files.js'
import { BookStore } from './book-store.js'
import { IntentStore } from './intent-store.js'
import { reviewRecordSchema } from './review-store.js'
import { StoryStore } from './story-store.js'

export interface BookReviewLimits { readonly reviewFiles: number; readonly reviewBytes: number }
export const BOOK_REVIEW_LIMITS = { reviewFiles: 100, reviewBytes: 16 * 1024 * 1024 }

/** Preview and execution share the same bounded, source-checked snapshot. */
export async function buildBookReviewContext(root: string, books: BookStore, input: BookReviewScope, signal: AbortSignal, limits: BookReviewLimits = BOOK_REVIEW_LIMITS): Promise<{ snapshot: BookReviewSnapshot; preview: BookReviewPreview }> {
  const request = bookReviewScopeSchema.parse(input)
  if (request.workspaceId !== hash(root)) throw new BookError('location-changed')
  signal.throwIfAborted()
  const book = await books.readBook(request.bookId), files = await BookFiles.at(root)
  if (book.recoveryRequired) throw new BookError('recovery-required')
  if (book.revision !== request.expectedRevision) throw new BookError('revision-conflict')
  const prose = book.chapters.filter(item => (!item.kind || item.kind === 'chapter') && availableDocument(item))
  if (request.storylineId && !book.storylines?.some(item => item.storylineId === request.storylineId)) throw new BookError('invalid-review-scope')
  const selected = request.storylineId ? prose.filter(item => item.structure?.storylineIds.includes(request.storylineId)) : prose.filter(item => request.chapterIds.includes(item.chapterId))
  if (selected.length < 2 || selected.length > 20 || !request.storylineId && selected.length !== request.chapterIds.length) throw new BookError('invalid-review-scope')
  const chapters: BookReviewSnapshot['chapters'] = [], sources: BookReviewSource[] = []
  let complete = true, coreBytes = 0
  const add = (kind: string, sourceId: string, title: string, state: BookReviewSource['state'], content: string): void => {
    if (sources.length >= 150) throw new BookError('context-too-large')
    sources.push({ kind, sourceId, title, state, content }); if (state === 'expired' || state === 'unavailable') complete = false
  }
  const attempt = async (kind: string, sourceId: string, title: string, fn: () => Promise<void>): Promise<void> => {
    try { await fn() } catch (error) { signal.throwIfAborted(); if (error instanceof BookError && ['location-changed', 'revision-conflict', 'recovery-required'].includes(error.code)) throw error; add(kind, sourceId, title, 'unavailable', error instanceof BookError ? error.code : 'invalid-format') }
  }
  const intents = await IntentStore.at(root, request.workspaceId, books)
  for (const item of selected) {
    signal.throwIfAborted()
    const source = await books.readChapter(book.bookId, item.chapterId)
    if (source.externallyModified || source.hash !== item.hash || source.book.revision !== book.revision) throw new BookError('revision-conflict')
    chapters.push({ chapterId: item.chapterId, title: item.title, revision: item.revision, hash: source.hash, content: source.content })
    coreBytes += Buffer.byteLength(source.content)
    if (coreBytes <= BOOK_REVIEW_BYTES) {
      if (item.structure) add('author-plan', item.chapterId, item.title, 'included', json(item.structure))
      await attempt('intent', item.chapterId, item.title, async () => {
        const intent = await intents.read(book.bookId, item.chapterId)
        add('intent', item.chapterId, item.title, intent.version ? 'included' : 'missing', intent.version ? json({ version: intent.version, hash: intent.hash, planOnly: true, intent: intent.intent }) : '')
      })
      const facts = book.chapters.filter(document => document.kind === 'facts' && document.linkedChapterId === item.chapterId && availableDocument(document))
      if (!facts.length) add('facts', item.chapterId, item.title, 'missing', '')
      if (facts.length > 1) add('facts', item.chapterId, item.title, 'unavailable', 'duplicate-fact-documents')
      else if (facts.length) await attempt('facts', facts[0]!.chapterId, item.title, async () => {
        const saved = await books.readChapter(book.bookId, facts[0]!.chapterId), document = parseFactDocument(saved.content)
        if (saved.externallyModified || document.sourceHash !== source.hash || document.sourceRevision !== item.revision || document.sourceChapterId !== item.chapterId) { add('facts', facts[0]!.chapterId, item.title, 'expired', 'fact-stale'); return }
        validateFacts(document, source.content)
        if (document.facts.some(fact => { const scope = fact.scope; return scope.kind === 'character' && !book.chapters.some(character => character.chapterId === scope.characterId && character.kind === 'character' && availableDocument(character)) })) throw new BookError('invalid-evidence')
        add('facts', facts[0]!.chapterId, item.title, 'included', json(document))
      })
    }
  }
  if (coreBytes <= BOOK_REVIEW_BYTES) {
    await attempt('story-state', book.bookId, 'Confirmed events and foreshadows in this range', async () => {
      const story = await (await StoryStore.at(root, request.workspaceId, books)).readRange(book.bookId, selected.map(item => item.chapterId), signal)
      const valid = { events: story.events.filter(item => item.state === 'valid'), foreshadows: story.foreshadows.filter(item => item.state === 'valid') }
      add('story-state', book.bookId, 'Confirmed events and foreshadows in this range', valid.events.length || valid.foreshadows.length ? 'included' : 'missing', json(valid))
      if (story.events.some(item => item.state === 'expired') || story.foreshadows.some(item => item.state === 'expired')) add('story-state', book.bookId, 'Expired events or foreshadows excluded', 'expired', 'story-state-expired')
    })
    await attempt('previous-reviews', book.bookId, 'Earlier chapter assessments', async () => {
      const folder = `novels/${book.bookId}/reviews`; let names: string[]
      try { names = (await readdir(await files.path(folder))).filter(name => idSchema.safeParse(name.replace(/\.json$/, '')).success && name.endsWith('.json')).sort() }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = []; else throw error }
      const latest = new Map<string, { time: number; id: string; content: string }>(); let bytes = 0
      for (const name of names.slice(0, limits.reviewFiles)) {
        signal.throwIfAborted()
        if (bytes >= limits.reviewBytes) { complete = false; break }
        try {
          const file = await files.read(`${folder}/${name}`, Math.min(32 * 1024 * 1024, limits.reviewBytes - bytes)); bytes += Buffer.byteLength(file.text)
          const record = reviewRecordSchema.parse(JSON.parse(file.text))
          if (record.workspaceId !== request.workspaceId || record.request.bookId !== book.bookId || record.request.reviewId !== name.slice(0, -5) || record.result.reviewId !== record.request.reviewId || hash(record.text) !== record.request.expectedHash) throw new BookError('invalid-format')
          const source = chapters.find(item => item.chapterId === record.request.chapterId)
          if (!source || record.request.proposalId) continue
          if (record.request.expectedHash !== source.hash || record.result.textHash !== source.hash) { add('previous-review', record.request.reviewId, source.title, 'expired', 'review-stale'); continue }
          if (record.result.issues.some(issue => record.text.slice(issue.start, issue.end) !== issue.quote)) throw new BookError('invalid-evidence')
          if ((latest.get(source.chapterId)?.time ?? -1) < record.result.createdAt) latest.set(source.chapterId, { time: record.result.createdAt, id: record.request.reviewId, content: json({ assessmentOnly: true, auxiliaryContextNotRevalidated: true, result: record.result }) })
        } catch (error) { signal.throwIfAborted(); add('previous-review', name.slice(0, -5), 'Unreadable earlier assessment', 'unavailable', error instanceof BookError ? error.code : 'invalid-format') }
      }
      if (names.length > limits.reviewFiles || bytes >= limits.reviewBytes) { complete = false; add('previous-reviews', book.bookId, 'Assessment scan incomplete', 'unavailable', 'review-scan-incomplete') }
      for (const source of selected) {
        const prior = latest.get(source.chapterId)
        add('previous-review', prior?.id ?? source.chapterId, source.title, prior ? 'included' : 'missing', prior?.content ?? '')
      }
    })
  }
  const positions = selected.map(item => prose.findIndex(chapter => chapter.chapterId === item.chapterId)), contiguous = positions.every((position, index) => !index || position === positions[index - 1]! + 1)
  const snapshot: BookReviewSnapshot = { bookId: book.bookId, focus: request.focus, storylineId: request.storylineId, chapters, sources, totalChapters: prose.length, contiguous, complete }
  const bytes = Buffer.byteLength(bookReviewPrompt(snapshot)), ready = bytes <= BOOK_REVIEW_BYTES
  if ((await books.readBook(book.bookId)).revision !== book.revision) throw new BookError('revision-conflict')
  for (const source of chapters) if (hash((await files.read(`novels/${book.bookId}/chapters/${source.chapterId}.md`)).text) !== source.hash) throw new BookError('revision-conflict')
  signal.throwIfAborted()
  return { snapshot, preview: { previewHash: bookReviewFingerprint(snapshot), bytes, maxBytes: BOOK_REVIEW_BYTES, maxCalls: 1, ready, complete, chapters: chapters.map(({ content: _content, ...item }) => item), sources: sources.map(item => ({ ...item, content: item.content.slice(0, 1200) })), totalChapters: prose.length, contiguous } }
}
