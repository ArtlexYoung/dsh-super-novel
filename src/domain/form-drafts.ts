import { z } from 'zod'
import { BookError, contentSchema, idSchema } from './books.js'
import { evidenceSchema } from './story-state.js'
import { chapterStructureSchema } from './books.js'

export const formKindSchema = z.enum(['material', 'story', 'structure'])
const text = (max: number) => contentSchema.pipe(z.string().max(max))
export const materialFormSchema = z.strictObject({ tags: text(4096), aliases: text(8000), favorite: z.boolean(),
  status: z.enum(['active', 'inbox', 'archived', 'trashed']), linkedChapterIds: z.array(idSchema).max(1000), relatedMaterialIds: z.array(idSchema).max(1000) })
const time = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('unknown') }),
  z.strictObject({ kind: z.literal('known'), label: text(200), order: z.number().finite().min(-1_000_000).max(1_000_000) })])
const event = z.strictObject({ kind: z.literal('event'), eventId: idSchema, title: text(200), time, evidence: evidenceSchema,
  changes: z.array(z.strictObject({ characterId: z.union([idSchema, z.literal('')]), kind: z.enum(['location', 'injury', 'item', 'knowledge']), value: text(2000) })).max(100) })
const thread = z.strictObject({ kind: z.literal('foreshadow'), foreshadowId: idSchema, title: text(200), note: text(8000),
  status: z.enum(['planned', 'planted', 'unresolved', 'resolved']), planted: evidenceSchema.optional(), resolved: evidenceSchema.optional() })
const structure = z.strictObject({ volumes: z.array(z.strictObject({ volumeId: idSchema, title: text(200) })).max(1000), storylines: z.array(z.strictObject({ storylineId: idSchema, title: text(200) })).max(1000), chapters: z.array(chapterStructureSchema.safeExtend({ chapterId: idSchema })).max(10_000) })
const envelope = z.discriminatedUnion('kind', [
  z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('material'), base: materialFormSchema, form: materialFormSchema }),
  z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('story'), base: z.int().nonnegative(), sourceProposalId: idSchema.optional(), form: z.discriminatedUnion('kind', [event, thread]) }),
  z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('structure'), base: z.int().positive(), form: structure }),
])

/** Drafts allow unfinished fields, but cannot masquerade as confirmed metadata or evidence. */
export function parseFormDraft(content: string, kind: string): z.infer<typeof envelope> {
  if (Buffer.byteLength(content, 'utf8') > (kind === 'structure' ? 4 : 1) * 1024 * 1024) throw new BookError('too-large')
  try {
    const value = envelope.parse(JSON.parse(content))
    if (value.kind !== kind) throw new BookError('invalid-format')
    return value
  } catch (error) { if (error instanceof BookError) throw error; throw new BookError('invalid-format') }
}
