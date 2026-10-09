/** Host service and browser discovery entry for the novel-generation bundle. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { lstat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createPresetSetup } from './host/preset-setup.js'
import type { PresetStatus } from './types.js'
import type { BookSnapshot, ChapterMutationRequest, ChapterText, CreateBookRequest, LibrarySnapshot } from './types.js'
import { storageResult, workspaceBooks, workspaceAccess } from './host/workspace-books.js'
import { StorageLocations, inside, libraryPath } from './host/storage-location.js'
import { z } from 'zod'
import { idSchema, titleSchema, materialKind } from './domain/books.js'
import { BookError, hash } from './domain/books.js'
import { MaterialCatalog } from './host/material-catalog.js'
import type { UpgradeBookRequest, MaterialMetadataRequest, MaterialSearchRequest, MaterialSearchResult, MaterialReferences, SelectionMaterialRequest } from './types.js'
import { BackupStore } from './host/backup-store.js'
import type { BackupSettings, BackupSummary, BackupPreview, BackupHealth, BackupQuery, BackupConfiguration, RestoreBackupRequest } from './types.js'
import { randomUUID } from 'node:crypto'
import { DraftStore } from './host/draft-store.js'
import { BookFiles } from './host/book-files.js'
import type { StorageLocation, ChangeStorageLocationRequest, PickStorageLocation, DraftQuery, DraftRequest, DraftSummary, DraftVersionQuery, DiskDraft, SettleDraftRequest, DraftListing } from './types.js'
import type { GenerateChapterRequest, ProposalDecisionRequest, ProposalSummary, ProposalView } from './types.js'
import { ProposalStore } from './host/proposal-store.js'
import { IntentStore } from './host/intent-store.js'
import { StoryStore } from './host/story-store.js'
import { chapterImpacts } from './host/chapter-impacts.js'
import type { StoryState, SaveStoryStateRequest, SuggestStoryStateRequest, StoryStateSuggestion, ChapterImpacts } from './types.js'
import type { ChapterIntent, SaveIntentRequest, SuggestIntentRequest, IntentSuggestion, GenerationContextPreview } from './types.js'
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

/** Host-specific preset setup; it never changes the default mode or existing roots. */
export class SuperNovel extends TypertRemoteService {
  static inject = ['agentPresets']
  private readonly installer: ReturnType<typeof createPresetSetup>
  private readonly tasks = new ProposalTasks()
  private readonly backupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly backupJobs = new Set<Promise<void>>()
  private readonly lifetime = new AbortController()
  private readonly extractions = new Map<string, Promise<FactProposal>>()
  private readonly reviews = new Map<string, Promise<ReviewView>>()
  private readonly storySuggestions = new Map<string, Promise<StoryStateSuggestion>>()
  private readonly directions = new Map<string, Promise<IntentSuggestion>>()

