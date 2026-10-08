import { z } from 'zod'
import { BookError, contentSchema, idSchema, titleSchema } from './books.js'
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const authorizeVoiceSchema = z.strictObject({ operationId: idSchema, bookId: idSchema, expectedRevision: z.int().positive(), sourceChapterId: idSchema, expectedHash: digest,
  start: z.int().nonnegative(), end: z.int().positive(), channel: z.enum(['narration', 'dialogue']), characterId: z.union([idSchema, z.literal('')]), sourceDescription: titleSchema, authorized: z.literal(true) })
export const voiceDocumentSchema = z.strictObject({ schemaVersion: z.literal(1), voiceId: idSchema, sourceChapterId: idSchema, sourceRevision: z.int().positive(), sourceHash: digest,
  channel: z.enum(['narration', 'dialogue']), characterId: z.union([idSchema, z.literal('')]), sourceDescription: titleSchema, sample: contentSchema.pipe(z.string().min(1).max(65_536)),
  start: z.int().nonnegative(), end: z.int().positive(), authorized: z.boolean(), authorizedAt: z.int().nonnegative() })
  .refine(value => value.end > value.start && value.end - value.start === value.sample.length && (value.channel === 'dialogue' ? !!value.characterId : !value.characterId))
export function parseVoice(text: string): z.infer<typeof voiceDocumentSchema> {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new BookError('invalid-format') }
  if (typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion !== 1) throw new BookError('unsupported-format')
  const parsed = voiceDocumentSchema.safeParse(value)
  if (!parsed.success) throw new BookError('invalid-format')
  return parsed.data
}
