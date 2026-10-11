import { z } from 'zod'
import { BookError, chapterStructureSchema, idSchema, json, parseBook, storylineSchema, volumeSchema, type Book } from './books.js'
import type { BookSnapshot, BookStructure, BookStructureRequest } from '../types.js'

export const structureSchema = z.strictObject({ volumes: z.array(volumeSchema).max(1000), storylines: z.array(storylineSchema).max(1000), chapters: z.array(chapterStructureSchema.safeExtend({ chapterId: idSchema })).max(10_000) })
export const structureRequestSchema = z.strictObject({ workspaceId: z.string().regex(/^[a-f\d]{64}$/), bookId: idSchema, expectedRevision: z.int().positive(), operationId: idSchema, structure: structureSchema })
export const structureCommitSchema = structureRequestSchema.extend({ previewHash: z.string().regex(/^[a-f\d]{64}$/) })

export function structureOf(book: Pick<BookSnapshot, 'schemaVersion' | 'chapters' | 'volumes' | 'storylines'>): BookStructure {
  if (book.schemaVersion !== 3) throw new BookError('structure-migration-required')
  return { volumes: structuredClone(book.volumes ?? []), storylines: structuredClone(book.storylines ?? []), chapters: book.chapters.filter(item => !item.kind || item.kind === 'chapter').map(item => ({ chapterId: item.chapterId, ...structuredClone(item.structure!) })) }
}

/** Replace only prose slots. Material order, stable identities and all file bytes stay unchanged. */
export function prepareBookStructure(view: BookSnapshot, input: BookStructureRequest): Book {
  const request = structureRequestSchema.parse(input)
  if (view.bookId !== request.bookId) throw new BookError('book-not-found')
  if (view.recoveryRequired) throw new BookError('recovery-required')
  if (view.schemaVersion !== 3) throw new BookError('structure-migration-required')
  if (view.revision !== request.expectedRevision) throw new BookError('revision-conflict')
  const prose = view.chapters.filter(item => !item.kind || item.kind === 'chapter'), ids = new Set(request.structure.chapters.map(item => item.chapterId))
  if (ids.size !== prose.length || ids.size !== request.structure.chapters.length || prose.some(item => !ids.has(item.chapterId))) throw new BookError('invalid-structure')
  const { recoveryRequired: _, ...raw } = view, next = parseBook(json(raw), view.bookId), sources = new Map(next.chapters.map(item => [item.chapterId, item]))
  const ordered = request.structure.chapters.map(item => {
    const { chapterId, ...structure } = item, chapter = sources.get(chapterId)!
    return { ...chapter, structure }
  })
  let index = 0
  next.chapters = next.chapters.map(item => !item.kind || item.kind === 'chapter' ? ordered[index++]! : item)
  next.volumes = structuredClone(request.structure.volumes); next.storylines = structuredClone(request.structure.storylines)
  next.lastStructureOperationId = request.operationId; next.revision++
  try { return parseBook(json(next), next.bookId) } catch { throw new BookError('invalid-structure') }
}
