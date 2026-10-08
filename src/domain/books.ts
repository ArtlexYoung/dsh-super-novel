import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { BookSnapshot } from '../types.js'

export const idSchema = z.uuid()
export const titleSchema = z.string().trim().min(1).max(200).refine(value => !value.includes('\0') && Buffer.from(value, 'utf8').toString('utf8') === value)
export const contentSchema = z.string().refine(value => !value.includes('\0') && Buffer.from(value, 'utf8').toString('utf8') === value && Buffer.byteLength(value, 'utf8') <= 4 * 1024 * 1024, 'Invalid or oversized text')
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const documentKindSchema = z.enum(['chapter', 'seed', 'book-card', 'character', 'world', 'outline', 'chapter-outline', 'scene', 'facts', 'voice'])
export const chapterSchema = z.strictObject({ chapterId: idSchema, title: titleSchema, revision: z.int().positive(), hash: digest,
  kind: documentKindSchema.optional(), linkedChapterId: idSchema.optional() })
export const bookSchema = z.strictObject({
  schemaVersion: z.literal(1), bookId: idSchema, title: titleSchema,
  revision: z.int().positive(), chapters: z.array(chapterSchema).max(10_000),
}).refine(book => new Set(book.chapters.map(chapter => chapter.chapterId)).size === book.chapters.length &&
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
  if (typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion !== 1) throw new BookError('unsupported-format')
  const result = bookSchema.safeParse(value)
  if (!result.success || result.data.bookId !== bookId) throw new BookError('invalid-format')
  return result.data
}

export function snapshot(book: Book, recoveryRequired = false): BookSnapshot {
  return { ...book, recoveryRequired }
}
