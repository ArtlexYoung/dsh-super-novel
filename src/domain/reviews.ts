import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { BookError, contentSchema, idSchema } from './books.js'
import type { ReviewIssue, ReviewRequest } from '../types.js'
export const reviewDimensions = ['continuity', 'character', 'causality', 'language'] as const
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const reviewRequestSchema = z.strictObject({ reviewId: idSchema, bookId: idSchema, chapterId: idSchema, proposalId: z.union([idSchema, z.literal('')]), expectedRevision: z.int().positive(), expectedHash: digest,
  start: z.int().nonnegative().optional(), end: z.int().positive().optional(), intentionalRepetitions: z.array(contentSchema.pipe(z.string().min(1).max(4000))).max(20).optional(),
  intentVersion: z.int().nonnegative().optional(), hardConstraints: contentSchema.pipe(z.string().max(16_384)).optional(), materialIds: z.array(idSchema).max(100).refine(ids => new Set(ids).size === ids.length).optional(),
  minCharacters: z.int().nonnegative().max(4_000_000), maxCharacters: z.int().nonnegative().max(4_000_000), minParagraphs: z.int().nonnegative().max(100_000), maxParagraphs: z.int().nonnegative().max(100_000) })
  .refine(value => (!value.maxCharacters || value.maxCharacters >= value.minCharacters) && (!value.maxParagraphs || value.maxParagraphs >= value.minParagraphs) &&
    (value.start === undefined && value.end === undefined || value.start !== undefined && value.end !== undefined && value.start < value.end))
export const issueInputSchema = z.strictObject({ dimension: z.enum(reviewDimensions), severity: z.enum(['warning', 'error']), message: contentSchema.pipe(z.string().trim().min(1).max(4000)), suggestion: contentSchema.pipe(z.string().max(4000)),
  quote: contentSchema.pipe(z.string().min(1).max(4000)), start: z.int().nonnegative(), end: z.int().positive(), references: z.array(z.string().max(100)).max(20) })
export const reviewOutputSchema = z.strictObject({ dimensions: z.array(z.strictObject({ dimension: z.enum(reviewDimensions), state: z.enum(['checked', 'unknown', 'degraded']) })).length(4), issues: z.array(issueInputSchema).max(100) })
  .refine(value => new Set(value.dimensions.map(item => item.dimension)).size === 4)
const usageSchema = z.discriminatedUnion('state', [z.strictObject({ state: z.literal('unknown') }), z.strictObject({ state: z.literal('reported'), inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative(), cacheReadTokens: z.int().nonnegative().optional(), cacheWriteTokens: z.int().nonnegative().optional(), totalTokens: z.int().nonnegative().optional(), reasoningTokens: z.int().nonnegative().optional() })])
export const reviewViewSchema = z.strictObject({ reviewId: idSchema, bookId: idSchema, chapterId: idSchema, proposalId: z.union([idSchema, z.literal('')]), textHash: digest,
  state: z.enum(['passed', 'issues', 'unknown', 'degraded', 'expired']), reason: z.string().max(100),
  issues: z.array(z.strictObject({ issueId: idSchema, dimension: z.enum(['mechanical', ...reviewDimensions]), severity: z.enum(['warning', 'error']), message: contentSchema.pipe(z.string().min(1).max(4000)), suggestion: contentSchema.pipe(z.string().max(4000)), quote: contentSchema.pipe(z.string().max(4000)), start: z.int().nonnegative(), end: z.int().nonnegative(), references: z.array(z.string().max(100)).max(20) })).max(1000),
  dimensions: z.array(z.strictObject({ dimension: z.enum(reviewDimensions), state: z.enum(['checked', 'unknown', 'degraded']) })).length(4), characters: z.int().nonnegative(), paragraphs: z.int().nonnegative(), createdAt: z.int().nonnegative(), elapsedMs: z.int().nonnegative(), usage: usageSchema })
export function mechanicalReview(text: string, request: ReviewRequest): { characters: number; paragraphs: number; issues: ReviewIssue[] } {
  const range = reviewRange(text, request), selected = text.slice(range.start, range.end)
  const characters = Array.from(selected).filter(item => !/\s/u.test(item)).length
  const paragraphs = selected.split(/\r?\n\s*\r?\n/u).filter(item => item.trim()).length
  const issues: ReviewIssue[] = []
  const add = (message: string, start = range.start, end = Math.min(range.end, range.start + 80), severity: 'error' | 'warning' = 'error'): void => { if (issues.length < 900) issues.push({ issueId: randomUUID(), dimension: 'mechanical', severity, message, suggestion: '', quote: text.slice(start, end), start, end, references: [] }) }
  if (!selected.trim()) add('empty-output')
  if (characters < request.minCharacters || (request.maxCharacters && characters > request.maxCharacters)) add('character-limit')
  if (paragraphs < request.minParagraphs || (request.maxParagraphs && paragraphs > request.maxParagraphs)) add('paragraph-limit')
  for (const match of selected.matchAll(/\[(?:TODO|TBD|待补充|待续写)\]|<placeholder>|```/giu)) add('placeholder', range.start + match.index, range.start + match.index + match[0].length)
  const seen = new Set<string>()
  for (const match of selected.matchAll(/[^\r\n]+/gu)) {
    const paragraph = match[0].trim()
    if (paragraph.length < 12 || (request.intentionalRepetitions ?? []).includes(paragraph)) continue
    if (seen.has(paragraph)) add('repeated-expression', range.start + match.index, range.start + match.index + match[0].length, 'warning')
    seen.add(paragraph)
  }
  return { characters, paragraphs, issues }
}
export function reviewRange(text: string, request: Pick<ReviewRequest, 'start' | 'end'>): { start: number; end: number } {
  const start = request.start ?? 0, end = request.end ?? text.length
  if (start > end || end > text.length || !contentSchema.safeParse(text.slice(0, start)).success || !contentSchema.safeParse(text.slice(end)).success) throw new BookError('invalid-range')
  return { start, end }
}
export function validateReviewEvidence(text: string, issues: z.infer<typeof issueInputSchema>[], validReferences: Set<string>): void {
  for (const issue of issues) if (issue.start >= issue.end || issue.end > text.length || text.slice(issue.start, issue.end) !== issue.quote || issue.references.some(id => !validReferences.has(id))) throw new BookError('invalid-evidence')
}
