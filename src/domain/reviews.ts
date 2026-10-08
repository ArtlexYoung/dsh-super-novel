import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { BookError, contentSchema, idSchema } from './books.js'
import type { ReviewIssue, ReviewRequest } from '../types.js'
export const reviewDimensions = ['continuity', 'character', 'causality', 'language'] as const
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const reviewRequestSchema = z.strictObject({ reviewId: idSchema, bookId: idSchema, chapterId: idSchema, proposalId: z.union([idSchema, z.literal('')]), expectedRevision: z.int().positive(), expectedHash: digest,
  minCharacters: z.int().nonnegative().max(4_000_000), maxCharacters: z.int().nonnegative().max(4_000_000), minParagraphs: z.int().nonnegative().max(100_000), maxParagraphs: z.int().nonnegative().max(100_000) })
  .refine(value => (!value.maxCharacters || value.maxCharacters >= value.minCharacters) && (!value.maxParagraphs || value.maxParagraphs >= value.minParagraphs))
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
  const characters = Array.from(text).filter(item => !/\s/u.test(item)).length
  const paragraphs = text.split(/\r?\n\s*\r?\n/u).filter(item => item.trim()).length
  const issues: ReviewIssue[] = []
  const add = (message: string, start = 0, end = Math.min(text.length, 80)) => issues.push({ issueId: randomUUID(), dimension: 'mechanical', severity: 'error', message, suggestion: '', quote: text.slice(start, end), start, end, references: [] })
  if (!text.trim()) add('empty-output')
  if (characters < request.minCharacters || (request.maxCharacters && characters > request.maxCharacters)) add('character-limit')
  if (paragraphs < request.minParagraphs || (request.maxParagraphs && paragraphs > request.maxParagraphs)) add('paragraph-limit')
  for (const match of text.matchAll(/\[(?:TODO|TBD|待补充|待续写)\]|<placeholder>|```/giu)) add('placeholder', match.index, match.index + match[0].length)
  return { characters, paragraphs, issues }
}
export function validateReviewEvidence(text: string, issues: z.infer<typeof issueInputSchema>[], validReferences: Set<string>): void {
  for (const issue of issues) if (issue.start >= issue.end || issue.end > text.length || text.slice(issue.start, issue.end) !== issue.quote || issue.references.some(id => !validReferences.has(id))) throw new BookError('invalid-evidence')
}
