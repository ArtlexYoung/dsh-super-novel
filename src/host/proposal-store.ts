import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { BookError, contentSchema, hash, idSchema, json } from '../domain/books.js'
import { adoption, candidate, decisionSchema, generationPrompt, generationRequestSchema, parseProposal, proposalView, validateRange } from '../domain/proposals.js'
import type { Proposal } from '../domain/proposals.js'
import type { GenerateChapterRequest, GenerationUsage, ProposalDecisionRequest, ProposalSummary, ProposalView } from '../types.js'
import { BookFiles } from './book-files.js'
import { BookStore } from './book-store.js'
import { generationMachine, ownerRunning } from './proposal-runtime.js'
import type { GenerationOwner } from './proposal-runtime.js'
import { FactStore } from './fact-store.js'

const queues = new Map<string, Promise<void>>()

export class ProposalStore {
  private constructor(private readonly files: BookFiles, readonly books: BookStore, readonly workspaceId: string) {}

  static async at(workspace: string, workspaceId: string, books?: BookStore): Promise<ProposalStore> {
    return new ProposalStore(await BookFiles.at(workspace), books ?? await BookStore.at(workspace), workspaceId)
  }
  private folder(bookId: string): string { return join('novels', idSchema.parse(bookId)) }
  private path(bookId: string, proposalId: string): string { return join(this.folder(bookId), 'proposals', `${idSchema.parse(proposalId)}.json`) }
  private async locked<T>(bookId: string, fn: () => Promise<T>): Promise<T> {
    const key = `${this.files.root}:${bookId}`
    const result = (queues.get(key) ?? Promise.resolve()).then(() => this.files.lock(join(this.folder(bookId), '.proposal.lock'), fn))
    const done = result.then(() => {}, () => {})
    queues.set(key, done)
    try { return await result }
    finally { if (queues.get(key) === done) queues.delete(key) }
  }

  async read(bookId: string, proposalId: string): Promise<Proposal> {
    const file = await this.files.read(this.path(bookId, proposalId), 32 * 1024 * 1024)
    if (!file.exists) throw new BookError('proposal-not-found')
    return parseProposal(file.text, this.workspaceId, bookId, proposalId)
  }

  private async write(proposal: Proposal, before: { exists: boolean; text: string }): Promise<void> {
    const text = json(proposal)
    if (Buffer.byteLength(text, 'utf8') > 32 * 1024 * 1024) throw new BookError('too-large')
    parseProposal(text, this.workspaceId, proposal.request.bookId, proposal.request.proposalId)
    await this.files.replace(this.path(proposal.request.bookId, proposal.request.proposalId), text, before)
  }