  constructor(ctx: Context) {
    super(ctx, 'superNovel', { namespace: 'superNovel' })
    this.installer = createPresetSetup(ctx, ctx.agentPresets, fileURLToPath(new URL('../presets/dsh-super-novel/', import.meta.url)), JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
    ctx.effect(() => async () => {
      this.lifetime.abort()
      for (const timer of this.backupTimers.values()) clearTimeout(timer)
      this.backupTimers.clear()
      await Promise.allSettled([this.tasks.dispose(), ...this.extractions.values(), ...this.reviews.values(), ...this.directions.values(), ...this.storySuggestions.values(), ...this.backupJobs])
    })
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

  /** Inspect the selected library, even when its removable disk is unavailable. */
  @Remote
  async storageLocation(sessionId: string, signal: AbortSignal): Promise<StorageLocation> {
    return await storageResult(async () => {
      const access = await workspaceAccess(this.ctx, sessionId, signal)
      const location = await (await StorageLocations.at(access.root)).read()
      const picker = this.ctx.get('directoryPicker') as { capability(): { kind: string } } | undefined
      const controller = this.ctx.get('sessionController')
      return { ...location, defaultRoot: access.root, path: libraryPath(location.root), workspaceId: hash(location.root),
        writable: access.mode !== 'read-only' && (access.mode === 'danger-full-access' || inside(access.root, location.root)),
        canChange: access.mode !== 'read-only', canPick: picker?.capability().kind === 'native', canOpen: typeof controller?.workspaceDesktop === 'function' && controller.workspaceDesktop().available }
    })
  }

  /** Explicitly switch libraries; old data and in-flight tasks stay at their original root. */
  @Remote
  async changeStorageLocation(sessionId: string, request: ChangeStorageLocationRequest, signal: AbortSignal): Promise<StorageLocation> {
    return await storageResult(async () => {
      const access = await workspaceAccess(this.ctx, sessionId, signal)
      const locations = await StorageLocations.at(access.root)
      await locations.validate(request.root, access.mode)
      const fs = this.ctx.get('fs')
      if (!fs) throw new BookError('host-unavailable')
      const target = await fs.resolve(request.root, { signal })
      if (fs.processPathFromHostPath(request.root) !== request.root || fs.processPath(target) !== request.root) throw new BookError('local-only')
      await locations.change(request.root, request.expectedWorkspaceId, access.mode, signal)
      return await this.storageLocation(sessionId, signal)
    })
  }

  /** Use the host's native chooser when present; cancellation is an explicit result. */
  @Remote
  async pickStorageLocation(sessionId: string, signal: AbortSignal): Promise<PickStorageLocation> {
    return await storageResult(async () => {
      const access = await workspaceAccess(this.ctx, sessionId, signal)
      if (access.mode === 'read-only') throw new BookError('read-only')
      const picker = this.ctx.get('directoryPicker') as { capability(): { kind: string; pick?: (signal: AbortSignal) => Promise<string | null> } } | undefined
      const capability = picker?.capability()
      if (capability?.kind !== 'native' || !capability.pick) throw new BookError('directory-picker-unavailable')
      const root = await capability.pick(signal)
      return { selected: root !== null, root: root ?? '' }
    })
  }

  /** Open only the selected library root via the host's existing native opener. */
  @Remote
  async openStorageLocation(sessionId: string, expectedWorkspaceId: string, signal: AbortSignal): Promise<{ opened: boolean }> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      if (scope.workspaceId !== expectedWorkspaceId) throw new BookError('location-changed')
      const controller = this.ctx.get('sessionController')
      if (typeof controller?.openWorkspacePath !== 'function' || !controller.workspaceDesktop().available) throw new BookError('native-open-unavailable')
      const path = await (await BookFiles.at(scope.root)).path('novels')
      let selected = path
      try { if (!(await lstat(path)).isDirectory()) throw new BookError('unsafe-path') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') selected = scope.root; else throw error }
      return await controller.openWorkspacePath({ path: selected }, signal)
    })
  }

  private scheduleBackup(root: string, bookId: string, sessionId: string): void {
    const key = `${root}:${bookId}`
    if (this.backupTimers.has(key) || this.lifetime.signal.aborted) return
    const timer = setTimeout(() => {
      this.backupTimers.delete(key)
      const job = (async () => {
        const scope = await workspaceBooks(this.ctx, sessionId, true, this.lifetime.signal)
        if (scope.root !== root) return
        const backups = await BackupStore.at(root), settings = await backups.settings()
        await (await StorageLocations.at(scope.defaultRoot)).validate(settings.root, scope.mode)
        if (settings.automatic) await backups.create(bookId, randomUUID(), this.lifetime.signal)
      })().catch(() => { /* A failed attempt never updates the verified backup list. */ }).finally(() => this.backupJobs.delete(job))
      this.backupJobs.add(job)
    }, 15 * 60 * 1000)
    timer.unref(); this.backupTimers.set(key, timer)
  }

