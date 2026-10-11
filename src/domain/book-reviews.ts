import { z } from 'zod'
import { BookError, contentSchema, hash, idSchema, json } from './books.js'
import type { BookReviewDimension, BookReviewView } from '../types.js'

export const BOOK_REVIEW_BYTES = 256 * 1024
export const bookReviewDimensions = ['promise', 'character', 'causality', 'repetition', 'pacing'] as const
const digest = z.string().regex(/^[a-f0-9]{64}$/), text = contentSchema.pipe(z.string().max(4000)), required = text.pipe(z.string().trim().min(1))
export const bookReviewScopeSchema = z.strictObject({ workspaceId: digest, bookId: idSchema, expectedRevision: z.int().positive(),
  chapterIds: z.array(idSchema).max(20).refine(ids => new Set(ids).size === ids.length), storylineId: z.union([idSchema, z.literal('')]), focus: text })
  .refine(value => value.storylineId ? !value.chapterIds.length : value.chapterIds.length >= 2)
export const bookReviewRequestSchema = bookReviewScopeSchema.safeExtend({ reviewId: idSchema, previewHash: digest, maxCalls: z.literal(1) })
export const bookReviewSourceSchema = z.strictObject({ kind: z.string().max(100), sourceId: z.string().max(100), title: z.string().max(200), state: z.enum(['included', 'missing', 'expired', 'unavailable']), content: contentSchema })
export const bookReviewSnapshotSchema = z.strictObject({ bookId: idSchema, focus: text, storylineId: z.union([idSchema, z.literal('')]),
  chapters: z.array(z.strictObject({ chapterId: idSchema, title: z.string().max(200), revision: z.int().positive(), hash: digest, content: contentSchema })).min(2).max(20),
  sources: z.array(bookReviewSourceSchema).max(150), totalChapters: z.int().min(2).max(10_000), contiguous: z.boolean(), complete: z.boolean() })
export type BookReviewSnapshot = z.infer<typeof bookReviewSnapshotSchema>
const evidenceInput = z.strictObject({ chapterId: idSchema, start: z.int().nonnegative(), end: z.int().positive(), quote: required })
export const bookIssueInputSchema = z.strictObject({ dimension: z.enum(bookReviewDimensions), severity: z.enum(['warning', 'error']), message: required, suggestion: required, impact: text, authorQuestion: text,
  targetChapterId: idSchema, evidence: z.array(evidenceInput).min(2).max(6) })
const dimensionsSchema = z.array(z.strictObject({ dimension: z.enum(bookReviewDimensions), state: z.enum(['checked', 'unknown', 'degraded']) })).length(5)
  .refine(values => new Set(values.map(value => value.dimension)).size === 5)
export const bookReviewOutputSchema = z.strictObject({ dimensions: dimensionsSchema, issues: z.array(bookIssueInputSchema).max(30), unknowns: z.array(text).max(20) })
const evidenceSchema = evidenceInput.extend({ revision: z.int().positive(), hash: digest })
const usageSchema = z.discriminatedUnion('state', [z.strictObject({ state: z.literal('unknown') }), z.strictObject({ state: z.literal('reported'), inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative(), cacheReadTokens: z.int().nonnegative().optional(), cacheWriteTokens: z.int().nonnegative().optional(), totalTokens: z.int().nonnegative().optional(), reasoningTokens: z.int().nonnegative().optional() })])
export const bookReviewResultSchema = z.strictObject({ dimensions: dimensionsSchema, issues: z.array(bookIssueInputSchema.omit({ evidence: true }).extend({ issueId: idSchema, evidence: z.array(evidenceSchema).min(2).max(6) })).max(30), unknowns: z.array(text).max(20), reason: z.string().max(100), elapsedMs: z.int().nonnegative(), usage: usageSchema, calls: z.int().min(0).max(1) })
export const bookReviewDecisionSchema = z.strictObject({ workspaceId: digest, bookId: idSchema, reviewId: idSchema, issueId: idSchema, resultHash: digest, operationId: idSchema, action: z.enum(['confirm', 'dismiss']) })
export const bookReviewRecordSchema = z.strictObject({ format: z.literal('super-novel-book-review'), version: z.literal(1), request: bookReviewRequestSchema, snapshot: bookReviewSnapshotSchema,
  stage: z.enum(['started', 'completed']), createdAt: z.int().nonnegative(), result: bookReviewResultSchema, decisions: z.array(bookReviewDecisionSchema).max(30) })
export type BookReviewRecord = z.infer<typeof bookReviewRecordSchema>

export function validateBookIssues(snapshot: BookReviewSnapshot, issues: readonly z.infer<typeof bookIssueInputSchema>[]): void {
  for (const issue of issues) {
    if (new Set(issue.evidence.map(item => item.chapterId)).size < 2 || !issue.evidence.some(item => item.chapterId === issue.targetChapterId)) throw new BookError('invalid-evidence')
    for (const item of issue.evidence) {
      const source = snapshot.chapters.find(chapter => chapter.chapterId === item.chapterId)
      if (!source || item.start >= item.end || item.end > source.content.length || source.content.slice(item.start, item.end) !== item.quote || !contentSchema.safeParse(source.content.slice(0, item.start)).success || !contentSchema.safeParse(source.content.slice(item.end)).success) throw new BookError('invalid-evidence')
    }
  }
}
export function bookReviewState(dimensions: readonly { dimension: BookReviewDimension; state: string }[], issues: number): BookReviewView['state'] {
  return dimensions.some(item => item.state === 'unknown') ? 'unknown' : dimensions.some(item => item.state === 'degraded') ? 'degraded' : issues ? 'issues' : 'checked'
}
export function bookReviewPrompt(snapshot: BookReviewSnapshot): string {
  return json({ task: 'review-book-range', focus: snapshot.focus, chapters: snapshot.chapters, supportingSources: snapshot.sources, coverage: { selected: snapshot.chapters.length, total: snapshot.totalChapters, contiguous: snapshot.contiguous, complete: snapshot.complete },
    instructions: 'Review only these saved chapters. Plans and earlier assessments are auxiliary, not happened facts. Preserve reader/character knowledge scopes. Never conclude anything about omitted chapters. Evidence offsets use UTF-16. Every issue needs exact quotations from at least two distinct supplied chapters and a targetChapterId among its evidence. Suggest a local change and its effect; identify author judgment separately. Use unknown or degraded when evidence is missing; checked means this scoped check completed, not literary quality.',
    format: { dimensions: bookReviewDimensions.map(dimension => ({ dimension, state: 'checked|unknown|degraded' })), issues: [{ dimension: 'causality', severity: 'warning|error', message: 'Problem', suggestion: 'Local suggestion', impact: 'Effect on related chapters', authorQuestion: 'What the author needs to decide', targetChapterId: 'chapter UUID', evidence: [{ chapterId: 'chapter UUID', start: 0, end: 1, quote: 'Exact text' }] }], unknowns: ['Unverifiable aspects or omitted context'] } })
}
export const bookReviewFingerprint = (snapshot: BookReviewSnapshot): string => hash(json(snapshot))
/** Hash the schema-normalized result so creation and disk rereads share field order. */
export const bookReviewResultHash = (result: z.infer<typeof bookReviewResultSchema>): string => hash(json(bookReviewResultSchema.parse(result)))
