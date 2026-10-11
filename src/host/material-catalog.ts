import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { BookError, availableDocument, chapterLinks, hash, idSchema, materialKind } from '../domain/books.js'
import { parseFactDocument } from '../domain/facts.js'
import type { MaterialReferences, MaterialSearchRequest, MaterialSearchResult, MaterialBatchRequest, MaterialBatchPreview } from '../types.js'
import { prepareMaterialBatch } from '../domain/material-batch.js'
import { BookStore } from './book-store.js'
import { BookFiles } from './book-files.js'
const cache = new Map<string, string>()
const querySchema = z.strictObject({ bookId: idSchema, query: z.string().max(500), kind: z.string().max(30), tag: z.string().max(80),
  status: z.enum(['available', 'active', 'inbox', 'archived', 'trashed', 'all']), linkedChapterId: z.string().max(36), favorite: z.boolean(), offset: z.int().nonnegative().max(10_000), attention: z.enum(['all', 'untagged', 'unlinked', 'stale']).optional() })

/** Search is a bounded derived view; it never writes indexes or invokes a model. */
export class MaterialCatalog {
  private constructor(private readonly files: BookFiles, private readonly books: BookStore) {}
  static async at(root: string, books: BookStore): Promise<MaterialCatalog> { return new MaterialCatalog(await BookFiles.at(root), books) }

  private async draftBranches(bookId: string, chapterId: string): Promise<number> {
    const branches = new Set<string>()
    for (const folder of [`drafts/${chapterId}`, `form-drafts/material/${chapterId}`]) {
      try { for (const name of await readdir(await this.files.path(`novels/${bookId}/${folder}`))) if (idSchema.safeParse(name).success) branches.add(name) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return branches.size
  }

  async search(input: MaterialSearchRequest, signal: AbortSignal): Promise<MaterialSearchResult> {
    const request = querySchema.parse(input), book = await this.books.readBook(request.bookId)
    if (book.recoveryRequired) throw new BookError('recovery-required')
    const terms = request.query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean), items = [], externalIds = []
    let bytes = 0, complete = true
    const sources = new Map<string, string>()
    for (const item of book.chapters) {
      signal.throwIfAborted()
      if (!materialKind(item.kind) || request.kind !== 'all' && item.kind !== request.kind || request.favorite && !item.favorite ||
        request.tag && !item.tags?.includes(request.tag) || request.linkedChapterId && !chapterLinks(item).includes(request.linkedChapterId) ||
        request.status === 'available' && !availableDocument(item) || !['all', 'available'].includes(request.status) && (item.status ?? 'active') !== request.status) continue
      if (request.attention === 'untagged' && item.tags?.length || request.attention === 'unlinked' && chapterLinks(item).length) continue
      if (request.attention === 'stale') {
        const evidence = item.sourceEvidence
        if (!evidence) continue
        const source = book.chapters.find(source => source.chapterId === evidence.chapterId)
        let digest = sources.get(evidence.chapterId)
        if (digest === undefined) {
          try {
            const file = await this.files.read(`novels/${book.bookId}/chapters/${evidence.chapterId}.md`)
            bytes += Buffer.byteLength(file.text)
            if (bytes > 128 * 1024 * 1024) { complete = false; break }
            digest = file.exists ? hash(file.text) : ''; sources.set(evidence.chapterId, digest)
          } catch (error) { if (error instanceof BookError && ['too-large', 'invalid-text'].includes(error.code)) { complete = false; continue }; throw error }
        }
        if (source && availableDocument(source) && source.revision === evidence.revision && digest === evidence.hash) continue
      }
      let text = [item.title, ...(item.aliases ?? []), ...(item.tags ?? [])].join('\n').toLocaleLowerCase()
      if (terms.length) {
        const file = await this.files.read(`novels/${book.bookId}/chapters/${item.chapterId}.md`)
        if (!file.exists) { complete = false; continue }
        const digest = hash(file.text)
        if (digest !== item.hash) externalIds.push(item.chapterId)
        bytes += Buffer.byteLength(file.text)
        if (bytes > 128 * 1024 * 1024) { complete = false; break }
        const key = `${this.files.root}:${item.chapterId}:${digest}`
        const content = cache.get(key) ?? file.text.toLocaleLowerCase()
        if (Buffer.byteLength(content) <= 128 * 1024 && cache.size < 500) cache.set(key, content)
        text += '\n' + content
      }
      if (terms.every(term => text.includes(term))) items.push(item)
    }
    if ((await this.books.readBook(book.bookId)).revision !== book.revision) throw new BookError('revision-conflict')
    items.sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.title.localeCompare(b.title) || a.chapterId.localeCompare(b.chapterId))
    return { items: items.slice(request.offset, request.offset + 100), total: items.length, complete, externalIds, revision: book.revision }
  }

