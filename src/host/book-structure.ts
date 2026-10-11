import { readdir } from 'node:fs/promises'
import { z } from 'zod'
import { BookError, availableDocument, chapterLinks, hash, idSchema, json, parseBook } from '../domain/books.js'
import { prepareBookStructure, structureCommitSchema, structureOf, structureRequestSchema } from '../domain/book-structure.js'
import type { BookOutline, BookSnapshot, BookStructurePreview, BookStructureQuery, BookStructureRequest, StructureQuery, StructureUndo, UpdateBookStructureRequest } from '../types.js'
import { BookFiles } from './book-files.js'
import { BookStore } from './book-store.js'
import { intentRecordSchema } from './intent-store.js'
import { structureImpacts } from './structure-impacts.js'

export const structureQuerySchema = z.strictObject({ workspaceId: z.string().regex(/^[a-f\d]{64}$/), bookId: idSchema })
const querySchema = structureQuerySchema.extend({ offset: z.int().min(0).max(10_000), query: z.string().max(4000),
  volumeId: z.union([idSchema, z.literal(''), z.literal('all')]), storylineId: z.union([idSchema, z.literal('all')]), progress: z.enum(['all', 'unwritten', 'draft', 'revise', 'complete']) })

/** Whole-book planning reads the existing intent and scene records; it never generates or duplicates them. */
export class BookStructureStore {
  private constructor(private readonly files: BookFiles, private readonly workspaceId: string, private readonly books: BookStore) {}
  static async at(root: string, workspaceId: string, books: BookStore): Promise<BookStructureStore> { return new BookStructureStore(await BookFiles.at(root), workspaceId, books) }
  private async book(request: BookStructureQuery, signal: AbortSignal): Promise<BookSnapshot> {
    structureQuerySchema.parse(request)
    signal.throwIfAborted()
    if (request.workspaceId !== this.workspaceId) throw new BookError('location-changed')
    const book = await this.books.readBook(request.bookId)
    if (book.recoveryRequired) throw new BookError('recovery-required')
    if (book.schemaVersion !== 3) throw new BookError('structure-migration-required')
    return book
  }
  async outline(input: StructureQuery, signal: AbortSignal): Promise<BookOutline> {
    const request = querySchema.parse(input), book = await this.book({ workspaceId: request.workspaceId, bookId: request.bookId }, signal)
    const prose = book.chapters.filter(item => !item.kind || item.kind === 'chapter'), term = request.query.trim().toLocaleLowerCase()
    const selected = prose.filter(item => (!term || `${item.title}\n${item.structure!.summary}`.toLocaleLowerCase().includes(term)) &&
      (request.volumeId === 'all' || item.structure!.volumeId === request.volumeId) && (request.storylineId === 'all' || item.structure!.storylineIds.includes(request.storylineId)) && (request.progress === 'all' || item.structure!.progress === request.progress))
    const items: BookOutline['items'][number][] = []; let unreadable = 0
    for (const chapter of selected.slice(request.offset, request.offset + 25)) {
      signal.throwIfAborted()
      let goal = '', viewpoint = ''
      try {
        const folder = `novels/${book.bookId}/intents/${chapter.chapterId}`
        let names: string[]
        try { names = await readdir(await this.files.path(folder)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = []; else throw error }
        const versions = names.filter(name => /^\d{8}\.json$/.test(name)).sort()
        if (versions.length > 100_000 || versions.some((name, at) => Number(name.slice(0, 8)) !== at + 1)) throw new BookError('invalid-format')
        if (versions.length) {
          const file = await this.files.read(`${folder}/${versions.at(-1)!}`, 256 * 1024), value = intentRecordSchema.parse(JSON.parse(file.text))
          if (value.request.workspaceId !== this.workspaceId || value.request.bookId !== book.bookId || value.request.chapterId !== chapter.chapterId || value.request.expectedVersion + 1 !== versions.length) throw new BookError('invalid-format')
          goal = value.request.intent.goal; viewpoint = value.request.intent.viewpoint
        }
      } catch (error) { if (signal.aborted) throw error; unreadable++ }
      items.push({ chapterId: chapter.chapterId, title: chapter.title, position: prose.findIndex(item => item.chapterId === chapter.chapterId) + 1,
        structure: chapter.structure!, goal, viewpoint, sceneIds: book.chapters.filter(item => item.kind === 'scene' && availableDocument(item) && chapterLinks(item).includes(chapter.chapterId)).map(item => item.chapterId) })
    }
    const current = await this.books.readBook(book.bookId)
    if (current.recoveryRequired || current.revision !== book.revision) throw new BookError('revision-conflict')
    signal.throwIfAborted()
    return { revision: book.revision, structureHash: hash(json(structureOf(book))), total: selected.length, items, complete: unreadable === 0, unreadable }
  }
  async preview(input: BookStructureRequest, signal: AbortSignal): Promise<BookStructurePreview> {
    const request = structureRequestSchema.parse(input), book = await this.book({ workspaceId: request.workspaceId, bookId: request.bookId }, signal), next = prepareBookStructure(book, request)
    const before = new Map(structureOf(book).chapters.map((item, at) => [item.chapterId, { item, at }]))
    const changes = structureOf(next).chapters.map((item, at) => {
      const source = before.get(item.chapterId)!, { chapterId, ...after } = item, { chapterId: _, ...original } = source.item
      return { chapterId, title: book.chapters.find(chapter => chapter.chapterId === chapterId)!.title, beforePosition: source.at + 1, afterPosition: at + 1, before: original, after }
    })
    const movedChapterIds = changes.filter(item => item.beforePosition !== item.afterPosition).map(item => item.chapterId)
    const impacts = await structureImpacts(this.files, this.workspaceId, book, movedChapterIds, signal)
    const current = await this.books.readBook(book.bookId)
    if (current.recoveryRequired || current.revision !== book.revision) throw new BookError('revision-conflict')
    signal.throwIfAborted()
    return { revision: book.revision, previewHash: hash(json({ request, changes, impacts })), changes, movedChapterIds, impacts }
  }
  async update(input: UpdateBookStructureRequest, signal: AbortSignal): Promise<BookSnapshot> {
    const request = structureCommitSchema.parse(input), { previewHash, ...plan } = request
    if (request.workspaceId !== this.workspaceId) throw new BookError('location-changed')
    signal.throwIfAborted()
    // Replays still validate the complete request in BookStore, without requiring an obsolete preview.
    if ((await this.books.receipt(request.bookId, request.operationId)).length) return await this.books.updateStructure(request, signal)
    const preview = await this.preview(plan, signal)
    if (preview.previewHash !== previewHash) throw new BookError('structure-preview-stale')
    return await this.books.updateStructure(request, signal)
  }
  async undo(input: BookStructureQuery, signal: AbortSignal): Promise<StructureUndo> {
    const request = structureQuerySchema.parse(input), book = await this.book(request, signal), id = book.lastStructureOperationId
    if (!id) return { available: false, operationId: '' }
    const records = await this.books.receipt(book.bookId, id), receipt = records[0]
    if (!receipt || !receipt.before || receipt.after.lastStructureOperationId !== id || json(structureOf(receipt.after)) !== json(structureOf(book))) return { available: false, operationId: id }
    const previous = parseBook(receipt.before, book.bookId)
    if (previous.schemaVersion !== 3) return { available: false, operationId: id }
    signal.throwIfAborted()
    return { available: true, operationId: id, structure: structureOf(previous) }
  }
}
