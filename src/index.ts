/** Host service and browser discovery entry for the novel-generation bundle. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { PresetInstaller } from './host/preset-install.js'
import type { PresetStatus } from './types.js'
import type { BookSnapshot, ChapterMutationRequest, ChapterText, CreateBookRequest, LibrarySnapshot } from './types.js'
import { storageResult, workspaceBooks } from './host/workspace-books.js'
import type { GenerateChapterRequest, ProposalDecisionRequest, ProposalSummary, ProposalView } from './types.js'
import { ProposalStore } from './host/proposal-store.js'
import { ProposalTasks } from './host/proposal-tasks.js'
import { hostChapterGenerator, hostTextGenerator } from './host/chapter-generator.js'
import { ChapterHistory } from './host/chapter-history.js'
import { ChapterConflicts } from './host/chapter-conflicts.js'
import type { ChapterHistorySummary, ChapterHistoryVersion, RestoreChapterRequest, ChapterConflict, PreserveConflictRequest, ResolveConflictRequest } from './types.js'
import type { InterruptedChapterSave, SettleInterruptedSaveRequest } from './types.js'
import type { FactProposal, ProposeFactsRequest, FactContext, GenerateFactsRequest } from './types.js'
import { FactStore } from './host/fact-store.js'
import { extractFacts } from './host/fact-extraction.js'
import type { ReviewRequest, ReviewView } from './types.js'
import { ReviewStore } from './host/review-store.js'
import { VoiceStore } from './host/voice-store.js'
import { BookTransfer } from './host/book-transfer.js'
import type { AuthorizeVoiceRequest, VoiceSample, ImportRequest, ImportPreview, ExportText } from './types.js'

export type { PresetStatus } from './types.js'
export type { BookSnapshot, ChapterMutationRequest, ChapterText, CreateBookRequest, LibrarySnapshot } from './types.js'
export type { GenerateChapterRequest, ProposalDecisionRequest, ProposalSummary, ProposalView } from './types.js'
export type { ChapterHistorySummary, ChapterHistoryVersion, RestoreChapterRequest, ChapterConflict, PreserveConflictRequest, ResolveConflictRequest } from './types.js'
export type { FactProposal, ProposeFactsRequest, FactContext } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context { superNovel: SuperNovel }
}

/** User-initiated preset setup; it never changes the default mode or existing roots. */
export class SuperNovel extends TypertRemoteService {
  static inject = ['agentPresets']
  private readonly installer: PresetInstaller
  private readonly tasks = new ProposalTasks()
  private readonly lifetime = new AbortController()
  private readonly extractions = new Map<string, Promise<FactProposal>>()
  private readonly reviews = new Map<string, Promise<ReviewView>>()

