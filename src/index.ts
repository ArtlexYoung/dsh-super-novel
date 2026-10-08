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

export type { PresetStatus } from './types.js'
export type { BookSnapshot, ChapterMutationRequest, ChapterText, CreateBookRequest, LibrarySnapshot } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context { superNovel: SuperNovel }
}

/** User-initiated preset setup; it never changes the default mode or existing roots. */
export class SuperNovel extends TypertRemoteService {
  static inject = ['agentPresets']
  private readonly installer: PresetInstaller

  constructor(ctx: Context) {
    super(ctx, 'superNovel', { namespace: 'superNovel' })
    this.installer = new PresetInstaller(ctx.agentPresets, fileURLToPath(new URL('../presets/dsh-super-novel/', import.meta.url)), JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
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
}

export default SuperNovel
