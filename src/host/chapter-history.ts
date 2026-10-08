import { z } from 'zod'
import { BookError, hash, idSchema, json } from '../domain/books.js'
import type { Transaction } from '../domain/books.js'
import type { BookSnapshot, ChapterHistorySummary, ChapterHistoryVersion, RestoreChapterRequest } from '../types.js'
import { BookStore } from './book-store.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const restoreSchema = z.strictObject({ operationId: idSchema, bookId: idSchema, chapterId: idSchema,
  sourceOperationId: idSchema, expectedSourceHash: digest, expectedRevision: z.int().positive(), expectedHash: digest })

function version(receipt: Transaction, chapterId: string): ChapterHistoryVersion[] {
  const change = receipt.changes.find(item => item.chapterId === chapterId)
  const chapter = receipt.after.chapters.find(item => item.chapterId === chapterId)
  if (!change || !chapter) return []
  return [{ operationId: receipt.operationId, chapterId, chapterRevision: chapter.revision,
    bookRevision: receipt.after.revision, hash: chapter.hash, content: change.after,
    source: receipt.source?.kind ?? 'save', sourceId: receipt.source?.id ?? '' }]
}

export class ChapterHistory {
  constructor(private readonly books: BookStore) {}

  async list(bookId: string, chapterId: string, beforeRevision: number): Promise<ChapterHistorySummary[]> {
    idSchema.parse(chapterId)
    z.int().nonnegative().parse(beforeRevision)
    const book = await this.books.readBook(bookId)
    if (book.recoveryRequired) throw new BookError('recovery-required')
    if (!book.chapters.some(item => item.chapterId === chapterId)) throw new BookError('chapter-not-found')
    const summaries: ChapterHistorySummary[] = []
    for await (const receipt of this.books.receipts(bookId)) {
      for (const { content: _content, ...item } of version(receipt, chapterId)) {
        if (item.bookRevision <= book.revision && (!beforeRevision || item.bookRevision < beforeRevision)) summaries.push(item)
      }
      summaries.sort((a, b) => b.bookRevision - a.bookRevision).splice(100)
    }
    return summaries
  }

  async read(bookId: string, chapterId: string, operationId: string): Promise<ChapterHistoryVersion> {
    idSchema.parse(chapterId)
    const book = await this.books.readBook(bookId)
    if (book.recoveryRequired) throw new BookError('recovery-required')
    if (!book.chapters.some(item => item.chapterId === chapterId)) throw new BookError('chapter-not-found')
    const receipt = (await this.books.receipt(bookId, operationId))[0]
    const result = receipt && version(receipt, chapterId)[0]
    if (!result || result.bookRevision > book.revision) throw new BookError('history-not-found')
    return result
  }

  async restore(input: RestoreChapterRequest, signal: AbortSignal): Promise<BookSnapshot> {
    const request = restoreSchema.parse(input)
    const selected = await this.read(request.bookId, request.chapterId, request.sourceOperationId)
    if (selected.hash !== request.expectedSourceHash) throw new BookError('operation-conflict')
    return await this.books.mutate({ operationId: request.operationId, bookId: request.bookId,
      expectedRevision: request.expectedRevision, action: 'save', chapterId: request.chapterId,
      title: '', beforeChapterId: '', content: selected.content, expectedHash: request.expectedHash }, signal,
      { kind: 'restore', id: request.sourceOperationId, requestHash: hash(json(request)) })
  }
}
