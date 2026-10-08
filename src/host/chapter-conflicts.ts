import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { BookError, contentSchema, hash, idSchema, json } from '../domain/books.js'
import type { BookSnapshot, ChapterConflict, PreserveConflictRequest, ResolveConflictRequest } from '../types.js'
import { BookFiles } from './book-files.js'
import { BookStore } from './book-store.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const preserveSchema = z.strictObject({ conflictId: idSchema, bookId: idSchema, chapterId: idSchema,
  baselineRevision: z.int().positive(), baselineHash: digest, localContent: contentSchema })
const conflictSchema = z.strictObject({ schemaVersion: z.literal(1), workspaceId: digest, requestHash: digest,
  request: preserveSchema, diskContent: contentSchema, diskRevision: z.int().positive(), diskHash: digest,
  createdAt: z.int().nonnegative() })
const resolveSchema = z.strictObject({ operationId: idSchema, bookId: idSchema, conflictId: idSchema,
  expectedRevision: z.int().positive(), expectedHash: digest, choice: z.enum(['disk', 'local', 'merged']), mergedContent: contentSchema })
type Conflict = z.infer<typeof conflictSchema>

/** Conflict records are immutable; resolution is another recoverable chapter save. */
export class ChapterConflicts {
  private constructor(private readonly files: BookFiles, private readonly books: BookStore, private readonly workspaceId: string) {}
  static async at(root: string, workspaceId: string, books: BookStore): Promise<ChapterConflicts> {
    return new ChapterConflicts(await BookFiles.at(root), books, workspaceId)
  }
  private folder(bookId: string): string { return join('novels', idSchema.parse(bookId), 'conflicts') }
  private path(bookId: string, conflictId: string): string { return join(this.folder(bookId), `${idSchema.parse(conflictId)}.json`) }
  private parse(text: string, bookId: string, conflictId: string): Conflict {
    let value: unknown
    try { value = JSON.parse(text) } catch { throw new BookError('invalid-format') }
    if (typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion !== 1) throw new BookError('unsupported-format')
    const result = conflictSchema.safeParse(value)
    if (!result.success || result.data.workspaceId !== this.workspaceId || result.data.request.bookId !== bookId || result.data.request.conflictId !== conflictId ||
      result.data.requestHash !== hash(json(result.data.request)) || result.data.diskHash !== hash(result.data.diskContent)) throw new BookError('invalid-format')
    return result.data
  }
  private async record(bookId: string, conflictId: string): Promise<Conflict> {
    const file = await this.files.read(this.path(bookId, conflictId), 32 * 1024 * 1024)
    if (!file.exists) throw new BookError('conflict-not-found')
    return this.parse(file.text, bookId, conflictId)
  }
  private async resolved(bookId: string): Promise<Set<string>> {
    const book = await this.books.readBook(bookId)
    if (book.recoveryRequired) throw new BookError('recovery-required')
    const ids = new Set<string>()
    for await (const receipt of this.books.receipts(bookId)) {
      if (receipt.source?.kind === 'conflict' && receipt.after.revision <= book.revision) ids.add(receipt.source.id)
    }
    return ids
  }
  private view(record: Conflict, resolved: Set<string>): ChapterConflict {
    return { ...record.request, diskContent: record.diskContent, diskRevision: record.diskRevision,
      diskHash: record.diskHash, createdAt: record.createdAt,
      resolved: resolved.has(record.request.conflictId) }
  }

  async preserve(input: PreserveConflictRequest, signal: AbortSignal): Promise<ChapterConflict> {
    const request = preserveSchema.parse(input)
    signal.throwIfAborted()
    await this.books.readBook(request.bookId)
    return await this.files.lock(join('novels', request.bookId, '.conflict.lock'), async () => {
      const file = await this.files.read(this.path(request.bookId, request.conflictId), 32 * 1024 * 1024)
      if (file.exists) {
        const record = this.parse(file.text, request.bookId, request.conflictId)
        if (record.requestHash !== hash(json(request))) throw new BookError('operation-conflict')
        return this.view(record, await this.resolved(request.bookId))
      }
      const chapter = await this.books.readChapter(request.bookId, request.chapterId)
      const record: Conflict = { schemaVersion: 1, workspaceId: this.workspaceId, request, requestHash: hash(json(request)),
        diskContent: chapter.content, diskRevision: chapter.book.revision, diskHash: chapter.hash, createdAt: Date.now() }
      const text = json(record)
      if (Buffer.byteLength(text, 'utf8') > 32 * 1024 * 1024) throw new BookError('too-large')
      this.parse(text, request.bookId, request.conflictId)
      await this.files.directory(this.folder(request.bookId))
      await this.files.replace(this.path(request.bookId, request.conflictId), text, { exists: false, text: '' })
      return this.view(record, await this.resolved(request.bookId))
    })
  }

  async list(bookId: string, chapterId: string): Promise<ChapterConflict[]> {
    idSchema.parse(chapterId)
    const resolved = await this.resolved(bookId)
    const folder = await this.files.path(this.folder(bookId))
    let names: string[]
    try { names = await readdir(folder) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const results: ChapterConflict[] = []
    for (const name of names) {
      if (!name.endsWith('.json') || !idSchema.safeParse(name.slice(0, -5)).success) continue
      const record = await this.record(bookId, name.slice(0, -5))
      if (record.request.chapterId === chapterId) results.push(this.view(record, resolved))
    }
    return results.sort((a, b) => b.createdAt - a.createdAt)
  }

  async resolve(input: ResolveConflictRequest, signal: AbortSignal): Promise<BookSnapshot> {
    const request = resolveSchema.parse(input)
    if (request.choice !== 'merged' && request.mergedContent) throw new BookError('invalid-request')
    return await this.files.lock(join('novels', request.bookId, '.conflict.lock'), async () => {
      signal.throwIfAborted()
      const record = await this.record(request.bookId, request.conflictId)
      const replay = (await this.books.receipt(request.bookId, request.operationId))[0]
      if (!replay && (await this.resolved(request.bookId)).has(request.conflictId)) throw new BookError('conflict-resolved')
      if (!replay && request.choice === 'disk' && request.expectedHash !== record.diskHash) throw new BookError('revision-conflict')
      const content = request.choice === 'disk' ? record.diskContent : request.choice === 'local' ? record.request.localContent : request.mergedContent
      return await this.books.mutate({ operationId: request.operationId, bookId: request.bookId,
        expectedRevision: request.expectedRevision, action: 'save', chapterId: record.request.chapterId,
        title: '', beforeChapterId: '', content, expectedHash: request.expectedHash }, signal,
        { kind: 'conflict', id: request.conflictId, requestHash: hash(json(request)) })
    })
  }
}
