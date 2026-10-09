import { z } from 'zod'
import { BookError, contentSchema, documentKindSchema, hash, idSchema, json, titleSchema } from './books.js'
import type { ChapterMutationRequest, GenerationUsage, GenerateChapterRequest, ProposalView } from '../types.js'
import { voiceDocumentSchema } from './voice.js'
import { intentSchema } from './intents.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const generationRequestSchema = z.strictObject({
  proposalId: idSchema, bookId: idSchema, chapterId: idSchema,
  expectedRevision: z.int().positive(), expectedHash: digest,
  mode: z.enum(['draft', 'continue', 'rewrite', 'polish']),
  instruction: contentSchema.pipe(z.string().trim().min(1).max(16_384)),
  materials: contentSchema.pipe(z.string().max(65_536)),
  start: z.int().nonnegative(), end: z.int().nonnegative(),
  materialIds: z.array(idSchema).max(100).refine(ids => new Set(ids).size === ids.length).optional(),
  voiceIds: z.array(idSchema).max(20).refine(ids => new Set(ids).size === ids.length).optional(),
  useFacts: z.boolean().optional(), knowledgeScope: z.union([idSchema, z.literal('reader')]).optional(),
  parentProposalId: idSchema.optional(), reviewId: idSchema.optional(), issueId: idSchema.optional(),
  hardConstraints: contentSchema.pipe(z.string().max(16_384)).optional(), intentVersion: z.int().nonnegative().optional(),
  precedingChapterIds: z.array(idSchema).max(3).refine(ids => new Set(ids).size === ids.length).optional(),
}).refine(request => (request.materialIds?.length ?? 0) + (request.precedingChapterIds?.length ?? 0) <= 100)
const materialSchema = z.strictObject({ chapterId: idSchema, title: titleSchema, kind: documentKindSchema,
  revision: z.int().positive(), hash: digest, content: contentSchema })
export const decisionSchema = z.strictObject({ bookId: idSchema, proposalId: idSchema, expectedCandidateHash: digest })
const usageSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('unknown') }),
  z.strictObject({ state: z.literal('reported'), inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative(), cacheReadTokens: z.int().nonnegative().optional(), cacheWriteTokens: z.int().nonnegative().optional(), totalTokens: z.int().nonnegative().optional(), reasoningTokens: z.int().nonnegative().optional() }),
])
export const proposalSchema = z.strictObject({
  schemaVersion: z.literal(1), workspaceId: digest, sessionId: z.string().min(1).max(200),
  owner: z.strictObject({ machine: digest, pid: z.int().positive(), runtimeId: idSchema }),
  request: generationRequestSchema, requestHash: digest, acceptanceId: idSchema,
  createdAt: z.int().nonnegative(), updatedAt: z.int().nonnegative(),
  state: z.enum(['generating', 'review', 'accepted', 'rejected', 'interrupted']), reason: z.string().max(100),
  baseline: contentSchema, baselineChapterRevision: z.int().positive(),
  replacement: contentSchema, candidateHash: digest, elapsedMs: z.int().nonnegative(), usage: usageSchema,
  documentKind: documentKindSchema.optional(), context: z.array(materialSchema).max(100).optional(),
  factContext: z.strictObject({ content: contentSchema, scope: z.union([idSchema, z.literal('reader')]),
    sources: z.array(z.strictObject({ chapterId: idSchema, revision: z.int().positive(), hash: digest, recordId: idSchema, recordHash: digest })).max(10_000) }).optional(),
  parentCandidateHash: digest.optional(), revisionRound: z.int().min(1).max(2).optional(),
  voiceContext: z.array(voiceDocumentSchema.safeExtend({ state: z.literal('active'), hash: digest })).max(20).optional(),
  intentContext: z.strictObject({ version: z.int().nonnegative(), hash: digest, intent: intentSchema }).optional(),
})
export type Proposal = z.infer<typeof proposalSchema>

export function validateRange(request: GenerateChapterRequest, baseline: string): void {
  const { start, end, mode } = request
  if (start > end || end > baseline.length || !contentSchema.safeParse(baseline.slice(0, start)).success || !contentSchema.safeParse(baseline.slice(end)).success) throw new BookError('invalid-range')
  if (mode === 'draft' && (start !== 0 || end !== baseline.length)) throw new BookError('invalid-range')
  if (mode === 'continue' && (start !== baseline.length || end !== start)) throw new BookError('invalid-range')
  if ((mode === 'rewrite' || mode === 'polish') && start === end) throw new BookError('invalid-range')
}

export function candidate(proposal: Pick<Proposal, 'request' | 'baseline' | 'replacement'>): string {
  return proposal.baseline.slice(0, proposal.request.start) + proposal.replacement + proposal.baseline.slice(proposal.request.end)
}

