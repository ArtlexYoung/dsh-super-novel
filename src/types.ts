/** Public status contains no private filesystem paths. */
export interface PresetStatus {
  readonly state: 'available' | 'enabled' | 'conflict' | 'unavailable' | 'busy' | 'incomplete'
  readonly reason: string
}

export interface ChapterSummary {
  readonly chapterId: string
  readonly title: string
  readonly revision: number
  readonly hash: string
}
export interface BookSnapshot {
  readonly schemaVersion: 1
  readonly bookId: string
  readonly title: string
  readonly revision: number
  readonly chapters: readonly ChapterSummary[]
  readonly recoveryRequired: boolean
}
export interface LibrarySnapshot {
  readonly workspace: string
  readonly workspaceId: string
  readonly writable: boolean
  readonly books: readonly BookSnapshot[]
}
export interface ChapterText {
  readonly book: BookSnapshot
  readonly chapterId: string
  readonly content: string
  readonly hash: string
  readonly externallyModified: boolean
}
export interface CreateBookRequest { readonly operationId: string; readonly title: string }
export interface ChapterMutationRequest {
  readonly operationId: string
  readonly bookId: string
  readonly expectedRevision: number
  readonly action: 'create' | 'rename' | 'move' | 'save'
  readonly chapterId: string
  readonly title: string
  readonly beforeChapterId: string
  readonly content: string
  readonly expectedHash: string
}

export type ProposalMode = 'draft' | 'continue' | 'rewrite' | 'polish'
export type ProposalState = 'generating' | 'review' | 'accepted' | 'rejected' | 'expired' | 'interrupted'
export interface GenerateChapterRequest {
  readonly proposalId: string
  readonly bookId: string
  readonly chapterId: string
  readonly expectedRevision: number
  readonly expectedHash: string
  readonly mode: ProposalMode
  readonly instruction: string
  readonly materials: string
  readonly start: number
  readonly end: number
}
export interface ProposalSummary {
  readonly proposalId: string
  readonly bookId: string
  readonly chapterId: string
  readonly mode: ProposalMode
  readonly state: ProposalState
  readonly reason: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly generatedCharacters: number
  readonly recoveryRequired: boolean
}
export type GenerationUsage = { readonly state: 'unknown' } | {
  readonly state: 'reported'
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly totalTokens?: number
  readonly reasoningTokens?: number
}
export interface ProposalView extends ProposalSummary {
  readonly baselineRevision: number
  readonly baselineHash: string
  readonly baseline: string
  readonly start: number
  readonly end: number
  readonly replacement: string
  readonly candidate: string
  readonly candidateHash: string
  readonly instruction: string
  readonly materials: string
  readonly elapsedMs: number
  readonly usage: GenerationUsage
}
export interface ProposalDecisionRequest {
  readonly bookId: string
  readonly proposalId: string
  readonly expectedCandidateHash: string
}
