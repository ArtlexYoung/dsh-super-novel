import { z } from 'zod'
import { contentSchema, idSchema, titleSchema } from './books.js'
export const evidenceSchema = z.strictObject({ chapterId: idSchema, revision: z.int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/), start: z.int().nonnegative(), end: z.int().positive(), quote: contentSchema.pipe(z.string().min(1).max(8000)) }).refine(value => value.end > value.start && value.quote.length === value.end - value.start)
const field = contentSchema.pipe(z.string().trim().min(1).max(2000))
export const timeSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('unknown') }), z.strictObject({ kind: z.literal('known'), label: z.string().trim().min(1).max(200), order: z.number().finite().min(-1_000_000).max(1_000_000) })])
export const changeSchema = z.strictObject({ characterId: idSchema, kind: z.enum(['location', 'injury', 'item', 'knowledge']), value: field })
export const eventSchema = z.strictObject({ eventId: idSchema, title: titleSchema, time: timeSchema, evidence: evidenceSchema, changes: z.array(changeSchema).max(100) })
export const foreshadowSchema = z.strictObject({ foreshadowId: idSchema, title: titleSchema, note: contentSchema.pipe(z.string().max(8000)), status: z.enum(['planned', 'planted', 'unresolved', 'resolved']), planted: evidenceSchema.optional(), resolved: evidenceSchema.optional() })
  .refine(value => value.status === 'planned' ? !value.planted && !value.resolved : !!value.planted && (value.status === 'resolved' ? !!value.resolved : !value.resolved))
export const saveStorySchema = z.strictObject({ workspaceId: z.string().regex(/^[a-f0-9]{64}$/), bookId: idSchema, operationId: idSchema, expectedVersion: z.int().nonnegative(), expectedRevision: z.int().positive(), event: eventSchema.optional(), foreshadow: foreshadowSchema.optional() })
  .refine(value => !!value.event !== !!value.foreshadow)
export const suggestStorySchema = z.strictObject({ workspaceId: z.string().regex(/^[a-f0-9]{64}$/), bookId: idSchema, chapterId: idSchema, proposalId: idSchema, expectedRevision: z.int().positive(), expectedHash: z.string().regex(/^[a-f0-9]{64}$/) })
const modelEvidence = z.strictObject({ start: z.int().nonnegative(), end: z.int().positive(), quote: contentSchema.pipe(z.string().min(1).max(8000)) })
export const storyOutputSchema = z.strictObject({ events: z.array(z.strictObject({ title: titleSchema, evidence: modelEvidence, changes: z.array(changeSchema).max(100) })).max(50),
  foreshadows: z.array(z.strictObject({ title: titleSchema, note: contentSchema.pipe(z.string().max(8000)), evidence: modelEvidence })).max(50) })
