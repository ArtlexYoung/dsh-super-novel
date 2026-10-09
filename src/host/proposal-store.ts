import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { BookError, contentSchema, hash, idSchema, json, availableDocument } from '../domain/books.js'
import { adoption, candidate, decisionSchema, generationPrompt, generationRequestSchema, parseProposal, proposalView, validateRange } from '../domain/proposals.js'
import type { Proposal } from '../domain/proposals.js'
import type { GenerateChapterRequest, GenerationUsage, ProposalDecisionRequest, ProposalSummary, ProposalView, GenerationContextPreview } from '../types.js'
import { BookFiles } from './book-files.js'
import { BookStore } from './book-store.js'
import { generationMachine, ownerRunning } from './proposal-runtime.js'
import type { GenerationOwner } from './proposal-runtime.js'
import { FactStore } from './fact-store.js'
import { ReviewStore } from './review-store.js'
import { VoiceStore } from './voice-store.js'
import { IntentStore } from './intent-store.js'

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
      const proposal = await this.prepareSnapshot(sessionId, request, signal, owner)
      if (Buffer.byteLength(generationPrompt(proposal), 'utf8') > 256 * 1024) throw new BookError('context-too-large')
      await this.files.directory(join(this.folder(request.bookId), 'proposals'))
      await this.write(proposal, { exists: false, text: '' })
      return { proposal, created: true }
    })
  }


  /** Shared pure snapshot builder: preview and generation cannot select different inputs. */
  async prepareSnapshot(sessionId: string, input: GenerateChapterRequest, signal: AbortSignal, owner: GenerationOwner = { machine: generationMachine, pid: process.pid, runtimeId: randomUUID() }): Promise<Proposal> {
    const request = generationRequestSchema.parse(input)
    signal.throwIfAborted()
    const chapter = await this.books.readChapter(request.bookId, request.chapterId)
    if (['facts', 'voice'].includes(chapter.book.chapters.find(item => item.chapterId === request.chapterId)?.kind ?? '')) throw new BookError('invalid-material')
    if (chapter.book.revision !== request.expectedRevision || chapter.hash !== request.expectedHash || chapter.externallyModified) throw new BookError('revision-conflict')
    let baseline = chapter.content, round = 0
    if (request.parentProposalId && !request.reviewId || request.reviewId && !request.issueId || request.issueId && !request.reviewId) throw new BookError('invalid-request')
    if (request.reviewId) {
      const reviewed = await (await ReviewStore.at(this.files.root, this.workspaceId, this.books)).revision(request.bookId, request.reviewId, request.issueId!)
      const { proposalId: _id, ...expected } = reviewed.request
      const { proposalId: _requested, ...actual } = request
      if (json(generationRequestSchema.parse({ ...expected, proposalId: request.proposalId })) !== json(request)) throw new BookError('invalid-request')
      round = reviewed.round
      if (request.parentProposalId) baseline = (await this.view(request.bookId, request.parentProposalId, false)).candidate
    }
    validateRange(request, baseline)
    const context = []
    const targetDocument = chapter.book.chapters.find(item => item.chapterId === request.chapterId)!
    if (!availableDocument(targetDocument)) throw new BookError('material-unavailable')
    const targetKind = targetDocument.kind ?? 'chapter'
    for (const id of request.materialIds ?? []) {
      const selected = await this.books.readChapter(request.bookId, id)
      const document = selected.book.chapters.find(item => item.chapterId === id)!
      if (!availableDocument(document)) throw new BookError('material-unavailable')
      const kind = document.kind ?? 'chapter'
      if (kind === 'facts' || kind === 'voice' || id === request.chapterId || kind === 'chapter' && targetKind === 'chapter') throw new BookError('invalid-material')
      if (selected.externallyModified || selected.book.revision !== request.expectedRevision) throw new BookError('revision-conflict')
      if (!selected.content.trim()) throw new BookError('material-empty')
      context.push({ chapterId: id, title: document.title, kind, revision: document.revision, hash: selected.hash, content: selected.content })
    }
    const targetAt = chapter.book.chapters.findIndex(item => item.chapterId === request.chapterId)
    for (const id of request.precedingChapterIds ?? []) {
      const selected = await this.books.readChapter(request.bookId, id), document = selected.book.chapters.find(item => item.chapterId === id)!
      if (targetKind !== 'chapter' || document.kind && document.kind !== 'chapter' || chapter.book.chapters.findIndex(item => item.chapterId === id) >= targetAt || !availableDocument(document)) throw new BookError('invalid-material')
      if (selected.externallyModified || selected.book.revision !== request.expectedRevision) throw new BookError('revision-conflict')
      if (!selected.content.trim()) throw new BookError('material-empty')
      context.push({ chapterId: id, title: document.title, kind: 'chapter' as const, revision: document.revision, hash: selected.hash, content: selected.content })
    }
    const intent = request.intentVersion !== undefined ? await (await IntentStore.at(this.files.root, this.workspaceId, this.books)).read(request.bookId, request.chapterId) : false
    if (intent && (targetKind !== 'chapter' || intent.version !== request.intentVersion)) throw new BookError('revision-conflict')
    const now = Date.now()
    const voices = request.voiceIds ? await new VoiceStore(this.books).selected(request.bookId, request.voiceIds) : undefined
    const facts = request.useFacts ? await (await FactStore.at(this.files.root, this.workspaceId, this.books)).context(request.bookId, request.chapterId, request.knowledgeScope ?? 'reader', 128 * 1024) : undefined
    if (facts && facts.state !== 'complete') throw new BookError(facts.state === 'over-budget' ? 'context-too-large' : 'facts-incomplete')
    if ((await this.books.readBook(request.bookId)).revision !== request.expectedRevision) throw new BookError('revision-conflict')
    const proposal: Proposal = { schemaVersion: 1, workspaceId: this.workspaceId, sessionId, owner, request,
      requestHash: hash(json(request)), acceptanceId: randomUUID(), baseline,
      baselineChapterRevision: chapter.book.chapters.find(item => item.chapterId === request.chapterId)!.revision,
      createdAt: now, updatedAt: now, state: 'generating', reason: '', replacement: '',
      candidateHash: '', elapsedMs: 0, usage: { state: 'unknown' },
      ...(chapter.book.chapters.find(item => item.chapterId === request.chapterId)!.kind ? { documentKind: chapter.book.chapters.find(item => item.chapterId === request.chapterId)!.kind } : {}),
      ...(request.materialIds || request.precedingChapterIds ? { context } : {}),
      ...(intent ? { intentContext: { version: intent.version, hash: intent.hash, intent: intent.intent } } : {}),
      ...(voices ? { voiceContext: voices.map(voice => ({ ...voice, schemaVersion: 1 as const, state: 'active' as const })) } : {}),
      ...(facts ? { factContext: { content: json({ facts: facts.facts, summaries: facts.summaries }), scope: request.knowledgeScope ?? 'reader', sources: [...facts.sources] } } : {}),
      ...(round ? { revisionRound: round } : {}), ...(request.parentProposalId ? { parentCandidateHash: hash(baseline) } : {}) }
    proposal.candidateHash = hash(candidate(proposal))
    return proposal
  }

  async preview(input: GenerateChapterRequest, signal: AbortSignal): Promise<GenerationContextPreview> {
    const proposal = await this.prepareSnapshot('context-preview', input, signal)
    const bytes = Buffer.byteLength(generationPrompt(proposal)), maxBytes = 256 * 1024
    const sections: GenerationContextPreview['sections'][number][] = []
    const add = (kind: string, sourceId: string, title: string, reason: string, content: string): void => { sections.push({ kind, sourceId, title, reason, content, bytes: Buffer.byteLength(content) }) }
    if (proposal.request.hardConstraints) add('constraints', '', 'Author constraints', 'author', proposal.request.hardConstraints)
    if (proposal.intentContext) {
      if (proposal.intentContext.intent.hardConstraints) add('constraints', proposal.request.chapterId, 'Scene constraints', 'intent', proposal.intentContext.intent.hardConstraints)
      add('intent', proposal.request.chapterId, 'Scene intent', 'intent', json(proposal.intentContext.intent))
    }
    add('instruction', '', 'Writing task', 'author', proposal.request.instruction)
    if (proposal.request.materials) add('materials', '', 'Author references', 'author', proposal.request.materials)
    for (const item of proposal.context ?? []) add(item.kind, item.chapterId, item.title, item.kind === 'chapter' ? 'preceding' : 'selected', item.content)
    if (proposal.factContext) add('facts', '', 'Facts', `knowledge:${proposal.factContext.scope}`, proposal.factContext.content)
    for (const voice of proposal.voiceContext ?? []) add('voice', voice.voiceId, voice.sourceDescription, 'authorized', voice.sample)
    add('chapter', proposal.request.chapterId, 'Saved chapter', 'baseline', proposal.baseline)
    return { bytes, maxBytes, state: bytes > maxBytes ? 'over-budget' : 'ready', sections }
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
    if (proposal.intentContext) {
      const intent = await (await IntentStore.at(this.files.root, this.workspaceId, this.books)).read(bookId, proposal.request.chapterId)
      if (intent.version !== proposal.intentContext.version || intent.hash !== proposal.intentContext.hash) return proposalView(proposal, 'expired', 'intent-changed', false)
    }
    for (const item of proposal.context ?? []) {
      const current = await this.books.readChapter(bookId, item.chapterId)
      if (current.hash !== item.hash || current.externallyModified) return proposalView(proposal, 'expired', 'revision-conflict', false)
    }
    for (const item of proposal.factContext?.sources ?? []) {
      const source = await this.books.readChapter(bookId, item.chapterId), record = await this.books.readChapter(bookId, item.recordId)
      if (source.hash !== item.hash || source.book.chapters.find(chapter => chapter.chapterId === item.chapterId)?.revision !== item.revision || record.hash !== item.recordHash || source.externallyModified || record.externallyModified) return proposalView(proposal, 'expired', 'revision-conflict', false)
    }
    for (const item of proposal.voiceContext ?? []) {
      const current = await new VoiceStore(this.books).read(bookId, item.voiceId)
      if (current.state !== 'active' || current.hash !== item.hash) return proposalView(proposal, 'expired', 'voice-unavailable', false)
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
