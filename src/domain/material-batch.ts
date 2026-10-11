import { z } from 'zod'
import { BookError, chapterLinks, idSchema, json, materialKind, parseBook, type Book } from './books.js'
import type { BookSnapshot, ChapterSummary, MaterialBatchRequest } from '../types.js'

export const materialBatchSchema = z.strictObject({ workspaceId: z.string().regex(/^[a-f0-9]{64}$/), bookId: idSchema,
  expectedRevision: z.int().positive(), operationId: idSchema, chapterIds: z.array(idSchema).min(1).max(100),
  action: z.enum(['add-tags', 'link-chapter', 'archive']), tags: z.array(z.string().trim().min(1).max(80)).max(30), linkedChapterId: z.union([idSchema, z.literal('')]) })
  .refine(value => new Set(value.chapterIds).size === value.chapterIds.length && new Set(value.tags).size === value.tags.length &&
    (value.action === 'add-tags' ? value.tags.length > 0 && !value.linkedChapterId : value.action === 'link-chapter' ? !value.tags.length && !!value.linkedChapterId : !value.tags.length && !value.linkedChapterId))

/** Metadata-only, single-manifest batch. One invalid item rejects the entire operation. */
export function prepareMaterialBatch(view: BookSnapshot, input: MaterialBatchRequest): { next: Book; items: { before: ChapterSummary; after: ChapterSummary }[] } {
  const request = materialBatchSchema.parse(input)
  if (view.bookId !== request.bookId) throw new BookError('book-not-found')
  if (view.recoveryRequired) throw new BookError('recovery-required')
  if (view.schemaVersion < 2) throw new BookError('migration-required')
  if (view.revision !== request.expectedRevision) throw new BookError('revision-conflict')
  if (request.action === 'link-chapter' && !view.chapters.some(item => item.chapterId === request.linkedChapterId && (!item.kind || item.kind === 'chapter'))) throw new BookError('invalid-material')
  const { recoveryRequired: _, ...book } = view, next = parseBook(json(book), book.bookId), items = []
  for (const id of request.chapterIds) {
    const target = next.chapters.find(item => item.chapterId === id)
    if (!target || !materialKind(target.kind)) throw new BookError('invalid-material')
    if (target.status === 'trashed' || request.action !== 'archive' && target.status === 'archived') throw new BookError('material-unavailable')
    const before = { ...target }
    if (request.action === 'add-tags') target.tags = [...new Set([...(target.tags ?? []), ...request.tags])]
    if (request.action === 'link-chapter') { target.linkedChapterIds = [...new Set([...chapterLinks(target), request.linkedChapterId])]; delete target.linkedChapterId }
    if (request.action === 'archive') target.status = 'archived'
    items.push({ before, after: { ...target } })
  }
  next.revision++; parseBook(json(next), next.bookId)
  return { next, items }
}
