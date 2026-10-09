import { z } from 'zod'
import { contentSchema, idSchema } from './books.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const field = contentSchema.pipe(z.string().max(4000))
export const intentSchema = z.strictObject({ goal: field, obstacle: field, choice: field, cost: field, outcome: field, viewpoint: field, hardConstraints: contentSchema.pipe(z.string().max(16_384)) })
export const emptyIntent = () => ({ goal: '', obstacle: '', choice: '', cost: '', outcome: '', viewpoint: '', hardConstraints: '' })
const source = { workspaceId: digest, bookId: idSchema, chapterId: idSchema, expectedVersion: z.int().nonnegative(), expectedRevision: z.int().positive(), expectedHash: digest }
export const saveIntentSchema = z.strictObject({ ...source, operationId: idSchema, intent: intentSchema })
export const suggestIntentSchema = z.strictObject({ ...source, proposalId: idSchema, instruction: contentSchema.pipe(z.string().trim().min(1).max(16_384)) })
export const directionsSchema = z.strictObject({ directions: z.array(intentSchema).min(1).max(3) })
