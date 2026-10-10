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
  readonly tags?: readonly string[]
  readonly aliases?: readonly string[]
  readonly favorite?: boolean
  readonly status?: 'active' | 'inbox' | 'archived' | 'trashed'
  readonly linkedChapterIds?: readonly string[]
  readonly relatedMaterialIds?: readonly string[]
  readonly sourceEvidence?: MaterialSourceEvidence
}
export type DocumentKind = 'chapter' | 'seed' | 'book-card' | 'character' | 'world' | 'outline' | 'chapter-outline' | 'scene' | 'facts' | 'voice'
export interface BookSnapshot {
  readonly schemaVersion: 1 | 2
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
  readonly sourceEvidence?: MaterialSourceEvidence
  readonly linkedChapterIds?: readonly string[]
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
  readonly hardConstraints?: string
  readonly intentVersion?: number
  readonly precedingChapterIds?: readonly string[]
  readonly useStoryState?: boolean
}
export interface StoryEvidence {
  readonly chapterId: string; readonly revision: number; readonly hash: string
  readonly start: number; readonly end: number; readonly quote: string
}
export type StoryTime = { readonly kind: 'unknown' } | { readonly kind: 'known'; readonly label: string; readonly order: number }
export interface CharacterChange { readonly characterId: string; readonly kind: 'location' | 'injury' | 'item' | 'knowledge'; readonly value: string }
export interface StoryEvent { readonly eventId: string; readonly title: string; readonly time: StoryTime; readonly evidence: StoryEvidence; readonly changes: readonly CharacterChange[] }
export interface Foreshadow { readonly foreshadowId: string; readonly title: string; readonly note: string; readonly status: 'planned' | 'planted' | 'unresolved' | 'resolved'; readonly planted?: StoryEvidence; readonly resolved?: StoryEvidence }
export interface StoryState {
  readonly version: number; readonly bookId: string
  readonly events: readonly (StoryEvent & { readonly state: 'valid' | 'expired'; readonly narrativeOrder: number })[]
  readonly foreshadows: readonly (Foreshadow & { readonly state: 'valid' | 'expired' })[]
}
export interface SaveStoryStateRequest {
  readonly workspaceId: string; readonly bookId: string; readonly operationId: string; readonly expectedVersion: number; readonly expectedRevision: number
  readonly event?: StoryEvent; readonly foreshadow?: Foreshadow
}
export interface SuggestStoryStateRequest {
  readonly workspaceId: string; readonly bookId: string; readonly chapterId: string; readonly proposalId: string; readonly expectedRevision: number; readonly expectedHash: string
}
export interface StoryStateSuggestion {
  readonly proposalId: string; readonly bookId: string; readonly chapterId: string; readonly sourceHash: string
  readonly state: 'review' | 'expired'; readonly events: readonly StoryEvent[]; readonly foreshadows: readonly Foreshadow[]
  readonly createdAt: number; readonly usage: GenerationUsage; readonly elapsedMs: number
}
export interface StoryContext { readonly content: string; readonly hash: string; readonly state: 'ready' | 'expired' | 'over-budget'; readonly bytes: number }
export interface ChapterImpacts {
  readonly complete: boolean
  readonly items: readonly { readonly kind: 'facts' | 'summary' | 'material' | 'proposal' | 'review' | 'event' | 'foreshadow'; readonly id: string; readonly chapterId: string; readonly title: string; readonly state: 'current' | 'expired' }[]
}
export interface SceneIntent {
  readonly goal: string; readonly obstacle: string; readonly choice: string; readonly cost: string
  readonly outcome: string; readonly viewpoint: string; readonly hardConstraints: string
}
export interface ChapterIntent {
  readonly bookId: string; readonly chapterId: string; readonly version: number
  readonly intent: SceneIntent; readonly hash: string; readonly updatedAt: number
}
export interface SaveIntentRequest {
  readonly workspaceId: string; readonly operationId: string; readonly bookId: string; readonly chapterId: string
  readonly expectedVersion: number; readonly expectedRevision: number; readonly expectedHash: string; readonly intent: SceneIntent
}
export interface SuggestIntentRequest {
  readonly workspaceId: string; readonly proposalId: string; readonly bookId: string; readonly chapterId: string
  readonly expectedVersion: number; readonly expectedRevision: number; readonly expectedHash: string
  readonly instruction: string
}
export interface IntentSuggestion {
  readonly proposalId: string; readonly bookId: string; readonly chapterId: string; readonly sourceHash: string
  readonly intentVersion: number; readonly directions: readonly SceneIntent[]; readonly createdAt: number
  readonly state: 'review' | 'expired'; readonly usage: GenerationUsage; readonly elapsedMs: number
}
export interface GenerationContextPreview {
  readonly bytes: number; readonly maxBytes: number; readonly state: 'ready' | 'over-budget'
  readonly sections: readonly { readonly kind: string; readonly sourceId: string; readonly title: string; readonly reason: string; readonly content: string; readonly bytes: number }[]
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
  readonly hardConstraints?: string
  readonly intentContext?: { readonly version: number; readonly hash: string; readonly intent: SceneIntent }
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
  readonly start?: number; readonly end?: number
  readonly intentionalRepetitions?: readonly string[]
  readonly intentVersion?: number; readonly hardConstraints?: string; readonly materialIds?: readonly string[]
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

export interface UpgradeBookRequest { readonly workspaceId: string; readonly bookId: string; readonly expectedRevision: number; readonly operationId: string; readonly backupId: string }
export interface MaterialMetadataRequest {
  readonly workspaceId: string; readonly bookId: string; readonly expectedRevision: number; readonly operationId: string; readonly chapterId: string
  readonly tags: readonly string[]; readonly aliases: readonly string[]; readonly favorite: boolean
  readonly status: 'active' | 'inbox' | 'archived' | 'trashed'; readonly linkedChapterIds: readonly string[]; readonly relatedMaterialIds: readonly string[]
}
export interface MaterialSearchRequest {
  readonly bookId: string; readonly query: string; readonly kind: string; readonly tag: string; readonly status: string
  readonly linkedChapterId: string; readonly favorite: boolean; readonly offset: number
}
export interface MaterialSearchResult { readonly items: readonly ChapterSummary[]; readonly total: number; readonly complete: boolean; readonly externalIds: readonly string[]; readonly revision: number }
export interface BookSearchRequest {
  readonly workspaceId: string; readonly bookId: string; readonly query: string; readonly kind: string
  readonly includeArchived: boolean; readonly offset: number
}
export interface BookSearchHit {
  readonly chapterId: string; readonly title: string; readonly kind: string; readonly revision: number; readonly hash: string
  readonly start: number; readonly end: number; readonly quote: string; readonly snippet: string
  readonly externallyModified: boolean; readonly archived: boolean
}
export interface BookSearchResult {
  readonly workspaceId: string; readonly bookId: string; readonly revision: number; readonly items: readonly BookSearchHit[]
  readonly total: number; readonly complete: boolean; readonly scanned: number; readonly skipped: number
}
export interface DocumentPreviewRequest { readonly workspaceId: string; readonly bookId: string; readonly chapterId: string; readonly proposalId: string }
export interface DocumentPreview {
  readonly workspaceId: string; readonly document: ChapterText; readonly references: MaterialReferences; readonly proposal?: ProposalView
}
export interface MaterialReferences {
  readonly linkedChapterIds: readonly string[]; readonly outgoing: readonly string[]; readonly incoming: readonly string[]
  readonly uses: readonly { readonly proposalId: string; readonly chapterId: string; readonly revision: number; readonly hash: string; readonly stale: boolean; readonly state: string }[]
  readonly evidenceChapterIds: readonly string[]; readonly draftBranches: number; readonly complete: boolean
}

export interface MaterialSourceEvidence { readonly chapterId: string; readonly revision: number; readonly hash: string; readonly quote: string; readonly start: number; readonly end: number }
export interface SelectionMaterialRequest { readonly workspaceId: string; readonly bookId: string; readonly expectedRevision: number; readonly sourceChapterId: string; readonly sourceHash: string; readonly start: number; readonly end: number; readonly title: string; readonly kind: DocumentKind; readonly operationId: string; readonly chapterId: string }