export function parseProposal(text: string, workspaceId: string, bookId: string, proposalId: string): Proposal {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new BookError('invalid-format') }
  if (typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion !== 1) throw new BookError('unsupported-format')
  const result = proposalSchema.safeParse(value)
  if (!result.success) throw new BookError('invalid-format')
  const proposal = result.data
  if (proposal.workspaceId !== workspaceId || proposal.request.bookId !== bookId || proposal.request.proposalId !== proposalId ||
    proposal.requestHash !== hash(json(proposal.request)) || (proposal.request.parentProposalId ? proposal.parentCandidateHash !== hash(proposal.baseline) : proposal.request.expectedHash !== hash(proposal.baseline)) ||
    proposal.candidateHash !== hash(candidate(proposal)) || !contentSchema.safeParse(candidate(proposal)).success) throw new BookError('invalid-format')
  const selected = [...(proposal.request.materialIds ?? []), ...(proposal.request.precedingChapterIds ?? [])]
  const context = proposal.context ?? []
  if (context.length !== selected.length || context.some((item, index) => item.chapterId !== selected[index] || item.hash !== hash(item.content))) throw new BookError('invalid-format')
  if ((proposal.voiceContext ?? []).length !== (proposal.request.voiceIds ?? []).length || proposal.voiceContext?.some((item, index) => {
    const { state: _state, hash: digest, ...document } = item
    return item.voiceId !== proposal.request.voiceIds![index] || !item.authorized || digest !== hash(json(document))
  })) throw new BookError('invalid-format')
  if (proposal.request.intentVersion !== proposal.intentContext?.version || proposal.intentContext && proposal.intentContext.hash !== hash(json(proposal.intentContext.intent))) throw new BookError('invalid-format')
  validateRange(proposal.request, proposal.baseline)
  return proposal
}

export function adoption(proposal: Proposal): ChapterMutationRequest {
  return { operationId: proposal.acceptanceId, bookId: proposal.request.bookId,
    expectedRevision: proposal.request.expectedRevision, action: 'save', chapterId: proposal.request.chapterId,
    title: '', beforeChapterId: '', content: candidate(proposal), expectedHash: proposal.request.expectedHash }
}

export function proposalView(proposal: Proposal, state: ProposalView['state'], reason: string, recoveryRequired: boolean): ProposalView {
  return { proposalId: proposal.request.proposalId, bookId: proposal.request.bookId, chapterId: proposal.request.chapterId,
    mode: proposal.request.mode, state, reason, createdAt: proposal.createdAt, updatedAt: proposal.updatedAt,
    generatedCharacters: proposal.replacement.length, recoveryRequired, baselineRevision: proposal.request.expectedRevision,
    baselineHash: proposal.request.expectedHash, baseline: proposal.baseline, start: proposal.request.start, end: proposal.request.end,
    replacement: proposal.replacement, candidate: candidate(proposal), candidateHash: proposal.candidateHash,
    instruction: proposal.request.instruction, materials: proposal.request.materials, elapsedMs: proposal.elapsedMs, usage: proposal.usage as GenerationUsage,
    ...(proposal.context ? { context: proposal.context } : {}), ...(proposal.revisionRound ? { revisionRound: proposal.revisionRound } : {}),
    ...(proposal.request.hardConstraints !== undefined ? { hardConstraints: proposal.request.hardConstraints } : {}),
    ...(proposal.intentContext ? { intentContext: proposal.intentContext } : {}) }
}

export function generationPrompt(proposal: Proposal): string {
  const modes = { draft: 'Write a complete chapter replacing the authorized text.', continue: 'Write only the continuation to append. Do not repeat the existing chapter.', rewrite: 'Rewrite only the authorized selection.', polish: 'Polish only the authorized selection, preserving its meaning and voice.' }
  const planning = proposal.documentKind && proposal.documentKind !== 'chapter'
  return JSON.stringify({ task: planning && proposal.request.mode === 'draft' ? 'Create or improve the requested material, replacing the authorized text.' : modes[proposal.request.mode], instruction: proposal.request.instruction,
    authorMaterials: proposal.request.materials, chapter: proposal.baseline,
    ...(proposal.request.hardConstraints || proposal.intentContext?.intent.hardConstraints ? { hardConstraints: [proposal.request.hardConstraints ?? '', proposal.intentContext?.intent.hardConstraints ?? ''].filter(Boolean), constraintBoundary: 'Author hard constraints take priority. Do not omit, weaken or reinterpret them to fit a budget.' } : {}),
    ...(proposal.intentContext ? { sceneIntent: proposal.intentContext.intent, intentBoundary: 'Optional author direction, not established story facts. A scene need not follow a fixed conflict template.' } : {}),
    ...(proposal.documentKind && proposal.documentKind !== 'chapter' ? { documentKind: proposal.documentKind, planningTask: 'Write only the requested planning document. Planned events are not established story facts.' } : {}),
    ...(proposal.context?.length ? { selectedMaterials: proposal.context, planningBoundary: 'Plans describe possible future events, not events that have already happened.',
      ...(proposal.context.some(item => item.kind === 'chapter') ? { sourceBoundary: 'Sources with kind=chapter are saved prose. When organizing materials from prose, distinguish what the text says from proposed additions and unknowns. Do not invent evidence, assume off-page events, or convert plans into established facts. This material does not update the evidence-backed fact records.' } : {}) } : {}),
    ...(proposal.factContext ? { establishedFacts: proposal.factContext.content, knowledgeScope: proposal.factContext.scope } : {}),
    ...(proposal.voiceContext?.length ? { authorVoices: proposal.voiceContext, voiceBoundary: 'Authorized samples are stylistic references, not story facts. Preserve deliberate repetition, colloquial dialogue and rough expression when appropriate. Keep narration and named-character dialogue separate.' } : {}),
    selection: { start: proposal.request.start, end: proposal.request.end, text: proposal.baseline.slice(proposal.request.start, proposal.request.end) } })
}
