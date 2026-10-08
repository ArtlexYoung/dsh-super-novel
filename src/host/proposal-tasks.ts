import { BookError, hash, json } from '../domain/books.js'
import { generationRequestSchema } from '../domain/proposals.js'
import { randomUUID } from 'node:crypto'
import type { GenerateChapterRequest, ProposalView } from '../types.js'
import type { ChapterGenerator } from './chapter-generator.js'
import { ProposalStore } from './proposal-store.js'
import { activeGenerationRuntimes, generationMachine } from './proposal-runtime.js'

interface RunningTask { readonly controller: AbortController; readonly done: Promise<void> }

/** Detached from browser requests; only explicit stop, timeout, or unload cancels. */
export class ProposalTasks {
  private readonly running = new Map<string, RunningTask>()
  private disposed = false
  constructor(private readonly timeoutMs = 5 * 60_000) {}
  private key(store: ProposalStore, bookId: string, proposalId: string): string { return `${store.workspaceId}:${bookId}:${proposalId}` }
  active(store: ProposalStore, bookId: string, proposalId: string): boolean { return this.running.has(this.key(store, bookId, proposalId)) }

  async start(store: ProposalStore, sessionId: string, request: GenerateChapterRequest, generate: ChapterGenerator, signal: AbortSignal): Promise<ProposalView> {
    if (this.disposed) throw new BookError('generation-unavailable')
    const activeKey = this.key(store, request.bookId, request.proposalId)
    if (this.running.has(activeKey)) {
      const proposal = await store.read(request.bookId, request.proposalId)
      if (proposal.requestHash !== hash(json(generationRequestSchema.parse(request)))) throw new BookError('operation-conflict')
      return await store.view(request.bookId, request.proposalId, true)
    }
    const owner = { machine: generationMachine, pid: process.pid, runtimeId: randomUUID() }
    activeGenerationRuntimes.add(owner.runtimeId)
    let createdProposal
    try { createdProposal = await store.create(sessionId, request, signal, owner) }
    catch (error) { activeGenerationRuntimes.delete(owner.runtimeId); throw error }
    const { proposal, created } = createdProposal
    if (!created) activeGenerationRuntimes.delete(owner.runtimeId)
    if (created && this.disposed) {
      activeGenerationRuntimes.delete(owner.runtimeId)
      await store.checkpoint(request.bookId, request.proposalId, undefined, 'interrupted', 'host-unloaded', { state: 'unknown' }, 0)
      throw new BookError('generation-unavailable')
    }
    if (created) {
      const controller = new AbortController()
      const key = activeKey
      const timer = setTimeout(() => controller.abort(new BookError('generation-timeout')), this.timeoutMs)
      const started = Date.now()
      const progress = async (replacement: string): Promise<void> => {
        const checkpoint = await store.checkpoint(request.bookId, request.proposalId, replacement, 'generating', '', { state: 'unknown' }, Math.max(0, Date.now() - started))
        if (checkpoint.state !== 'generating') throw new BookError('generation-cancelled')
      }
      const done = (async () => {
        try {
          const result = await new Promise<Awaited<ReturnType<ChapterGenerator>>>((resolve, reject) => {
            const abort = () => reject(controller.signal.reason)
            controller.signal.addEventListener('abort', abort, { once: true })
            generate(proposal, controller.signal, progress).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort))
          })
          controller.signal.throwIfAborted()
          await store.checkpoint(request.bookId, request.proposalId, result.replacement, result.complete ? 'review' : 'interrupted', result.reason, result.usage, Math.max(0, Date.now() - started))
        } catch (error) {
          const reason = controller.signal.aborted ? controller.signal.reason instanceof BookError ? controller.signal.reason.code : 'generation-cancelled' : error instanceof BookError ? error.code : 'generation-failed'
          // Keep the last durable prefix; private adapter and filesystem errors never enter the record.
          await store.checkpoint(request.bookId, request.proposalId, undefined, 'interrupted', reason, { state: 'unknown' }, Math.max(0, Date.now() - started))
        }
      })().catch(() => { /* A failed checkpoint remains explicitly interrupted on reopening. */ }).finally(() => { clearTimeout(timer); this.running.delete(key); activeGenerationRuntimes.delete(owner.runtimeId) })
      this.running.set(key, { controller, done })
    }
    return await store.view(request.bookId, request.proposalId, this.active(store, request.bookId, request.proposalId))
  }

  async stop(store: ProposalStore, bookId: string, proposalId: string): Promise<ProposalView> {
    const task = this.running.get(this.key(store, bookId, proposalId))
    task?.controller.abort(new BookError('generation-cancelled'))
    if (task) await task.done
    else {
      if (await store.runningElsewhere(bookId, proposalId)) throw new BookError('busy')
      const proposal = await store.read(bookId, proposalId)
      if (proposal.state === 'generating') await store.checkpoint(bookId, proposalId, proposal.replacement, 'interrupted', 'host-restarted', proposal.usage, proposal.elapsedMs)
    }
    return await store.view(bookId, proposalId, false)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const tasks = [...this.running.values()]
    for (const task of tasks) task.controller.abort(new BookError('host-unloaded'))
    await Promise.all(tasks.map(task => task.done))
  }
}
