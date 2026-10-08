import { z } from 'zod'
import { BookError, contentSchema, hash, idSchema, json } from './books.js'
import type { ChapterMutationRequest, GenerationUsage, GenerateChapterRequest, ProposalView } from '../types.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const generationRequestSchema = z.strictObject({
  proposalId: idSchema, bookId: idSchema, chapterId: idSchema,
  expectedRevision: z.int().positive(), expectedHash: digest,
  mode: z.enum(['draft', 'continue', 'rewrite', 'polish']),
  instruction: contentSchema.pipe(z.string().trim().min(1).max(16_384)),
  materials: contentSchema.pipe(z.string().max(65_536)),
  start: z.int().nonnegative(), end: z.int().nonnegative(),
})
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
    proposal.requestHash !== hash(json(proposal.request)) || proposal.request.expectedHash !== hash(proposal.baseline) ||
    proposal.candidateHash !== hash(candidate(proposal)) || !contentSchema.safeParse(candidate(proposal)).success) throw new BookError('invalid-format')
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
    instruction: proposal.request.instruction, materials: proposal.request.materials, elapsedMs: proposal.elapsedMs, usage: proposal.usage as GenerationUsage }
}

export function generationPrompt(proposal: Proposal): string {
  const modes = { draft: 'Write a complete chapter replacing the authorized text.', continue: 'Write only the continuation to append. Do not repeat the existing chapter.', rewrite: 'Rewrite only the authorized selection.', polish: 'Polish only the authorized selection, preserving its meaning and voice.' }
  return JSON.stringify({ task: modes[proposal.request.mode], instruction: proposal.request.instruction,
    authorMaterials: proposal.request.materials, chapter: proposal.baseline,
    selection: { start: proposal.request.start, end: proposal.request.end, text: proposal.baseline.slice(proposal.request.start, proposal.request.end) } })
}
