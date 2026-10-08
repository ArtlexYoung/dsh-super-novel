import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { BookError, hash, idSchema, json } from '../domain/books.js'
import { factAdoption, factsRequestSchema, parseFactDocument, parseFactProposal, validateFacts } from '../domain/facts.js'
import type { StoredFactProposal } from '../domain/facts.js'
import type { FactContext, FactProposal, GenerationUsage, GenerateFactsRequest, ProposeFactsRequest } from '../types.js'
import { BookFiles } from './book-files.js'
import { BookStore } from './book-store.js'

export class FactStore {
  private constructor(private readonly files: BookFiles, private readonly books: BookStore, private readonly workspaceId: string) {}
  static async at(root: string, workspaceId: string, books: BookStore): Promise<FactStore> { return new FactStore(await BookFiles.at(root), books, workspaceId) }
  private folder(bookId: string): string { return join('novels', idSchema.parse(bookId), 'fact-proposals') }
  private path(bookId: string, id: string): string { return join(this.folder(bookId), `${idSchema.parse(id)}.json`) }
  private async read(bookId: string, id: string): Promise<StoredFactProposal> {
    const file = await this.files.read(this.path(bookId, id), 32 * 1024 * 1024)
    if (!file.exists) throw new BookError('fact-proposal-not-found')
    return parseFactProposal(file.text, this.workspaceId, bookId, id)
  }
  async existing(request: GenerateFactsRequest): Promise<FactProposal[]> {
    const file = await this.files.read(this.path(request.bookId, request.proposalId), 32 * 1024 * 1024)
    if (!file.exists) return []
    const proposal = parseFactProposal(file.text, this.workspaceId, request.bookId, request.proposalId)
    if (proposal.request.sourceChapterId !== request.sourceChapterId || proposal.request.expectedHash !== request.expectedHash || proposal.request.expectedRevision !== request.expectedRevision) throw new BookError('operation-conflict')
    return [await this.view(proposal)]
  }
  async propose(input: ProposeFactsRequest, signal: AbortSignal, usage: GenerationUsage = { state: 'unknown' }, elapsedMs = 0): Promise<FactProposal> {
    const request = factsRequestSchema.parse(input)
    return await this.files.lock(join('novels', request.bookId, '.fact.lock'), async () => {
      signal.throwIfAborted()
      const file = await this.files.read(this.path(request.bookId, request.proposalId), 32 * 1024 * 1024)
      if (file.exists) {
        const previous = parseFactProposal(file.text, this.workspaceId, request.bookId, request.proposalId)
        if (previous.requestHash !== hash(json(request))) throw new BookError('operation-conflict')
        return await this.view(previous)
      }
      const source = await this.books.readChapter(request.bookId, request.sourceChapterId)
      const chapter = source.book.chapters.find(item => item.chapterId === request.sourceChapterId)!
      if (chapter.kind && chapter.kind !== 'chapter') throw new BookError('invalid-material')
      if (source.book.revision !== request.expectedRevision || source.hash !== request.expectedHash || source.externallyModified) throw new BookError('revision-conflict')
      const document = { schemaVersion: 1 as const, sourceChapterId: chapter.chapterId, sourceRevision: chapter.revision, sourceHash: source.hash,
        facts: request.facts.map(item => ({ ...item, factId: randomUUID(), sourceRevision: chapter.revision, sourceHash: source.hash })), ...(request.summary ? { summary: request.summary } : {}), coverage: request.coverage ?? 'selection' }
      validateFacts(document, source.content)
      for (const fact of document.facts) {
        const scope = fact.scope
        if (scope.kind === 'character' && !source.book.chapters.some(item => item.chapterId === scope.characterId && item.kind === 'character')) throw new BookError('invalid-evidence')
      }
      const previous = source.book.chapters.find(item => item.kind === 'facts' && item.linkedChapterId === chapter.chapterId)
      const proposal: StoredFactProposal = { schemaVersion: 1, workspaceId: this.workspaceId, requestHash: hash(json(request)), request,
        documentId: previous?.chapterId ?? randomUUID(), acceptanceId: randomUUID(), expectedDocumentHash: previous?.hash ?? '',
        document, state: 'review', createdAt: Date.now(), usage, elapsedMs }
      const text = json(proposal)
      if (Buffer.byteLength(text, 'utf8') > 32 * 1024 * 1024) throw new BookError('too-large')
      parseFactProposal(text, this.workspaceId, request.bookId, request.proposalId)
      await this.files.directory(this.folder(request.bookId))
      await this.files.replace(this.path(request.bookId, request.proposalId), text, file)
      return await this.view(proposal)
    })
  }
  private async view(proposal: StoredFactProposal): Promise<FactProposal> {
    const source = await this.books.readChapter(proposal.request.bookId, proposal.request.sourceChapterId)
    const chapter = source.book.chapters.find(item => item.chapterId === proposal.request.sourceChapterId)!
    const receipt = (await this.books.receipt(proposal.request.bookId, proposal.acceptanceId))[0]
    if (receipt && receipt.requestHash !== hash(json(factAdoption(proposal)))) throw new BookError('operation-conflict')
    const expired = source.hash !== proposal.document.sourceHash || chapter.revision !== proposal.document.sourceRevision || source.externallyModified || (!receipt && source.book.revision !== proposal.request.expectedRevision)
    return { proposalId: proposal.request.proposalId, bookId: proposal.request.bookId, sourceChapterId: proposal.request.sourceChapterId,
      sourceRevision: proposal.document.sourceRevision, sourceHash: proposal.document.sourceHash, state: expired ? 'expired' : receipt ? 'accepted' : proposal.state,
      reason: expired ? 'revision-conflict' : '', facts: proposal.document.facts, factsHash: hash(json(proposal.document)), createdAt: proposal.createdAt,
      ...(proposal.document.summary ? { summary: proposal.document.summary } : {}), usage: proposal.usage as GenerationUsage, elapsedMs: proposal.elapsedMs, coverage: proposal.document.coverage }
  }
  async list(bookId: string, sourceChapterId: string): Promise<FactProposal[]> {
    idSchema.parse(sourceChapterId)
    const folder = await this.files.path(this.folder(bookId)); let names: string[]
    try { names = await readdir(folder) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const result: FactProposal[] = []
    for (const name of names) if (name.endsWith('.json') && idSchema.safeParse(name.slice(0, -5)).success) {
      const proposal = await this.read(bookId, name.slice(0, -5))
      if (proposal.request.sourceChapterId === sourceChapterId) result.push(await this.view(proposal))
    }
    return result.sort((a, b) => b.createdAt - a.createdAt)
  }
  async decide(bookId: string, proposalId: string, expectedHash: string, accept: boolean, signal: AbortSignal): Promise<FactProposal> {
    return await this.files.lock(join('novels', idSchema.parse(bookId), '.fact.lock'), async () => {
      signal.throwIfAborted()
      const proposal = await this.read(bookId, proposalId)
      if (hash(json(proposal.document)) !== expectedHash) throw new BookError('operation-conflict')
      const view = await this.view(proposal)
      const receipt = (await this.books.receipt(bookId, proposal.acceptanceId))[0]
      if (receipt) { if (!accept) throw new BookError('fact-finalized'); return view }
      if (proposal.state === 'rejected') { if (accept) throw new BookError('fact-finalized'); return view }
      if (accept) {
        if (view.state === 'expired') throw new BookError('fact-stale')
        await this.books.mutate(factAdoption(proposal), signal)
      } else {
        const path = this.path(bookId, proposalId); const file = await this.files.read(path, 32 * 1024 * 1024)
        await this.files.replace(path, json({ ...proposal, state: 'rejected' }), file)
      }
      return await this.view(await this.read(bookId, proposalId))
    })
  }
  async context(bookId: string, targetChapterId: string, scope: string, maxBytes: number): Promise<FactContext> {
    z.int().positive().max(256 * 1024).parse(maxBytes)
    const book = await this.books.readBook(bookId)
    if (book.recoveryRequired) throw new BookError('recovery-required')
    const at = book.chapters.findIndex(item => item.chapterId === idSchema.parse(targetChapterId))
    if (at < 0) throw new BookError('chapter-not-found')
    if (scope !== 'reader' && !book.chapters.some(item => item.chapterId === idSchema.parse(scope) && item.kind === 'character')) throw new BookError('invalid-material')
    const facts: FactContext['facts'][number][] = [], sources: FactContext['sources'][number][] = [], missingChapterIds: string[] = [], summaries: FactContext['summaries'][number][] = []
    let expired = false
    for (const chapter of book.chapters.slice(0, at).filter(item => !item.kind || item.kind === 'chapter')) {
      const source = await this.books.readChapter(bookId, chapter.chapterId)
      if (!source.content.trim()) continue
      const metadata = book.chapters.find(item => item.kind === 'facts' && item.linkedChapterId === chapter.chapterId)
      if (!metadata) { missingChapterIds.push(chapter.chapterId); continue }
      const record = await this.books.readChapter(bookId, metadata.chapterId)
      const document = parseFactDocument(record.content)
      if (document.sourceChapterId !== chapter.chapterId || document.sourceHash !== source.hash || document.sourceRevision !== chapter.revision || source.externallyModified || record.externallyModified) { expired = true; missingChapterIds.push(chapter.chapterId); continue }
      validateFacts(document, source.content)
      if (document.coverage !== 'chapter') missingChapterIds.push(chapter.chapterId)
      sources.push({ chapterId: chapter.chapterId, revision: chapter.revision, hash: source.hash, recordId: metadata.chapterId, recordHash: record.hash })
      for (const fact of document.facts) if (scope === 'reader' ? fact.scope.kind === 'reader' : fact.scope.kind === 'character' && fact.scope.characterId === scope) facts.push(fact)
      if (scope === 'reader' && document.summary) summaries.push({ chapterId: chapter.chapterId, text: document.summary.text })
    }
    const bytes = Buffer.byteLength(json({ facts, summaries }), 'utf8')
    if ((await this.books.readBook(bookId)).revision !== book.revision) throw new BookError('revision-conflict')
    return { facts, summaries, sources, missingChapterIds, bytes, state: expired ? 'expired' : missingChapterIds.length ? 'degraded' : bytes > maxBytes ? 'over-budget' : 'complete' }
  }
}