  private async backedUp<T>(root: string, bookId: string, sessionId: string, write: Promise<T>): Promise<T> {
    const value = await write
    this.scheduleBackup(root, bookId, sessionId)
    return value
  }

  private async backupScope(sessionId: string, workspaceId: string, writing: boolean, signal: AbortSignal) {
    const scope = await workspaceBooks(this.ctx, sessionId, writing, signal)
    if (scope.workspaceId !== workspaceId) throw new BookError('location-changed')
    return scope
  }

  @Remote
  async backupSettings(sessionId: string, workspaceId: string, signal: AbortSignal): Promise<BackupSettings> {
    return await storageResult(async () => {
      const scope = await this.backupScope(sessionId, workspaceId, false, signal)
      return await (await BackupStore.at(scope.root)).settings()
    })
  }

  @Remote
  async configureBackups(sessionId: string, request: BackupConfiguration, signal: AbortSignal): Promise<BackupSettings> {
    return await storageResult(async () => {
      const scope = await this.backupScope(sessionId, request.workspaceId, true, signal)
      await (await StorageLocations.at(scope.defaultRoot)).validate(request.root, scope.mode)
      return await (await BackupStore.at(scope.root)).configure(request.root, request.automatic, 'danger-full-access')
    })
  }

  @Remote
  async backupHealth(sessionId: string, workspaceId: string, bookId: string, signal: AbortSignal): Promise<BackupHealth> {
    return await storageResult(async () => {
      const scope = await this.backupScope(sessionId, workspaceId, false, signal)
      return await (await BackupStore.at(scope.root)).health(bookId)
    })
  }

  @Remote
  async backupCatalog(sessionId: string, workspaceId: string, signal: AbortSignal): Promise<BackupSummary[]> {
    return await storageResult(async () => {
      const scope = await this.backupScope(sessionId, workspaceId, false, signal)
      return await (await BackupStore.at(scope.root)).catalog()
    })
  }

  @Remote
  async bookBackups(sessionId: string, workspaceId: string, bookId: string, signal: AbortSignal): Promise<BackupSummary[]> {
    return await storageResult(async () => {
      const scope = await this.backupScope(sessionId, workspaceId, false, signal)
      return await (await BackupStore.at(scope.root)).list(bookId)
    })
  }

  @Remote
  async createBackup(sessionId: string, query: BackupQuery, signal: AbortSignal): Promise<BackupSummary> {
    return await storageResult(async () => {
      const scope = await this.backupScope(sessionId, query.workspaceId, true, signal)
      const backups = await BackupStore.at(scope.root)
      await (await StorageLocations.at(scope.defaultRoot)).validate((await backups.settings()).root, scope.mode)
      return await backups.create(query.bookId, query.backupId, signal)
    })
  }

  @Remote
  async inspectBackup(sessionId: string, query: BackupQuery, signal: AbortSignal): Promise<BackupPreview> {
    return await storageResult(async () => {
      const scope = await this.backupScope(sessionId, query.workspaceId, false, signal)
      return await (await BackupStore.at(scope.root)).inspect(query.bookId, query.backupId, signal)
    })
  }

  @Remote
  async restoreBackup(sessionId: string, request: RestoreBackupRequest, signal: AbortSignal): Promise<{ root: string; bookId: string }> {
    return await storageResult(async () => {
      const scope = await this.backupScope(sessionId, request.workspaceId, true, signal)
      return await (await BackupStore.at(scope.root)).restore(request.bookId, request.backupId, request.manifestHash, signal)
    })
  }

