import { z } from 'zod'
import { BookError, contentSchema, hash, idSchema, json } from './books.js'
import type { ChapterMutationRequest } from '../types.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const short = contentSchema.pipe(z.string().trim().min(1).max(4000))
const scopeSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('reader') }), z.strictObject({ kind: z.literal('character'), characterId: idSchema })])
export const summarySchema = z.strictObject({ text: short, quote: contentSchema.pipe(z.string().min(1).max(4000)), start: z.int().nonnegative(), end: z.int().positive() })
export const factInputSchema = z.strictObject({ subject: short, predicate: short, value: short, scope: scopeSchema,
  sourceChapterId: idSchema, quote: contentSchema.pipe(z.string().min(1).max(4000)), start: z.int().nonnegative(), end: z.int().positive() })
export const evidenceFactSchema = factInputSchema.extend({ factId: idSchema, sourceRevision: z.int().positive(), sourceHash: digest })
export const generateFactsSchema = z.strictObject({ proposalId: idSchema, bookId: idSchema, sourceChapterId: idSchema, expectedRevision: z.int().positive(), expectedHash: digest })
export const factsRequestSchema = generateFactsSchema.extend({ facts: z.array(factInputSchema).max(200), summary: summarySchema.optional(), coverage: z.enum(['chapter', 'selection']).optional() })
export const extractionSchema = z.strictObject({ facts: z.array(factInputSchema).max(200), summary: summarySchema })
export const factDocumentSchema = z.strictObject({ schemaVersion: z.literal(1), sourceChapterId: idSchema, sourceRevision: z.int().positive(), sourceHash: digest,
  facts: z.array(evidenceFactSchema).max(200), summary: summarySchema.optional(), coverage: z.enum(['chapter', 'selection']) })
export type FactDocument = z.infer<typeof factDocumentSchema>
const usageSchema = z.discriminatedUnion('state', [z.strictObject({ state: z.literal('unknown') }), z.strictObject({ state: z.literal('reported'), inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative(), cacheReadTokens: z.int().nonnegative().optional(), cacheWriteTokens: z.int().nonnegative().optional(), totalTokens: z.int().nonnegative().optional(), reasoningTokens: z.int().nonnegative().optional() })])
const proposalSchema = z.strictObject({ schemaVersion: z.literal(1), workspaceId: digest, requestHash: digest, request: factsRequestSchema,
  documentId: idSchema, acceptanceId: idSchema, expectedDocumentHash: z.union([digest, z.literal('')]), document: factDocumentSchema,
  state: z.enum(['review', 'rejected']), createdAt: z.int().nonnegative(), usage: usageSchema, elapsedMs: z.int().nonnegative() })
export type StoredFactProposal = z.infer<typeof proposalSchema>

export function validateFacts(document: FactDocument, text: string): void {
  if (document.sourceHash !== hash(text)) throw new BookError('fact-stale')
  const evidence = [...document.facts, ...(document.summary ? [document.summary] : [])]
  if (evidence.some(item => item.start >= item.end || item.end > text.length || text.slice(item.start, item.end) !== item.quote)) throw new BookError('invalid-evidence')
  if (document.facts.some(item => item.sourceChapterId !== document.sourceChapterId || item.sourceHash !== document.sourceHash || item.sourceRevision !== document.sourceRevision) ||
    new Set(document.facts.map(item => item.factId)).size !== document.facts.length) throw new BookError('invalid-evidence')
  if (new Set(document.facts.map(({ factId: _id, ...item }) => json(item))).size !== document.facts.length) throw new BookError('invalid-evidence')
}
export function parseFactDocument(text: string): FactDocument {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new BookError('invalid-format') }
  if (typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion !== 1) throw new BookError('unsupported-format')
  const result = factDocumentSchema.safeParse(value)
  if (!result.success) throw new BookError('invalid-format')
  return result.data
}
export function parseFactProposal(text: string, workspaceId: string, bookId: string, proposalId: string): StoredFactProposal {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new BookError('invalid-format') }
  if (typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion !== 1) throw new BookError('unsupported-format')
  const result = proposalSchema.safeParse(value)
  if (!result.success || result.data.workspaceId !== workspaceId || result.data.request.proposalId !== proposalId || result.data.request.bookId !== bookId || result.data.requestHash !== hash(json(result.data.request))) throw new BookError('invalid-format')
  const proposal = result.data
  if (proposal.document.sourceChapterId !== proposal.request.sourceChapterId || proposal.document.sourceHash !== proposal.request.expectedHash || proposal.document.facts.length !== proposal.request.facts.length ||
    proposal.document.facts.some((item, i) => { const { factId: _id, sourceRevision: _revision, sourceHash: _hash, ...input } = item; return json(input) !== json(proposal.request.facts[i]) })) throw new BookError('invalid-format')
  if (json(proposal.document.summary) !== json(proposal.request.summary)) throw new BookError('invalid-format')
  if (proposal.document.coverage !== (proposal.request.coverage ?? 'selection')) throw new BookError('invalid-format')
  return proposal
}
export function factAdoption(proposal: StoredFactProposal): ChapterMutationRequest {
  return { operationId: proposal.acceptanceId, bookId: proposal.request.bookId, expectedRevision: proposal.request.expectedRevision,
    action: proposal.expectedDocumentHash ? 'save' : 'create', chapterId: proposal.documentId, title: proposal.expectedDocumentHash ? '' : 'Story facts', beforeChapterId: '', content: json(proposal.document), expectedHash: proposal.expectedDocumentHash,
    ...(proposal.expectedDocumentHash ? {} : { kind: 'facts', linkedChapterId: proposal.request.sourceChapterId }) }
}