  async create(sessionId: string, input: GenerateChapterRequest, signal: AbortSignal, owner: GenerationOwner = { machine: generationMachine, pid: process.pid, runtimeId: randomUUID() }): Promise<{ proposal: Proposal; created: boolean }> {
    const request = generationRequestSchema.parse(input)
    return await this.locked(request.bookId, async () => {
      signal.throwIfAborted()
      const file = await this.files.read(this.path(request.bookId, request.proposalId), 32 * 1024 * 1024)
      if (file.exists) {
        const proposal = parseProposal(file.text, this.workspaceId, request.bookId, request.proposalId)
        if (proposal.requestHash !== hash(json(request))) throw new BookError('operation-conflict')
        return { proposal, created: false }
      }
      const chapter = await this.books.readChapter(request.bookId, request.chapterId)
      if (chapter.book.revision !== request.expectedRevision || chapter.hash !== request.expectedHash || chapter.externallyModified) throw new BookError('revision-conflict')
      validateRange(request, chapter.content)
      const context = []
      for (const id of request.materialIds ?? []) {
        const selected = await this.books.readChapter(request.bookId, id)
        const document = selected.book.chapters.find(item => item.chapterId === id)!
        if (!document.kind || document.kind === 'chapter' || document.kind === 'facts' || id === request.chapterId) throw new BookError('invalid-material')
        if (selected.externallyModified || selected.book.revision !== request.expectedRevision) throw new BookError('revision-conflict')
        if (!selected.content.trim()) throw new BookError('material-empty')
        context.push({ chapterId: id, title: document.title, kind: document.kind, revision: document.revision, hash: selected.hash, content: selected.content })
      }
      const now = Date.now()
      const facts = request.useFacts ? await (await FactStore.at(this.files.root, this.workspaceId, this.books)).context(request.bookId, request.chapterId, request.knowledgeScope ?? 'reader', 128 * 1024) : undefined
      if (facts && facts.state !== 'complete') throw new BookError(facts.state === 'over-budget' ? 'context-too-large' : 'facts-incomplete')
      if ((await this.books.readBook(request.bookId)).revision !== request.expectedRevision) throw new BookError('revision-conflict')
      const proposal: Proposal = { schemaVersion: 1, workspaceId: this.workspaceId, sessionId, owner, request,
        requestHash: hash(json(request)), acceptanceId: randomUUID(), baseline: chapter.content,
        baselineChapterRevision: chapter.book.chapters.find(item => item.chapterId === request.chapterId)!.revision,
        createdAt: now, updatedAt: now, state: 'generating', reason: '', replacement: '',
        candidateHash: '', elapsedMs: 0, usage: { state: 'unknown' },
        ...(chapter.book.chapters.find(item => item.chapterId === request.chapterId)!.kind ? { documentKind: chapter.book.chapters.find(item => item.chapterId === request.chapterId)!.kind } : {}),
        ...(request.materialIds ? { context } : {}),
        ...(facts ? { factContext: { content: json({ facts: facts.facts, summaries: facts.summaries }), scope: request.knowledgeScope ?? 'reader', sources: [...facts.sources] } } : {}) }
      proposal.candidateHash = hash(candidate(proposal))
      if (Buffer.byteLength(generationPrompt(proposal), 'utf8') > 256 * 1024) throw new BookError('context-too-large')
      await this.files.directory(join(this.folder(request.bookId), 'proposals'))
      await this.write(proposal, { exists: false, text: '' })
      return { proposal, created: true }
    })
  }

  async checkpoint(bookId: string, proposalId: string, replacement: string | undefined, state: 'generating' | 'review' | 'interrupted', reason: string, usage: GenerationUsage, elapsedMs: number): Promise<Proposal> {
    return await this.locked(bookId, async () => {
      const path = this.path(bookId, proposalId)
      const file = await this.files.read(path, 32 * 1024 * 1024)
      if (!file.exists) throw new BookError('proposal-not-found')
      const current = parseProposal(file.text, this.workspaceId, bookId, proposalId)
      if (current.state !== 'generating') return current
      const text = replacement ?? current.replacement
      contentSchema.parse(text)
      const next = { ...current, replacement: text, state, reason, usage, elapsedMs, updatedAt: Date.now() }
      contentSchema.parse(candidate(next))
      next.candidateHash = hash(candidate(next))
      await this.write(next, file)
      return next
    })
  }

