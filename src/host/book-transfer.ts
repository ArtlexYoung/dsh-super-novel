import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { BookError, hash, idSchema, json } from '../domain/books.js'
import { exportDocuments, importDocuments, importRequestSchema } from '../domain/transfer.js'
import type { BookSnapshot, ExportText, ImportPreview, ImportRequest } from '../types.js'
import { BookFiles } from './book-files.js'
import { BookStore } from './book-store.js'
const journalSchema = z.strictObject({ schemaVersion: z.literal(1), request: importRequestSchema, requestHash: z.string(), chapterIds: z.array(idSchema).min(1).max(10_000), operationIds: z.array(idSchema).min(1).max(10_000) })
export class BookTransfer {
  private constructor(private readonly files: BookFiles, private readonly books: BookStore) {}
  static async at(root: string, books: BookStore): Promise<BookTransfer> { return new BookTransfer(await BookFiles.at(root), books) }
  preview(input: ImportRequest): ImportPreview {
    const request = importRequestSchema.parse(input), documents = importDocuments(request)
    return { title: request.title, chapters: documents.map(item => ({ title: item.title, characters: Array.from(item.content).length, kind: item.kind })), bytes: Buffer.byteLength(request.text, 'utf8'), analysis: 'not-analyzed' }
  }
  async import(input: ImportRequest, signal: AbortSignal): Promise<BookSnapshot> {
    const request = importRequestSchema.parse(input), documents = importDocuments(request)
    signal.throwIfAborted()
    await this.files.directory(join('novels', 'imports'))
    return await this.files.lock(join('novels', 'imports', `.${request.operationId}.lock`), async () => {
      const path = join('novels', 'imports', `${request.operationId}.json`), before = await this.files.read(path, 32 * 1024 * 1024)
      let journal: z.infer<typeof journalSchema>
      if (before.exists) {
        let value: unknown; try { value = JSON.parse(before.text) } catch { throw new BookError('invalid-format') }
        if (typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion !== 1) throw new BookError('unsupported-format')
        journal = journalSchema.parse(value)
        if (journal.requestHash !== hash(json(request)) || hash(json(journal.request)) !== journal.requestHash) throw new BookError('operation-conflict')
        if (journal.chapterIds.length !== documents.length || journal.operationIds.length !== documents.length || new Set(journal.chapterIds).size !== documents.length || new Set(journal.operationIds).size !== documents.length) throw new BookError('invalid-format')
      } else {
        journal = { schemaVersion: 1, request, requestHash: hash(json(request)), chapterIds: documents.map(() => randomUUID()), operationIds: documents.map(() => randomUUID()) }
        const text = json(journal); if (Buffer.byteLength(text, 'utf8') > 32 * 1024 * 1024) throw new BookError('too-large')
        await this.files.replace(path, text, before)
      }
      await this.books.createBook({ operationId: request.operationId, title: request.title }, signal)
      for (let i = 0; i < documents.length; i++) {
        signal.throwIfAborted()
        const document = documents[i]!, receipt = (await this.books.receipt(request.operationId, journal.operationIds[i]!))[0]
        if (!receipt && (await this.books.readBook(request.operationId)).revision !== i + 1) throw new BookError('revision-conflict')
        const expectedRevision = receipt ? receipt.after.revision - 1 : (await this.books.readBook(request.operationId)).revision
        await this.books.mutate({ operationId: journal.operationIds[i]!, bookId: request.operationId, chapterId: journal.chapterIds[i]!, expectedRevision,
          action: 'create', title: document.title, content: document.content, kind: document.kind, expectedHash: '', beforeChapterId: '' }, signal)
      }
      return await this.books.readBook(request.operationId)
    })
  }
  async export(bookId: string, chapterIds: readonly string[]): Promise<ExportText> {
    z.array(idSchema).min(1).max(10_000).refine(ids => new Set(ids).size === ids.length).parse(chapterIds)
    const book = await this.books.readBook(bookId), documents = []
    for (const id of chapterIds) {
      const item = book.chapters.find(item => item.chapterId === id)
      if (!item || item.kind === 'facts' || item.kind === 'voice') throw new BookError('invalid-material')
      const chapter = await this.books.readChapter(bookId, id)
      if (chapter.externallyModified || chapter.book.revision !== book.revision) throw new BookError('revision-conflict')
      documents.push({ title: item.title, content: chapter.content, kind: item.kind })
    }
    if ((await this.books.readBook(bookId)).revision !== book.revision) throw new BookError('revision-conflict')
    return { title: book.title, text: exportDocuments(book.title, documents) }
  }
}
