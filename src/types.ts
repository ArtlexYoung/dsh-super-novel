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
  readonly kind?: DocumentKind
  readonly linkedChapterId?: string
}
export type DocumentKind = 'chapter' | 'seed' | 'book-card' | 'character' | 'world' | 'outline' | 'chapter-outline' | 'scene' | 'facts' | 'voice'
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
export interface StorageLocation {
  readonly root: string
  readonly path: string
  readonly defaultRoot: string
  readonly workspaceId: string
  readonly previousRoots: readonly string[]
  readonly writable: boolean
  readonly canPick: boolean
  readonly canOpen: boolean
  readonly canChange: boolean
}
export interface ChangeStorageLocationRequest { readonly root: string; readonly expectedWorkspaceId: string }
export interface PickStorageLocation { readonly selected: boolean; readonly root: string }
export interface DraftRequest {
  readonly workspaceId: string; readonly bookId: string; readonly chapterId: string
  readonly branchId: string; readonly sequence: number; readonly baseHash: string
  readonly bookRevision: number; readonly content: string; readonly operationId: string
}
export interface DraftSummary {
  readonly workspaceId: string; readonly bookId: string; readonly chapterId: string
  readonly branchId: string; readonly sequence: number; readonly baseHash: string
  readonly bookRevision: number; readonly contentHash: string; readonly savedAt: number
  readonly operationId: string
}
export interface DiskDraft extends DraftSummary { readonly content: string }
export interface DraftListing { readonly drafts: readonly DraftSummary[]; readonly unreadable: number }
export interface DraftQuery { readonly workspaceId: string; readonly bookId: string; readonly chapterId: string }
export interface DraftVersionQuery extends DraftQuery { readonly branchId: string; readonly sequence: number }
export interface SettleDraftRequest extends DraftVersionQuery { readonly contentHash: string; readonly action: 'saved' | 'dismissed' }
export interface ChapterText {
  readonly book: BookSnapshot
  readonly chapterId: string
  readonly content: string
  readonly hash: string
  readonly externallyModified: boolean
}
export interface CreateBookRequest { readonly operationId: string; readonly title: string }
export interface ChapterMutationRequest {
  readonly workspaceId?: string
  readonly operationId: string
  readonly bookId: string
  readonly expectedRevision: number
  readonly action: 'create' | 'rename' | 'move' | 'save'
  readonly chapterId: string
  readonly title: string
  readonly beforeChapterId: string
  readonly content: string
  readonly expectedHash: string
  readonly kind?: DocumentKind
  readonly linkedChapterId?: string
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
  readonly materialIds?: readonly string[]
  readonly voiceIds?: readonly string[]
  readonly useFacts?: boolean
  readonly knowledgeScope?: string
  readonly parentProposalId?: string
  readonly reviewId?: string
  readonly issueId?: string
}
export interface MaterialSnapshot {
  readonly chapterId: string
  readonly title: string
  readonly kind: DocumentKind
  readonly revision: number
  readonly hash: string
  readonly content: string
}
export interface AuthorizeVoiceRequest {
  readonly operationId: string; readonly bookId: string; readonly expectedRevision: number
  readonly sourceChapterId: string; readonly expectedHash: string; readonly start: number; readonly end: number
  readonly channel: 'narration' | 'dialogue'; readonly characterId: string; readonly sourceDescription: string; readonly authorized: boolean
}
export interface VoiceSample {
  readonly voiceId: string; readonly sourceChapterId: string; readonly sourceRevision: number; readonly sourceHash: string
  readonly channel: 'narration' | 'dialogue'; readonly characterId: string; readonly sourceDescription: string
  readonly sample: string; readonly start: number; readonly end: number; readonly authorized: boolean; readonly authorizedAt: number
  readonly state: 'active' | 'revoked' | 'expired'; readonly hash: string
}
export interface ImportRequest { readonly operationId: string; readonly title: string; readonly text: string; readonly mode: 'single' | 'headings' | 'archive' }
export interface ImportPreview { readonly title: string; readonly chapters: readonly { readonly title: string; readonly characters: number; readonly kind: DocumentKind }[]; readonly bytes: number; readonly analysis: 'not-analyzed' }
export interface ExportText { readonly text: string; readonly title: string }
export type KnowledgeScope = { readonly kind: 'reader' } | { readonly kind: 'character'; readonly characterId: string }
export interface EvidenceFact {
  readonly factId: string
  readonly subject: string
  readonly predicate: string
  readonly value: string
  readonly scope: KnowledgeScope
  readonly sourceChapterId: string
  readonly sourceRevision: number
  readonly sourceHash: string
  readonly quote: string
  readonly start: number
  readonly end: number
}
export interface FactProposal {
  readonly proposalId: string
  readonly bookId: string
  readonly sourceChapterId: string
  readonly sourceRevision: number
  readonly sourceHash: string
  readonly state: 'review' | 'accepted' | 'rejected' | 'expired'
  readonly reason: string
  readonly facts: readonly EvidenceFact[]
  readonly createdAt: number
  readonly factsHash: string
  readonly summary?: EvidenceSummary
  readonly usage: GenerationUsage
  readonly elapsedMs: number
  readonly coverage: 'chapter' | 'selection'
}
export interface EvidenceSummary { readonly text: string; readonly quote: string; readonly start: number; readonly end: number }
export interface ProposeFactsRequest {
  readonly proposalId: string
  readonly bookId: string
  readonly sourceChapterId: string
  readonly expectedRevision: number
  readonly expectedHash: string
  readonly facts: readonly Omit<EvidenceFact, 'factId' | 'sourceRevision' | 'sourceHash'>[]
  readonly summary?: EvidenceSummary
  readonly coverage?: 'chapter' | 'selection'
}
export interface GenerateFactsRequest {
  readonly proposalId: string
  readonly bookId: string
  readonly sourceChapterId: string
  readonly expectedRevision: number
  readonly expectedHash: string
}
export interface FactContext {
  readonly facts: readonly EvidenceFact[]
  readonly state: 'complete' | 'degraded' | 'expired' | 'over-budget'
  readonly bytes: number
  readonly sources: readonly { readonly chapterId: string; readonly revision: number; readonly hash: string; readonly recordId: string; readonly recordHash: string }[]
  readonly missingChapterIds: readonly string[]
  readonly summaries: readonly { readonly chapterId: string; readonly text: string }[]
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
  readonly context?: readonly MaterialSnapshot[]
  readonly revisionRound?: number
}
export interface ProposalDecisionRequest {
  readonly bookId: string
  readonly proposalId: string
  readonly expectedCandidateHash: string
}