  async previewBatch(request: MaterialBatchRequest, signal: AbortSignal): Promise<MaterialBatchPreview> {
    signal.throwIfAborted()
    const book = await this.books.readBook(request.bookId), prepared = prepareMaterialBatch(book, request)
    const selected = new Set(request.chapterIds), uses = new Map<string, number>(), drafts = new Map<string, number>()
    const folder = `novels/${book.bookId}/proposals`
    let names: string[]
    try { names = await readdir(await this.files.path(folder)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = []; else throw error }
    const candidates = names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))
    let bytes = 0, complete = candidates.length <= 1000
    for (const name of candidates.slice(0, 1000)) {
      signal.throwIfAborted()
      try {
        const file = await this.files.read(`${folder}/${name}`, 32 * 1024 * 1024)
        bytes += Buffer.byteLength(file.text)
        if (bytes > 128 * 1024 * 1024) { complete = false; break }
        const proposal = JSON.parse(file.text)
        if (!proposal || !Array.isArray(proposal.context) || !proposal.context.every((source: unknown) => source && typeof source === 'object' && idSchema.safeParse((source as { chapterId?: unknown }).chapterId).success)) { complete = false; continue }
        for (const id of new Set<string>(proposal.context.map((source: { chapterId: string }) => source.chapterId))) if (selected.has(id)) uses.set(id, (uses.get(id) ?? 0) + 1)
      } catch (error) { if (error instanceof SyntaxError || error instanceof BookError && ['too-large', 'invalid-text'].includes(error.code)) { complete = false; continue }; throw error }
    }
    for (const id of selected) {
      signal.throwIfAborted()
      drafts.set(id, await this.draftBranches(book.bookId, id))
    }
    signal.throwIfAborted()
    if ((await this.books.readBook(book.bookId)).revision !== book.revision) throw new BookError('revision-conflict')
    return { revision: book.revision, complete, items: prepared.items.map(item => ({ ...item, uses: uses.get(item.before.chapterId) ?? 0,
      backlinks: book.chapters.filter(source => source.relatedMaterialIds?.includes(item.before.chapterId)).length, draftBranches: drafts.get(item.before.chapterId) ?? 0 })) }
  }

  async references(bookId: string, chapterId: string, signal: AbortSignal): Promise<MaterialReferences> {
    const book = await this.books.readBook(bookId), item = book.chapters.find(item => item.chapterId === chapterId)
    if (!item || !materialKind(item.kind)) throw new BookError('invalid-material')
    const uses = [], evidenceChapterIds = new Set<string>()
    let complete = true, bytes = 0, draftBranches = 0
    const folder = `novels/${bookId}/proposals`
    let names: string[]
    try { names = await readdir(await this.files.path(folder)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = []; else throw error }
    for (const name of names) {
      signal.throwIfAborted()
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
      const file = await this.files.read(`${folder}/${name}`, 32 * 1024 * 1024)
      bytes += Buffer.byteLength(file.text)
      if (bytes > 128 * 1024 * 1024 || uses.length >= 1000) { complete = false; break }
      const proposal = JSON.parse(file.text), selected = proposal.context?.find((source: { chapterId: string }) => source.chapterId === chapterId)
      if (selected) uses.push({ proposalId: proposal.request.proposalId as string, chapterId: proposal.request.chapterId as string, revision: selected.revision as number, hash: selected.hash as string,
        stale: selected.hash !== item.hash || selected.revision !== item.revision || !availableDocument(item), state: proposal.state as string })
    }
    for (const record of book.chapters.filter(item => item.kind === 'facts')) {
      signal.throwIfAborted()
      const file = await this.files.read(`novels/${bookId}/chapters/${record.chapterId}.md`)
      try { for (const fact of parseFactDocument(file.text).facts) if (fact.scope.kind === 'character' && fact.scope.characterId === chapterId) evidenceChapterIds.add(fact.sourceChapterId) }
      catch { complete = false }
    }
    draftBranches = await this.draftBranches(bookId, chapterId)
    return { linkedChapterIds: chapterLinks(item), outgoing: item.relatedMaterialIds ?? [], incoming: book.chapters.filter(source => source.relatedMaterialIds?.includes(chapterId)).map(source => source.chapterId), uses,
      evidenceChapterIds: [...evidenceChapterIds], draftBranches, complete }
  }
}
