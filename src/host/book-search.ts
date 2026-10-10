import { z } from 'zod'
import { BookError, hash, idSchema, materialKind } from '../domain/books.js'
import type { BookSearchRequest, BookSearchResult, BookSearchHit } from '../types.js'
import { BookFiles } from './book-files.js'
import { BookStore } from './book-store.js'

const schema = z.strictObject({ workspaceId: z.string().regex(/^[a-f0-9]{64}$/), bookId: idSchema,
  query: z.string().max(500), kind: z.enum(['all', 'chapter', 'materials', 'seed', 'book-card', 'character', 'world', 'outline', 'chapter-outline', 'scene']),
  includeArchived: z.boolean(), offset: z.int().nonnegative().max(10_000) })
const literal = (term: string): RegExp => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
export interface SearchLimits { readonly bytes: number; readonly documents: number }

/** The source files remain authoritative. Searching never publishes or creates an index. */
export class BookSearch {
  private constructor(private readonly files: BookFiles, private readonly books: BookStore, private readonly limits: SearchLimits) {}
  static async at(root: string, books: BookStore, limits: SearchLimits = { bytes: 128 * 1024 * 1024, documents: 10_000 }): Promise<BookSearch> {
    return new BookSearch(await BookFiles.at(root), books, limits)
  }

  async search(input: BookSearchRequest, signal: AbortSignal): Promise<BookSearchResult> {
    signal.throwIfAborted()
    const request = schema.parse(input)
    if (request.workspaceId !== hash(this.files.root)) throw new BookError('location-changed')
    const book = await this.books.readBook(request.bookId)
    if (book.recoveryRequired) throw new BookError('recovery-required')
    const expressions = request.query.trim().split(/\s+/u).filter(Boolean).map(literal), hits: BookSearchHit[] = []
    let bytes = 0, scanned = 0, skipped = 0, complete = true
    if (expressions.length) for (const item of book.chapters) {
      signal.throwIfAborted()
      const kind = item.kind ?? 'chapter'
      if (kind !== 'chapter' && !materialKind(kind) || item.status === 'trashed' || !request.includeArchived && item.status === 'archived' ||
        request.kind !== 'all' && (request.kind === 'materials' ? !materialKind(kind) : kind !== request.kind)) continue
      if (scanned >= this.limits.documents || bytes >= this.limits.bytes) { complete = false; break }
      scanned++
      let file
      try { file = await this.files.read(`novels/${book.bookId}/chapters/${item.chapterId}.md`) }
      catch (error) {
        if (error instanceof BookError && ['too-large', 'invalid-text'].includes(error.code)) { complete = false; skipped++; continue }
        throw error
      }
      signal.throwIfAborted()
      if (!file.exists) { complete = false; skipped++; continue }
      bytes += Buffer.byteLength(file.text, 'utf8')
      if (bytes > this.limits.bytes) { complete = false; break }
      const metadata = [item.title, ...(item.aliases ?? []), ...(item.tags ?? [])].join('\n')
      if (!expressions.every(expression => expression.test(metadata) || expression.test(file.text))) continue
      const matches = expressions.map(expression => expression.exec(file.text)).filter(match => match !== null)
      const first = matches.sort((a, b) => a.index - b.index)[0]
      const start = first?.index ?? 0, end = first ? start + first[0].length : 0
      const left = Math.max(0, start - 48), right = Math.min(file.text.length, Math.max(end + 80, left + 160))
      const digest = hash(file.text)
      hits.push({ chapterId: item.chapterId, title: item.title, kind, revision: item.revision, hash: digest,
        start, end, quote: file.text.slice(start, end), snippet: `${left ? '…' : ''}${file.text.slice(left, right)}${right < file.text.length ? '…' : ''}`,
        externallyModified: digest !== item.hash, archived: item.status === 'archived' })
    }
    signal.throwIfAborted()
    const latest = await this.books.readBook(book.bookId)
    if (latest.recoveryRequired || latest.revision !== book.revision) throw new BookError('revision-conflict')
    return { workspaceId: request.workspaceId, bookId: book.bookId, revision: book.revision,
      items: hits.slice(request.offset, request.offset + 50), total: hits.length, complete, scanned, skipped }
  }
}