  async view(bookId: string, proposalId: string, active: boolean): Promise<ProposalView> {
    const proposal = await this.read(bookId, proposalId)
    active = active || proposal.state === 'generating' && ownerRunning(proposal.owner)
    const receipt = (await this.books.receipt(bookId, proposal.acceptanceId))[0]
    const book = await this.books.readBook(bookId)
    if (receipt) {
      if (receipt.requestHash !== hash(json(adoption(proposal)))) throw new BookError('operation-conflict')
      return proposalView(proposal, 'accepted', '', book.recoveryRequired)
    }
    if (proposal.state === 'accepted') throw new BookError('invalid-format')
    if (proposal.state === 'rejected') return proposalView(proposal, 'rejected', proposal.reason, book.recoveryRequired)
    if (book.recoveryRequired) return proposalView(proposal, proposal.state === 'generating' && !active ? 'interrupted' : proposal.state, 'recovery-required', true)
    const chapter = await this.books.readChapter(bookId, proposal.request.chapterId)
    if (chapter.book.revision !== proposal.request.expectedRevision || chapter.hash !== proposal.request.expectedHash) return proposalView(proposal, active && proposal.state === 'generating' ? 'generating' : 'expired', 'revision-conflict', false)
    for (const item of proposal.context ?? []) {
      const current = await this.books.readChapter(bookId, item.chapterId)
      if (current.hash !== item.hash || current.externallyModified) return proposalView(proposal, 'expired', 'revision-conflict', false)
    }
    for (const item of proposal.factContext?.sources ?? []) {
      const source = await this.books.readChapter(bookId, item.chapterId), record = await this.books.readChapter(bookId, item.recordId)
      if (source.hash !== item.hash || source.book.chapters.find(chapter => chapter.chapterId === item.chapterId)?.revision !== item.revision || record.hash !== item.recordHash || source.externallyModified || record.externallyModified) return proposalView(proposal, 'expired', 'revision-conflict', false)
    }
    return proposalView(proposal, proposal.state === 'generating' && !active ? 'interrupted' : proposal.state,
      proposal.state === 'generating' && !active ? 'host-restarted' : proposal.reason, false)
  }

  async runningElsewhere(bookId: string, proposalId: string): Promise<boolean> {
    const proposal = await this.read(bookId, proposalId)
    return proposal.state === 'generating' && ownerRunning(proposal.owner)
  }

  async list(bookId: string, chapterId: string, isActive: (proposalId: string) => boolean): Promise<ProposalSummary[]> {
    idSchema.parse(chapterId)
    const path = await this.files.path(join(this.folder(bookId), 'proposals'))
    let names: string[]
    try { names = await readdir(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const results: ProposalSummary[] = []
    for (const name of names) {
      if (!name.endsWith('.json') || !idSchema.safeParse(name.slice(0, -5)).success) continue
      const id = name.slice(0, -5)
      if ((await this.read(bookId, id)).request.chapterId !== chapterId) continue
      const view = await this.view(bookId, id, isActive(id))
      const { proposalId, mode, state, reason, createdAt, updatedAt, generatedCharacters, recoveryRequired } = view
      results.push({ proposalId, bookId, chapterId, mode, state, reason, createdAt, updatedAt, generatedCharacters, recoveryRequired })
    }
    return results.sort((a, b) => b.createdAt - a.createdAt || b.proposalId.localeCompare(a.proposalId))
  }

  async decide(input: ProposalDecisionRequest, accept: boolean, signal: AbortSignal): Promise<ProposalView> {
    const request = decisionSchema.parse(input)
    return await this.locked(request.bookId, async () => {
      signal.throwIfAborted()
      const file = await this.files.read(this.path(request.bookId, request.proposalId), 32 * 1024 * 1024)
      if (!file.exists) throw new BookError('proposal-not-found')
      const proposal = parseProposal(file.text, this.workspaceId, request.bookId, request.proposalId)
      if (proposal.candidateHash !== request.expectedCandidateHash) throw new BookError('operation-conflict')
      const view = await this.view(request.bookId, request.proposalId, false)
      if (view.recoveryRequired) throw new BookError('recovery-required')
      if (view.state === 'accepted') {
        if (!accept) throw new BookError('proposal-finalized')
        return view
      }
      if (view.state === 'rejected') {
        if (accept) throw new BookError('proposal-finalized')
        return view
      }
      if (proposal.state === 'generating') throw new BookError('proposal-running')
      if (accept && (view.state !== 'review' || !proposal.replacement.trim())) throw new BookError(view.state === 'expired' ? 'proposal-stale' : 'proposal-incomplete')
      if (accept) await this.books.mutate(adoption(proposal), signal)
      const next = { ...proposal, state: accept ? 'accepted' as const : 'rejected' as const, updatedAt: Date.now() }
      await this.write(next, file)
      return await this.view(request.bookId, request.proposalId, false)
    })
  }
}
