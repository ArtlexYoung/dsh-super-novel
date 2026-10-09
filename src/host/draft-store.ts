import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { BookError, contentSchema, hash, idSchema, json } from '../domain/books.js'
import type { DiskDraft, DraftListing, DraftQuery, DraftRequest, DraftSummary, DraftVersionQuery, SettleDraftRequest } from '../types.js'
import { BookFiles } from './book-files.js'
import type { BookStore } from './book-store.js'
import { syncDirectory } from './file-publication.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const querySchema = z.strictObject({ workspaceId: digest, bookId: idSchema, chapterId: idSchema })
const versionSchema = querySchema.extend({ branchId: idSchema, sequence: z.int().positive() })
const requestSchema = versionSchema.extend({ baseHash: digest, bookRevision: z.int().positive(), content: contentSchema, operationId: idSchema })
const recordSchema = requestSchema.extend({ schemaVersion: z.literal(1), contentHash: digest, savedAt: z.int().nonnegative() })
const settledSchema = versionSchema.extend({ contentHash: digest, action: z.enum(['saved', 'dismissed']) })
const LIMIT = 28 * 1024 * 1024
export interface DraftHooks { afterPublication?(): Promise<void> }
function versionOf(query: DraftVersionQuery): DraftVersionQuery { return { workspaceId: query.workspaceId, bookId: query.bookId, chapterId: query.chapterId, branchId: query.branchId, sequence: query.sequence } }

/** Immutable, fsynced checkpoints. Different editor branches never overwrite each other. */
export class DraftStore {
  private constructor(private readonly files: BookFiles, private readonly workspaceId: string, private readonly books: BookStore, private readonly hooks: DraftHooks) {}
  static async at(root: string, workspaceId: string, books: BookStore, hooks: DraftHooks = {}): Promise<DraftStore> { return new DraftStore(await BookFiles.at(root), workspaceId, books, hooks) }
  private folder(query: DraftQuery): string { return join('novels', query.bookId, 'drafts', query.chapterId) }
  private branch(query: DraftVersionQuery): string { return join(this.folder(query), query.branchId) }
  private checkpoint(query: DraftVersionQuery): string { return join(this.branch(query), `${String(query.sequence).padStart(16, '0')}.json`) }

  private async check(query: DraftQuery): Promise<void> {
    if (query.workspaceId !== this.workspaceId) throw new BookError('location-changed')
    const book = await this.books.readBook(query.bookId)
    if (!book.chapters.some(item => item.chapterId === query.chapterId)) throw new BookError('chapter-not-found')
  }

  private async names(folder: string): Promise<string[]> {
    try { return await readdir(await this.files.path(folder)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }

  private async versions(query: DraftVersionQuery): Promise<number[]> {
    return (await this.names(this.branch(query))).filter(name => /^[0-9]{16}\.json$/.test(name)).map(name => Number(name.slice(0, -5))).filter(Number.isSafeInteger).sort((a, b) => b - a)
  }

  async read(input: DraftVersionQuery): Promise<DiskDraft> {
    const query = versionSchema.parse(input)
    await this.check(query)
    const file = await this.files.read(this.checkpoint(query), LIMIT)
    if (!file.exists) throw new BookError('draft-not-found')
    let record
    try { record = recordSchema.parse(JSON.parse(file.text)) } catch { throw new BookError('invalid-format') }
    if (record.workspaceId !== query.workspaceId || record.bookId !== query.bookId || record.chapterId !== query.chapterId || record.branchId !== query.branchId || record.sequence !== query.sequence || hash(record.content) !== record.contentHash) throw new BookError('invalid-format')
    const { schemaVersion: _, ...draft } = record
    return draft
  }

  async list(input: DraftQuery): Promise<DraftListing> {
    const query = querySchema.parse(input)
    await this.check(query)
    const output: DraftSummary[] = []
    let unreadable = 0
    for (const name of await this.names(this.folder(query))) {
      if (!idSchema.safeParse(name).success) continue
      const branch = { ...query, branchId: name, sequence: 1 }
      let through = 0
      try {
        const settled = await this.files.read(join(this.branch(branch), 'settled.json'))
        if (settled.exists) {
          const value = settledSchema.parse(JSON.parse(settled.text))
          if (value.workspaceId !== query.workspaceId || value.bookId !== query.bookId || value.chapterId !== query.chapterId || value.branchId !== name) throw new BookError('invalid-format')
          if ((await this.read(versionOf(value))).contentHash !== value.contentHash) throw new BookError('invalid-format')
          through = value.sequence
        }
      } catch { unreadable++ }
      // Last two unhandled checkpoints remain directly recoverable. Older files are retained.
      let versions: number[]
      try { versions = await this.versions(branch) } catch { unreadable++; continue }
      let found = 0
      for (const sequence of versions.filter(seq => seq > through).slice(0, 100)) {
        try {
          const { content: _, ...summary } = await this.read({ ...branch, sequence })
          output.push(summary)
          if (++found === 2) break
        } catch { unreadable++ }
      }
    }
    return { drafts: output.sort((a, b) => b.savedAt - a.savedAt || b.sequence - a.sequence), unreadable }
  }

  async put(input: DraftRequest, signal: AbortSignal): Promise<DraftSummary> {
    const request = requestSchema.parse(input)
    await this.check(request)
    signal.throwIfAborted()
    await this.files.directory(this.branch(request))
    return await this.files.lock(join(this.branch(request), '.write.lock'), async () => {
      const latest = (await this.versions(request))[0] ?? 0
      if (request.sequence < latest) throw new BookError('draft-sequence-conflict')
      const file = await this.files.read(this.checkpoint(request), LIMIT)
      if (file.exists) {
        const draft = await this.read(versionOf(request))
        const { savedAt: _, contentHash: __, ...original } = draft
        if (json(original) !== json(request)) throw new BookError('operation-conflict')
        await syncDirectory(dirname(await this.files.path(this.checkpoint(request))))
        const { content: ___, ...summary } = draft
        return summary
      }
      const draft = { ...request, contentHash: hash(request.content), savedAt: Date.now() }
      signal.throwIfAborted()
      await this.files.replace(this.checkpoint(request), json({ ...draft, schemaVersion: 1 }), file)
      await this.hooks.afterPublication?.()
      const { content: _, ...summary } = draft
      return summary
    })
  }

  async settle(input: SettleDraftRequest, signal: AbortSignal): Promise<DraftSummary> {
    const request = settledSchema.parse(input)
    await this.check(request)
    return await this.files.lock(join(this.branch(request), '.write.lock'), async () => {
      const draft = await this.read(versionOf(request))
      if (draft.contentHash !== request.contentHash) throw new BookError('operation-conflict')
      if (request.action === 'saved' && (await this.books.readChapter(request.bookId, request.chapterId)).hash !== request.contentHash) throw new BookError('revision-conflict')
      const path = join(this.branch(request), 'settled.json')
      const before = await this.files.read(path)
      if (before.exists) {
        const previous = settledSchema.parse(JSON.parse(before.text))
        if (previous.sequence > request.sequence) { const { content: _, ...summary } = draft; return summary }
      }
      signal.throwIfAborted()
      await this.files.replace(path, json(request), before)
      const { content: _, ...summary } = draft
      return summary
    })
  }
}
