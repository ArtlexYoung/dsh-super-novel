import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { BookError, availableDocument, hash, idSchema } from '../domain/books.js'
import type { CandidateInbox, CandidateInboxItem, CandidateInboxQuery } from '../types.js'
import { BookFiles } from './book-files.js'
import { BookStore } from './book-store.js'
import { ProposalStore } from './proposal-store.js'
import { FactStore } from './fact-store.js'
import { IntentStore } from './intent-store.js'
import { StoryStore } from './story-store.js'

const querySchema = z.strictObject({ workspaceId: z.string().regex(/^[a-f\d]{64}$/), bookId: idSchema,
  kind: z.enum(['all', 'writing', 'facts', 'intent', 'story', 'source']), cursor: z.string().max(80).regex(/^(?:(?:writing|facts|intent|story|source):[a-f\d-]{36})?$/i) })
const folders = { writing: 'proposals', facts: 'fact-proposals', intent: 'intent-proposals', story: 'story-proposals' } as const
type Kind = keyof typeof folders | 'source'
type Entry = { key: string; kind: Kind; id: string; path: string }
export const INBOX_LIMITS = { page: 25, scans: 500, bytes: 32 * 1024 * 1024, names: 10_000 } as const

/** A bounded view of canonical records. Querying never creates or adopts candidates. */
export class CandidateInboxStore {
  private constructor(private readonly files: BookFiles, private readonly workspaceId: string, private readonly books: BookStore) {}
  static async at(root: string, workspaceId: string, books: BookStore): Promise<CandidateInboxStore> { return new CandidateInboxStore(await BookFiles.at(root), workspaceId, books) }
  private async entries(request: CandidateInboxQuery): Promise<{ entries: Entry[]; complete: boolean }> {
    const entries: Entry[] = []; let complete = true
    for (const [kind, folder] of Object.entries(folders)) {
      if (request.kind !== 'all' && request.kind !== kind) continue
      const path = join('novels', request.bookId, folder)
      let names: string[]
      try { names = await readdir(await this.files.path(path)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      if (names.length > INBOX_LIMITS.names) complete = false
      for (const name of names.filter(name => name.endsWith('.json') && idSchema.safeParse(name.slice(0, -5)).success).sort().slice(0, INBOX_LIMITS.names)) {
        const id = name.slice(0, -5); entries.push({ kind: kind as Kind, key: `${kind}:${id}`, id, path: join(path, name) })
      }
    }
    if (request.kind === 'all' || request.kind === 'source') {
      const book = await this.books.readBook(request.bookId)
      for (const item of book.chapters) if (item.sourceEvidence && availableDocument(item)) entries.push({ key: `source:${item.chapterId}`, kind: 'source', id: item.chapterId, path: '' })
    }
    return { entries: entries.sort((a, b) => a.key.localeCompare(b.key)), complete }
  }
  async query(input: CandidateInboxQuery, signal: AbortSignal): Promise<CandidateInbox> {
    const request = querySchema.parse(input)
    if (request.workspaceId !== this.workspaceId) throw new BookError('location-changed')
    signal.throwIfAborted()
    const book = await this.books.readBook(request.bookId), listing = await this.entries(request)
    const entries = listing.entries.filter(entry => entry.key.localeCompare(request.cursor) > 0)
    const items: CandidateInboxItem[] = []; let scanned = 0, bytes = 0, unreadable = 0, cursor = request.cursor, complete = listing.complete
    const proposals = await ProposalStore.at(this.files.root, this.workspaceId, this.books), facts = await FactStore.at(this.files.root, this.workspaceId, this.books)
    const intents = await IntentStore.at(this.files.root, this.workspaceId, this.books), stories = await StoryStore.at(this.files.root, this.workspaceId, this.books)
    for (const entry of entries) {
      signal.throwIfAborted()
      if (items.length >= INBOX_LIMITS.page) break
      if (scanned >= INBOX_LIMITS.scans || bytes >= INBOX_LIMITS.bytes) { complete = false; break }
      scanned++; cursor = entry.key
      try {
        let chapterId: string, state: string, reason = '', sourceHash: string, preview = '', createdAt = 0
        if (entry.kind === 'source') {
          const item = book.chapters.find(item => item.chapterId === entry.id)!, evidence = item.sourceEvidence!
          const source = book.chapters.find(item => item.chapterId === evidence.chapterId)
          const file = source && availableDocument(source) ? await this.files.read(join('novels', request.bookId, 'chapters', `${source.chapterId}.md`), Math.min(4 * 1024 * 1024, INBOX_LIMITS.bytes - bytes)) : { exists: false, text: '' }
          bytes += Buffer.byteLength(file.text)
          if (source && file.exists && source.revision === evidence.revision && hash(file.text) === evidence.hash && file.text.slice(evidence.start, evidence.end) === evidence.quote) continue
          chapterId = entry.id; state = 'expired'; reason = 'revision-conflict'; sourceHash = evidence.hash; preview = evidence.quote
        } else {
          const file = await this.files.read(entry.path, Math.min(16 * 1024 * 1024, INBOX_LIMITS.bytes - bytes))
          bytes += Buffer.byteLength(file.text)
          if (!file.exists) continue
          const raw = JSON.parse(file.text), id = raw.request?.chapterId ?? raw.request?.sourceChapterId
          if (!idSchema.safeParse(id).success || !book.chapters.some(item => item.chapterId === id)) throw new BookError('invalid-format')
          chapterId = id
          if (entry.kind === 'writing') {
            const value = await proposals.view(request.bookId, entry.id, false)
            if (['accepted', 'rejected'].includes(value.state)) continue
            state = value.state; reason = value.reason; sourceHash = raw.request.expectedHash; createdAt = value.createdAt; preview = raw.request.instruction
          } else if (entry.kind === 'facts') {
            const value = await facts.proposal(request.bookId, entry.id)
            if (value.finalized) continue
            state = value.state; reason = value.reason; sourceHash = value.sourceHash; createdAt = value.createdAt; preview = value.summary?.text ?? value.facts.map(item => `${item.subject} ${item.predicate} ${item.value}`).join('；')
          } else if (entry.kind === 'intent') {
            const value = await intents.suggestion(request.bookId, entry.id)
            if (['accepted', 'rejected'].includes(value.state)) continue
            state = value.state; sourceHash = value.sourceHash; createdAt = value.createdAt; preview = value.directions.map(item => item.goal).join('；')
          } else {
            const value = await stories.suggestion(request.bookId, entry.id)
            if (['accepted', 'rejected'].includes(value.state) || value.events.length + value.foreshadows.length === 0) continue
            state = value.state; sourceHash = value.sourceHash; createdAt = value.createdAt; preview = [...value.events.map(item => item.title), ...value.foreshadows.map(item => item.title)].join('；')
          }
        }
        const document = book.chapters.find(item => item.chapterId === chapterId)!
        items.push({ key: entry.key, kind: entry.kind, proposalId: entry.kind === 'source' ? '' : entry.id, chapterId,
          title: document.title, state, reason, createdAt, sourceHash, preview: preview.slice(0, 240) })
      } catch (error) {
        if (signal.aborted) throw error
        complete = false; unreadable++
      }
    }
    signal.throwIfAborted()
    return { items, nextCursor: entries.some(entry => entry.key.localeCompare(cursor) > 0) ? cursor : '', complete, unreadable, scanned }
  }
}