  @Remote
  async openBackupLocation(sessionId: string, workspaceId: string, signal: AbortSignal): Promise<{ opened: boolean }> {
    return await storageResult(async () => {
      const scope = await this.backupScope(sessionId, workspaceId, false, signal)
      const settings = await (await BackupStore.at(scope.root)).settings(), files = await BookFiles.at(settings.root)
      let path = settings.path
      try { if (!(await lstat(await files.path('.super-novel-backups'))).isDirectory()) throw new BookError('unsafe-path') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') path = files.root; else throw error }
      const controller = this.ctx.get('sessionController')
      if (!controller?.workspaceDesktop().available) throw new BookError('native-open-unavailable')
      return await controller.openWorkspacePath({ path }, signal)
    })
  }

  @Remote
  async upgradeBook(sessionId: string, request: UpgradeBookRequest, signal: AbortSignal): Promise<BookSnapshot> {
    return await storageResult(async () => {
      const scope = await this.backupScope(sessionId, request.workspaceId, true, signal)
      const backups = await BackupStore.at(scope.root)
      await (await StorageLocations.at(scope.defaultRoot)).validate((await backups.settings()).root, scope.mode)
      const book = await scope.store.readBook(request.bookId)
      if (book.schemaVersion === 1) await backups.create(request.bookId, request.backupId, signal)
      return await this.backedUp(scope.root, request.bookId, sessionId, scope.store.upgrade(request.bookId, request.expectedRevision, request.operationId, signal))
    })
  }

  @Remote
  async updateMaterial(sessionId: string, request: MaterialMetadataRequest, signal: AbortSignal): Promise<BookSnapshot> {
    return await storageResult(async () => {
      const scope = await this.backupScope(sessionId, request.workspaceId, true, signal)
      const result = await scope.store.metadata(request, signal)
      this.scheduleBackup(scope.root, request.bookId, sessionId)
      return result
    })
  }

  @Remote
  async searchMaterials(sessionId: string, request: MaterialSearchRequest, signal: AbortSignal): Promise<MaterialSearchResult> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      return await (await MaterialCatalog.at(scope.root, scope.store)).search(request, signal)
    })
  }

  @Remote
  async materialReferences(sessionId: string, bookId: string, chapterId: string, signal: AbortSignal): Promise<MaterialReferences> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      return await (await MaterialCatalog.at(scope.root, scope.store)).references(bookId, chapterId, signal)
    })
  }

  @Remote
  async selectionMaterial(sessionId: string, input: SelectionMaterialRequest, signal: AbortSignal): Promise<BookSnapshot> {
    return await storageResult(async () => {
      const request = z.strictObject({ workspaceId: z.string(), bookId: idSchema, expectedRevision: z.int().positive(), sourceChapterId: idSchema, sourceHash: z.string(), start: z.int().nonnegative(), end: z.int().positive(), title: titleSchema, kind: z.string(), operationId: idSchema, chapterId: idSchema }).parse(input)
      const scope = await this.backupScope(sessionId, request.workspaceId, true, signal)
      if (!materialKind(request.kind)) throw new BookError('invalid-material')
      const source = await scope.store.readChapter(request.bookId, request.sourceChapterId), metadata = source.book.chapters.find(item => item.chapterId === request.sourceChapterId)!
      if (source.book.schemaVersion !== 2) throw new BookError('migration-required')
      if (source.book.revision !== request.expectedRevision || source.hash !== request.sourceHash || source.externallyModified) throw new BookError('revision-conflict')
      if (request.end <= request.start || request.end > source.content.length) throw new BookError('invalid-evidence')
      const quote = source.content.slice(request.start, request.end)
      return await this.backedUp(scope.root, request.bookId, sessionId, scope.store.mutate({ workspaceId: scope.workspaceId, operationId: request.operationId, bookId: request.bookId, expectedRevision: request.expectedRevision, chapterId: request.chapterId,
        action: 'create', title: request.title, content: quote, expectedHash: '', beforeChapterId: '', kind: request.kind as SelectionMaterialRequest['kind'],
        ...(!metadata.kind || metadata.kind === 'chapter' ? { linkedChapterIds: [request.sourceChapterId] } : {}), sourceEvidence: { chapterId: metadata.chapterId, revision: metadata.revision, hash: source.hash, quote, start: request.start, end: request.end } }, signal))
    })
  }

  /** Checkpoints are independent from formal chapter revisions and AI adoption. */
  @Remote
  async checkpointDraft(sessionId: string, request: DraftRequest, signal: AbortSignal): Promise<DraftSummary> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      const result = await (await DraftStore.at(scope.root, scope.workspaceId, scope.store)).put(request, signal)
      this.scheduleBackup(scope.root, request.bookId, sessionId)
      return result
    })
  }

  /** Read recoverable editor branches without creating storage. */
  @Remote
  async chapterDrafts(sessionId: string, query: DraftQuery, signal: AbortSignal): Promise<DraftListing> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      return await (await DraftStore.at(scope.root, scope.workspaceId, scope.store)).list(query)
    })
  }

  /** Preview one immutable checkpoint. */
  @Remote
  async readDraft(sessionId: string, query: DraftVersionQuery, signal: AbortSignal): Promise<DiskDraft> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      return await (await DraftStore.at(scope.root, scope.workspaceId, scope.store)).read(query)
    })
  }

  /** Retain history while resolving exactly the reviewed checkpoint. */
  @Remote
  async settleDraft(sessionId: string, request: SettleDraftRequest, signal: AbortSignal): Promise<DraftSummary> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await this.backedUp(scope.root, request.bookId, sessionId, (await DraftStore.at(scope.root, scope.workspaceId, scope.store)).settle(request, signal))
    })
  }

  /** Create a book under the Session's workspace after an explicit user action. */
  @Remote
  async createBook(sessionId: string, request: CreateBookRequest, signal: AbortSignal): Promise<BookSnapshot> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal), book = await scope.store.createBook(request, signal)
      this.scheduleBackup(scope.root, book.bookId, sessionId)
      return book
    })
  }

  /** Read one chapter and its actual on-disk baseline; never hides external edits. */
  @Remote
  async chapter(sessionId: string, bookId: string, chapterId: string, signal: AbortSignal): Promise<ChapterText> {
    return await storageResult(async () => (await workspaceBooks(this.ctx, sessionId, false, signal)).store.readChapter(bookId, chapterId))
  }

  /** Version-checked manual chapter changes; repeated operation IDs are idempotent. */
  @Remote
  async chapterIntent(sessionId: string, bookId: string, chapterId: string, signal: AbortSignal): Promise<ChapterIntent> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      return await (await IntentStore.at(scope.root, scope.workspaceId, scope.store)).read(bookId, chapterId)
    })
  }

  @Remote
  async storyState(sessionId: string, bookId: string, signal: AbortSignal): Promise<StoryState> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      return await (await StoryStore.at(scope.root, scope.workspaceId, scope.store)).read(bookId)
    })
  }

  @Remote
  async saveStoryState(sessionId: string, request: SaveStoryStateRequest, signal: AbortSignal): Promise<StoryState> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal), value = await (await StoryStore.at(scope.root, scope.workspaceId, scope.store)).save(request, signal)
      this.scheduleBackup(scope.root, request.bookId, sessionId)
      return value
    })
  }

  @Remote
  async chapterStateSuggestions(sessionId: string, bookId: string, chapterId: string, signal: AbortSignal): Promise<StoryStateSuggestion[]> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      return await (await StoryStore.at(scope.root, scope.workspaceId, scope.store)).suggestions(bookId, chapterId)
    })
  }

  @Remote
  async suggestChapterState(sessionId: string, request: SuggestStoryStateRequest, signal: AbortSignal): Promise<StoryStateSuggestion> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal), key = `${scope.workspaceId}:${JSON.stringify(request)}`
      const existing = this.storySuggestions.get(key)
      if (existing) return await existing
      const task = (await StoryStore.at(scope.root, scope.workspaceId, scope.store)).suggest(request, hostTextGenerator(this.ctx, scope.session), AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(300_000)]))
      this.storySuggestions.set(key, task)
      try { const value = await task; this.scheduleBackup(scope.root, request.bookId, sessionId); return value }
      finally { if (this.storySuggestions.get(key) === task) this.storySuggestions.delete(key) }
    })
  }

  @Remote
  async chapterImpacts(sessionId: string, bookId: string, chapterId: string, signal: AbortSignal): Promise<ChapterImpacts> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      return await chapterImpacts(scope.root, scope.workspaceId, scope.store, bookId, chapterId, signal)
    })
  }

  @Remote
  async saveChapterIntent(sessionId: string, request: SaveIntentRequest, signal: AbortSignal): Promise<ChapterIntent> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      const value = await (await IntentStore.at(scope.root, scope.workspaceId, scope.store)).save(request, signal)
      this.scheduleBackup(scope.root, request.bookId, sessionId)
      return value
    })
  }

  @Remote
  async intentSuggestions(sessionId: string, bookId: string, chapterId: string, signal: AbortSignal): Promise<IntentSuggestion[]> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      return await (await IntentStore.at(scope.root, scope.workspaceId, scope.store)).list(bookId, chapterId)
    })
  }

  /** One explicit paid call; directions remain author planning until saved. */
  @Remote
  async suggestChapterIntent(sessionId: string, request: SuggestIntentRequest, signal: AbortSignal): Promise<IntentSuggestion> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal), key = `${scope.workspaceId}:${JSON.stringify(request)}`
      const existing = this.directions.get(key)
      if (existing) return await existing
      const task = (await IntentStore.at(scope.root, scope.workspaceId, scope.store)).suggest(request, hostTextGenerator(this.ctx, scope.session), AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(300_000)]))
      this.directions.set(key, task)
      try { const value = await task; this.scheduleBackup(scope.root, request.bookId, sessionId); return value }
      finally { if (this.directions.get(key) === task) this.directions.delete(key) }
    })
  }

  /** Inspect exactly the selected generation inputs, without writes or model calls. */
  @Remote
  async generationContext(sessionId: string, request: GenerateChapterRequest, signal: AbortSignal): Promise<GenerationContextPreview> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, false, signal)
      return await (await ProposalStore.at(scope.root, scope.workspaceId, scope.store)).preview(request, signal)
    })
  }

  /** Version-checked manual chapter changes; repeated operation IDs are idempotent. */
  @Remote
  async changeChapter(sessionId: string, request: ChapterMutationRequest, signal: AbortSignal): Promise<BookSnapshot> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      if (request.workspaceId && scope.workspaceId !== request.workspaceId) throw new BookError('location-changed')
      const result = await scope.store.mutate(request, signal)
      this.scheduleBackup(scope.root, request.bookId, sessionId)
      return result
    })
  }

  /** Explicitly settle an interrupted save; a third version is never overwritten. */
  @Remote
  async recoverBook(sessionId: string, bookId: string, signal: AbortSignal): Promise<BookSnapshot> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await this.backedUp(scope.root, bookId, sessionId, scope.store.recover(bookId, signal))
    })
  }

  /** Preview current and intended text of a pending chapter save without writing. */
  @Remote
  async interruptedSave(sessionId: string, bookId: string, signal: AbortSignal): Promise<InterruptedChapterSave> {
    return await storageResult(async () => (await workspaceBooks(this.ctx, sessionId, false, signal)).store.interrupted(bookId))
  }

  /** Keep the original intention, then publish explicitly reviewed text as a new revision. */
  @Remote
  async settleInterruptedSave(sessionId: string, request: SettleInterruptedSaveRequest, signal: AbortSignal): Promise<BookSnapshot> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await this.backedUp(scope.root, request.bookId, sessionId, scope.store.settleInterrupted(request, signal))
    })
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
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await this.backedUp(scope.root, request.bookId, sessionId, new ChapterHistory(scope.store).restore(request, signal))
    })
  }

  /** Preserve both the author's local draft and the current disk text. */
  @Remote
  async preserveConflict(sessionId: string, request: PreserveConflictRequest, signal: AbortSignal): Promise<ChapterConflict> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await this.backedUp(scope.root, request.bookId, sessionId, (await ChapterConflicts.at(scope.root, scope.workspaceId, scope.store)).preserve(request, signal))
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
      return await this.backedUp(scope.root, request.bookId, sessionId, (await ChapterConflicts.at(scope.root, scope.workspaceId, scope.store)).resolve(request, signal))
    })
  }

  /** Store an evidence-backed fact candidate; it does not change the chapter. */
  @Remote
  async proposeFacts(sessionId: string, request: ProposeFactsRequest, signal: AbortSignal): Promise<FactProposal> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await this.backedUp(scope.root, request.bookId, sessionId, (await FactStore.at(scope.root, scope.workspaceId, scope.store)).propose(request, signal))
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
      return await this.backedUp(scope.root, bookId, sessionId, (await FactStore.at(scope.root, scope.workspaceId, scope.store)).decide(bookId, proposalId, expectedHash, true, signal))
    })
  }

  @Remote
  async rejectFacts(sessionId: string, bookId: string, proposalId: string, expectedHash: string, signal: AbortSignal): Promise<FactProposal> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await this.backedUp(scope.root, bookId, sessionId, (await FactStore.at(scope.root, scope.workspaceId, scope.store)).decide(bookId, proposalId, expectedHash, false, signal))
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
      try { return await this.backedUp(scope.root, request.bookId, sessionId, task) } finally { if (this.extractions.get(key) === task) this.extractions.delete(key) }
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
      return await this.backedUp(scope.root, request.bookId, sessionId, new VoiceStore(scope.store).authorize(request, signal))
    })
  }

  @Remote
  async revokeVoice(sessionId: string, bookId: string, voiceId: string, expectedRevision: number, expectedHash: string, operationId: string, signal: AbortSignal): Promise<BookSnapshot> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await this.backedUp(scope.root, bookId, sessionId, new VoiceStore(scope.store).revoke(bookId, voiceId, expectedRevision, expectedHash, operationId, signal))
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
      const book = await (await BookTransfer.at(scope.root, scope.store)).import(request, signal)
      this.scheduleBackup(scope.root, book.bookId, sessionId)
      return book
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
      try { return await this.backedUp(scope.root, request.bookId, sessionId, task) } finally { if (this.reviews.get(key) === task) this.reviews.delete(key) }
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
      return await this.backedUp(scope.root, bookId, sessionId, this.tasks.start(store, sessionId, { ...revision.request, proposalId }, hostChapterGenerator(this.ctx, scope.session), signal))
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
      return await this.backedUp(scope.root, request.bookId, sessionId, this.tasks.start(store, sessionId, request, hostChapterGenerator(this.ctx, scope.session), signal))
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
      return await this.backedUp(scope.root, bookId, sessionId, this.tasks.stop(await ProposalStore.at(scope.root, scope.workspaceId, scope.store), bookId, proposalId))
    })
  }

  /** Adoption rechecks the baseline and reuses the chapter's recoverable save protocol. */
  @Remote
  async acceptProposal(sessionId: string, request: ProposalDecisionRequest, signal: AbortSignal): Promise<ProposalView> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await this.backedUp(scope.root, request.bookId, sessionId, (await ProposalStore.at(scope.root, scope.workspaceId, scope.store)).decide(request, true, signal))
    })
  }

  /** Rejecting a candidate never changes the chapter text. */
  @Remote
  async rejectProposal(sessionId: string, request: ProposalDecisionRequest, signal: AbortSignal): Promise<ProposalView> {
    return await storageResult(async () => {
      const scope = await workspaceBooks(this.ctx, sessionId, true, signal)
      return await this.backedUp(scope.root, request.bookId, sessionId, (await ProposalStore.at(scope.root, scope.workspaceId, scope.store)).decide(request, false, signal))
    })
  }
}

export default SuperNovel
