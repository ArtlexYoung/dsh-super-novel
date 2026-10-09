import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { BookSnapshot } from '../types.js'

export const idSchema = z.uuid()
export const titleSchema = z.string().trim().min(1).max(200).refine(value => !value.includes('\0') && Buffer.from(value, 'utf8').toString('utf8') === value)
export const contentSchema = z.string().refine(value => !value.includes('\0') && Buffer.from(value, 'utf8').toString('utf8') === value && Buffer.byteLength(value, 'utf8') <= 4 * 1024 * 1024, 'Invalid or oversized text')
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const documentKindSchema = z.enum(['chapter', 'seed', 'book-card', 'character', 'world', 'outline', 'chapter-outline', 'scene', 'facts', 'voice'])
export const sourceEvidenceSchema = z.strictObject({ chapterId: idSchema, revision: z.int().positive(), hash: digest, quote: contentSchema, start: z.int().nonnegative(), end: z.int().positive() }).refine(value => value.end > value.start && value.quote.length === value.end - value.start)
export const chapterSchema = z.strictObject({ chapterId: idSchema, title: titleSchema, revision: z.int().positive(), hash: digest,
  kind: documentKindSchema.optional(), linkedChapterId: idSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(30).optional(), aliases: z.array(titleSchema).max(30).optional(), favorite: z.boolean().optional(),
  status: z.enum(['active', 'inbox', 'archived', 'trashed']).optional(), linkedChapterIds: z.array(idSchema).max(1000).optional(), relatedMaterialIds: z.array(idSchema).max(1000).optional(), sourceEvidence: sourceEvidenceSchema.optional() })
export const bookSchema = z.strictObject({
  schemaVersion: z.union([z.literal(1), z.literal(2)]), bookId: idSchema, title: titleSchema,
  revision: z.int().positive(), chapters: z.array(chapterSchema).max(10_000),
}).refine(book => new Set(book.chapters.map(chapter => chapter.chapterId)).size === book.chapters.length &&
  book.chapters.every(item => (!item.tags || new Set(item.tags).size === item.tags.length) && (!item.aliases || new Set(item.aliases).size === item.aliases.length) &&
    (book.schemaVersion === 2 || [item.tags, item.aliases, item.favorite, item.status, item.linkedChapterIds, item.relatedMaterialIds, item.sourceEvidence].every(value => value === undefined)) &&
    (!item.status && !item.tags && !item.favorite && !item.aliases && !item.linkedChapterIds && !item.relatedMaterialIds && !item.sourceEvidence || materialKind(item.kind)) &&
    (!item.linkedChapterIds || new Set(item.linkedChapterIds).size === item.linkedChapterIds.length && item.linkedChapterIds.every(id => book.chapters.some(chapter => chapter.chapterId === id && (!chapter.kind || chapter.kind === 'chapter')))) &&
    (!item.sourceEvidence || book.chapters.some(source => source.chapterId === item.sourceEvidence!.chapterId && source.chapterId !== item.chapterId)) &&
    (!item.relatedMaterialIds || new Set(item.relatedMaterialIds).size === item.relatedMaterialIds.length && item.relatedMaterialIds.every(id => id !== item.chapterId && book.chapters.some(chapter => chapter.chapterId === id && materialKind(chapter.kind))))) &&
  book.chapters.every(item => !item.linkedChapterId || ((item.kind === 'chapter-outline' || item.kind === 'scene' || item.kind === 'facts') &&
    book.chapters.some(chapter => chapter.chapterId === item.linkedChapterId && (!chapter.kind || chapter.kind === 'chapter')))), 'Invalid document identity or chapter link')
export type Book = z.infer<typeof bookSchema>

const fileStateSchema = z.strictObject({ exists: z.boolean(), text: contentSchema })
export const transactionSourceSchema = z.strictObject({ kind: z.enum(['restore', 'conflict']), id: idSchema, requestHash: digest })
export const transactionSchema = z.strictObject({
  schemaVersion: z.literal(1), operationId: idSchema, bookId: idSchema,
  requestHash: digest, state: z.enum(['prepared', 'completed']),
  before: z.string().max(4 * 1024 * 1024), after: bookSchema,
  changes: z.array(z.strictObject({ chapterId: idSchema, before: fileStateSchema, after: contentSchema })).max(1),
  source: transactionSourceSchema.optional(),
})
export type Transaction = z.infer<typeof transactionSchema>

export class BookError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'BookError' }
}

export function hash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex') }
export function json(value: unknown): string { return JSON.stringify(value, null, 2) + '\n' }

export function parseBook(text: string, bookId: string): Book {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new BookError('invalid-format') }
  if (typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion !== 1 && value.schemaVersion !== 2) throw new BookError('unsupported-format')
  const result = bookSchema.safeParse(value)
  if (!result.success || result.data.bookId !== bookId) throw new BookError('invalid-format')
  return result.data
}

export function snapshot(book: Book, recoveryRequired = false): BookSnapshot {
  return { ...book, recoveryRequired }
}

export function materialKind(kind: string | undefined): boolean { return ['seed', 'book-card', 'character', 'world', 'outline', 'chapter-outline', 'scene'].includes(kind ?? '') }
export function availableDocument(item: { status?: string }): boolean { return !['archived', 'trashed'].includes(item.status ?? '') }
export function chapterLinks(item: { linkedChapterId?: string; linkedChapterIds?: readonly string[] }): string[] { return [...new Set([...(item.linkedChapterIds ?? []), ...(item.linkedChapterId ? [item.linkedChapterId] : [])])] }