  constructor(ctx: Context) {
    super(ctx, 'superNovel', { namespace: 'superNovel' })
    this.installer = new PresetInstaller(ctx.agentPresets, fileURLToPath(new URL('../presets/dsh-super-novel/', import.meta.url)), JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
    ctx.effect(() => () => { this.lifetime.abort(); return this.tasks.dispose() })
  }

  /**
   * @param signal - request cancellation.
   * @returns Current setup state without writing files or activating an Agent.
   */
  @Remote
  async status(signal: AbortSignal): Promise<PresetStatus> {
    signal.throwIfAborted()
    return await this.installer.status()
  }

  /**
   * Install the fixed bundled preset following an explicit sidebar action.
   * @param signal - request cancellation; never removes partially written user data.
   * @returns Setup result, including conflicts that require manual resolution.
   */
  @Remote
  async enable(signal: AbortSignal): Promise<PresetStatus> {
    return await this.installer.enable(signal)
  }

  /** Read the selected Session's local library without writing or activating a model. */
  @Remote
  async library(sessionId: string, signal: AbortSignal): Promise<LibrarySnapshot> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      return { workspace: scope.workspace, workspaceId: scope.workspaceId, writable: scope.writable, books: await scope.store.list() }
    })
  }

  /** Create a book under the Session's workspace after an explicit user action. */
  @Remote
  async createBook(sessionId: string, request: CreateBookRequest, signal: AbortSignal): Promise<BookSnapshot> {
    return await storageResult(async () => (await workspaceBooks(this.ctx, sessionId, true, signal)).store.createBook(request, signal))
  }

  /** Read one chapter and its actual on-disk baseline; never hides external edits. */
  @Remote
  async chapter(sessionId: string, bookId: string, chapterId: string, signal: AbortSignal): Promise<ChapterText> {
    return await storageResult(async () => (await workspaceBooks(this.ctx, sessionId, false, signal)).store.readChapter(bookId, chapterId))
  }

  /** Version-checked manual chapter changes; repeated operation IDs are idempotent. */
  @Remote
  async changeChapter(sessionId: string, request: ChapterMutationRequest, signal: AbortSignal): Promise<BookSnapshot> {
    return await storageResult(async () => (await workspaceBooks(this.ctx, sessionId, true, signal)).store.mutate(request, signal))
  }

  /** Explicitly settle an interrupted save; a third version is never overwritten. */
  @Remote
  async recoverBook(sessionId: string, bookId: string, signal: AbortSignal): Promise<BookSnapshot> {
    return await storageResult(async () => (await workspaceBooks(this.ctx, sessionId, true, signal)).store.recover(bookId, signal))
  }

  /** Preview current and intended text of a pending chapter save without writing. */
  @Remote
  async interruptedSave(sessionId: string, bookId: string, signal: AbortSignal): Promise<InterruptedChapterSave> {
    return await storageResult(async () => (await workspaceBooks(this.ctx, sessionId, false, signal)).store.interrupted(bookId))
  }

  /** Keep the original intention, then publish explicitly reviewed text as a new revision. */
  @Remote
  async settleInterruptedSave(sessionId: string, request: SettleInterruptedSaveRequest, signal: AbortSignal): Promise<BookSnapshot> {
    return await storageResult(async () => (await workspaceBooks(this.ctx, sessionId, true, signal)).store.settleInterrupted(request, signal))
  }

  /** Read up to 100 saved versions before a book revision; zero starts at the latest. */
  @Remote
  async chapterHistory(sessionId: string, bookId: string, chapterId: string, beforeRevision: number, signal: AbortSignal): Promise<ChapterHistorySummary[]> {
    return await storageResult(async () => new ChapterHistory((await workspaceBooks(this.ctx, sessionId, false, signal)).store).list(bookId, chapterId, beforeRevision))
  }

  /** Read one immutable chapter version without changing the current text. */
  @Remote
  async chapterVersion(sessionId: string, bookId: string, chapterId: string, operationId: string, signal: AbortSignal): Promise<ChapterHistoryVersion> {
    return await storageResult(async () => new ChapterHistory((await workspaceBooks(this.ctx, sessionId, false, signal)).store).read(bookId, chapterId, operationId))
  }

  /** Restore selected text as a new revision after rechecking the actual disk baseline. */
  @Remote
  async restoreChapter(sessionId: string, request: RestoreChapterRequest, signal: AbortSignal): Promise<BookSnapshot> {
    return await storageResult(async () => new ChapterHistory((await workspaceBooks(this.ctx, sessionId, true, signal)).store).restore(request, signal))
  }

  /** Preserve both the author's local draft and the current disk text. */
  @Remote
  async preserveConflict(sessionId: string, request: PreserveConflictRequest, signal: AbortSignal): Promise<ChapterConflict> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await (await ChapterConflicts.at(scope.root, scope.workspaceId, scope.store)).preserve(request, signal)
    })
  }

  /** Read retained drafts and their completed resolution states without writing. */
  @Remote
  async chapterConflicts(sessionId: string, bookId: string, chapterId: string, signal: AbortSignal): Promise<ChapterConflict[]> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      return await (await ChapterConflicts.at(scope.root, scope.workspaceId, scope.store)).list(bookId, chapterId)
    })
  }

  /** Save the explicitly selected disk, local or merged text with version protection. */
  @Remote
  async resolveConflict(sessionId: string, request: ResolveConflictRequest, signal: AbortSignal): Promise<BookSnapshot> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await (await ChapterConflicts.at(scope.root, scope.workspaceId, scope.store)).resolve(request, signal)
    })
  }

  /** Store an evidence-backed fact candidate; it does not change the chapter. */
  @Remote
  async proposeFacts(sessionId: string, request: ProposeFactsRequest, signal: AbortSignal): Promise<FactProposal> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await (await FactStore.at(scope.root, scope.workspaceId, scope.store)).propose(request, signal)
    })
  }

  @Remote
  async factProposals(sessionId: string, bookId: string, chapterId: string, signal: AbortSignal): Promise<FactProposal[]> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      return await (await FactStore.at(scope.root, scope.workspaceId, scope.store)).list(bookId, chapterId)
    })
  }

  @Remote
  async acceptFacts(sessionId: string, bookId: string, proposalId: string, expectedHash: string, signal: AbortSignal): Promise<FactProposal> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await (await FactStore.at(scope.root, scope.workspaceId, scope.store)).decide(bookId, proposalId, expectedHash, true, signal)
    })
  }

  @Remote
  async rejectFacts(sessionId: string, bookId: string, proposalId: string, expectedHash: string, signal: AbortSignal): Promise<FactProposal> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await (await FactStore.at(scope.root, scope.workspaceId, scope.store)).decide(bookId, proposalId, expectedHash, false, signal)
    })
  }

  /** Explicit read-only model extraction; validated results remain candidates until adoption. */
  @Remote
  async generateFacts(sessionId: string, request: GenerateFactsRequest, signal: AbortSignal): Promise<FactProposal> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      const key = `${scope.workspaceId}:${JSON.stringify(request)}`
      const existing = this.extractions.get(key)
      if (existing) return await existing
      const task = extractFacts(scope.store, await FactStore.at(scope.root, scope.workspaceId, scope.store), request, hostTextGenerator(this.ctx, scope.session), AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(300_000)]))
      this.extractions.set(key, task)
      try { return await task } finally { if (this.extractions.get(key) === task) this.extractions.delete(key) }
    })
  }

  /** Mechanical checks and isolated model review produce a persistent read-only assessment. */
  @Remote
  async voiceSamples(sessionId: string, bookId: string, signal: AbortSignal): Promise<VoiceSample[]> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      return await new VoiceStore(scope.store).list(bookId)
    })
  }

  @Remote
  async authorizeVoice(sessionId: string, request: AuthorizeVoiceRequest, signal: AbortSignal): Promise<BookSnapshot> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await new VoiceStore(scope.store).authorize(request, signal)
    })
  }

  @Remote
  async revokeVoice(sessionId: string, bookId: string, voiceId: string, expectedRevision: number, expectedHash: string, operationId: string, signal: AbortSignal): Promise<BookSnapshot> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await new VoiceStore(scope.store).revoke(bookId, voiceId, expectedRevision, expectedHash, operationId, signal)
    })
  }

  @Remote
  async previewImport(sessionId: string, request: ImportRequest, signal: AbortSignal): Promise<ImportPreview> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      return (await BookTransfer.at(scope.root, scope.store)).preview(request)
    })
  }

  @Remote
  async importBook(sessionId: string, request: ImportRequest, signal: AbortSignal): Promise<BookSnapshot> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await (await BookTransfer.at(scope.root, scope.store)).import(request, signal)
    })
  }

  @Remote
  async exportBook(sessionId: string, bookId: string, chapterIds: string[], signal: AbortSignal): Promise<ExportText> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      return await (await BookTransfer.at(scope.root, scope.store)).export(bookId, chapterIds)
    })
  }

  /** Mechanical checks and isolated model review produce a persistent read-only assessment. */
  @Remote
  async reviewChapter(sessionId: string, request: ReviewRequest, signal: AbortSignal): Promise<ReviewView> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      const key = `${scope.workspaceId}:${JSON.stringify(request)}`
      const existing = this.reviews.get(key)
      if (existing) return await existing
      let generate: ReturnType<typeof hostTextGenerator> | false = false
      try { generate = hostTextGenerator(this.ctx, scope.session) } catch {}
      const task = (await ReviewStore.at(scope.root, scope.workspaceId, scope.store)).run(request, generate, AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(300_000)]))
      this.reviews.set(key, task)
      try { return await task } finally { if (this.reviews.get(key) === task) this.reviews.delete(key) }
    })
  }

  @Remote
  async chapterReviews(sessionId: string, bookId: string, chapterId: string, signal: AbortSignal): Promise<ReviewView[]> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      return await (await ReviewStore.at(scope.root, scope.workspaceId, scope.store)).list(bookId, chapterId)
    })
  }

  /** A reviewed issue authorizes one local revision candidate, capped at two rounds. */
  @Remote
  async reviseIssue(sessionId: string, bookId: string, reviewId: string, issueId: string, proposalId: string, signal: AbortSignal): Promise<ProposalView> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      const review = await ReviewStore.at(scope.root, scope.workspaceId, scope.store)
      const revision = await review.revision(bookId, reviewId, issueId)
      const store = await ProposalStore.at(scope.root, scope.workspaceId, scope.store)
      return await this.tasks.start(store, sessionId, { ...revision.request, proposalId }, hostChapterGenerator(this.ctx, scope.session), signal)
    })
  }

  @Remote
  async factContext(sessionId: string, bookId: string, sourceChapterId: string, scopeName: string, maxBytes: number, signal: AbortSignal): Promise<FactContext> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      return await (await FactStore.at(scope.root, scope.workspaceId, scope.store)).context(bookId, sourceChapterId, scopeName, maxBytes)
    })
  }

  /** Explicit generation creates a separate durable candidate using the Session's model. */
  @Remote
  async generateChapter(sessionId: string, request: GenerateChapterRequest, signal: AbortSignal): Promise<ProposalView> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      const store = await ProposalStore.at(scope.root, scope.workspaceId, scope.store)
      return await this.tasks.start(store, sessionId, request, hostChapterGenerator(this.ctx, scope.session), signal)
    })
  }

  /** Pure query; reopening a candidate never dispatches another model call. */
  @Remote
  async proposals(sessionId: string, bookId: string, chapterId: string, signal: AbortSignal): Promise<ProposalSummary[]> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      const store = await ProposalStore.at(scope.root, scope.workspaceId, scope.store)
      return await store.list(bookId, chapterId, id => this.tasks.active(store, bookId, id))
    })
  }

  /** Read the persisted baseline, authorized range, candidate and completion state. */
  @Remote
  async proposal(sessionId: string, bookId: string, proposalId: string, signal: AbortSignal): Promise<ProposalView> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      const store = await ProposalStore.at(scope.root, scope.workspaceId, scope.store)
      return await store.view(bookId, proposalId, this.tasks.active(store, bookId, proposalId))
    })
  }

  /** Stop explicitly; partial prose is retained but cannot be adopted as complete. */
  @Remote
  async stopProposal(sessionId: string, bookId: string, proposalId: string, signal: AbortSignal): Promise<ProposalView> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await this.tasks.stop(await ProposalStore.at(scope.root, scope.workspaceId, scope.store), bookId, proposalId)
    })
  }

  /** Adoption rechecks the baseline and reuses the chapter's recoverable save protocol. */
  @Remote
  async acceptProposal(sessionId: string, request: ProposalDecisionRequest, signal: AbortSignal): Promise<ProposalView> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await (await ProposalStore.at(scope.root, scope.workspaceId, scope.store)).decide(request, true, signal)
    })
  }

  /** Rejecting a candidate never changes the chapter text. */
  @Remote
  async rejectProposal(sessionId: string, request: ProposalDecisionRequest, signal: AbortSignal): Promise<ProposalView> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await (await ProposalStore.at(scope.root, scope.workspaceId, scope.store)).decide(request, false, signal)
    })
  }
}

export default SuperNovel