export interface ChapterHistorySummary {
  readonly operationId: string
  readonly chapterId: string
  readonly chapterRevision: number
  readonly bookRevision: number
  readonly hash: string
  readonly source: 'save' | 'restore' | 'conflict'
  readonly sourceId: string
}
export interface ChapterHistoryVersion extends ChapterHistorySummary { readonly content: string }
export interface RestoreChapterRequest {
  readonly operationId: string
  readonly bookId: string
  readonly chapterId: string
  readonly sourceOperationId: string
  readonly expectedSourceHash: string
  readonly expectedRevision: number
  readonly expectedHash: string
}
export interface PreserveConflictRequest {
  readonly conflictId: string
  readonly bookId: string
  readonly chapterId: string
  readonly baselineRevision: number
  readonly baselineHash: string
  readonly localContent: string
}
export interface ChapterConflict {
  readonly conflictId: string
  readonly bookId: string
  readonly chapterId: string
  readonly baselineRevision: number
  readonly baselineHash: string
  readonly localContent: string
  readonly diskContent: string
  readonly diskRevision: number
  readonly diskHash: string
  readonly createdAt: number
  readonly resolved: boolean
}
export interface ResolveConflictRequest {
  readonly operationId: string
  readonly bookId: string
  readonly conflictId: string
  readonly expectedRevision: number
  readonly expectedHash: string
  readonly choice: 'disk' | 'local' | 'merged'
  readonly mergedContent: string
}
export interface InterruptedChapterSave {
  readonly bookId: string
  readonly chapterId: string
  readonly pendingHash: string
  readonly diskHash: string
  readonly diskContent: string
  readonly preparedContent: string
}
export interface SettleInterruptedSaveRequest {
  readonly operationId: string
  readonly bookId: string
  readonly pendingHash: string
  readonly diskHash: string
  readonly content: string
}
export interface ReviewRequest {
  readonly reviewId: string
  readonly bookId: string
  readonly chapterId: string
  readonly proposalId: string
  readonly expectedRevision: number
  readonly expectedHash: string
  readonly minCharacters: number
  readonly maxCharacters: number
  readonly minParagraphs: number
  readonly maxParagraphs: number
}
export interface ReviewIssue {
  readonly issueId: string
  readonly dimension: 'mechanical' | 'continuity' | 'character' | 'causality' | 'language'
  readonly severity: 'warning' | 'error'
  readonly message: string
  readonly suggestion: string
  readonly quote: string
  readonly start: number
  readonly end: number
  readonly references: readonly string[]
}
export interface ReviewView {
  readonly reviewId: string
  readonly bookId: string
  readonly chapterId: string
  readonly proposalId: string
  readonly textHash: string
  readonly state: 'passed' | 'issues' | 'unknown' | 'degraded' | 'expired'
  readonly reason: string
  readonly issues: readonly ReviewIssue[]
  readonly dimensions: readonly { readonly dimension: 'continuity' | 'character' | 'causality' | 'language'; readonly state: 'checked' | 'unknown' | 'degraded' }[]
  readonly characters: number
  readonly paragraphs: number
  readonly createdAt: number
  readonly elapsedMs: number
  readonly usage: GenerationUsage
}

export interface BackupSettings { readonly root: string; readonly path: string; readonly automatic: boolean; readonly intervalMinutes: number }
export interface BackupSummary {
  readonly backupId: string; readonly bookId: string; readonly title: string; readonly revision: number
  readonly createdAt: number; readonly verifiedAt: number; readonly bytes: number; readonly fileCount: number
  readonly recoveryRequired: boolean; readonly path: string
}
export interface BackupPreview {
  readonly summary: BackupSummary; readonly sourceWorkspaceId: string; readonly foreign: boolean
  readonly manifestHash: string; readonly files: readonly string[]
}
export interface BackupQuery { readonly workspaceId: string; readonly bookId: string; readonly backupId: string }
export interface BackupConfiguration { readonly workspaceId: string; readonly root: string; readonly automatic: boolean }
export interface RestoreBackupRequest extends BackupQuery { readonly manifestHash: string }

export interface BackupHealth { readonly state: 'none' | 'verified' | 'failed'; readonly attemptedAt: number; readonly reason: string }
