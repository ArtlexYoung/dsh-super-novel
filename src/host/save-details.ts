import { z } from 'zod'
import { BookError, hash, idSchema } from '../domain/books.js'
import type { SaveDetails, SaveDetailsRequest } from '../types.js'
import { BackupStore } from './backup-store.js'
import { BookStore } from './book-store.js'
import { DraftStore } from './draft-store.js'

export const saveDetailsSchema = z.strictObject({ workspaceId: z.string().regex(/^[a-f\d]{64}$/), bookId: idSchema, chapterId: idSchema, branchId: idSchema, operationId: z.union([idSchema, z.literal('')]) })
const reason = (error: unknown): string => error instanceof BookError ? error.code : 'storage-failed'

/** Each layer reports independently. Another branch or book cannot confirm this input. */
export async function saveDetails(root: string, books: BookStore, input: SaveDetailsRequest, signal: AbortSignal): Promise<SaveDetails> {
  const request = saveDetailsSchema.parse(input)
  if (request.workspaceId !== hash(root)) throw new BookError('location-changed')
  signal.throwIfAborted()
  const formal = async (): Promise<SaveDetails['formal']> => {
    try {
      const book = await books.readBook(request.bookId)
      if (book.recoveryRequired) return { state: 'recovery-required', revision: 0, hash: '', reason: 'recovery-required' }
      const chapter = await books.readChapter(request.bookId, request.chapterId)
      return { state: chapter.externallyModified ? 'external' : 'saved', revision: chapter.book.chapters.find(item => item.chapterId === request.chapterId)!.revision, hash: chapter.hash, reason: '' }
    } catch (error) { signal.throwIfAborted(); return { state: 'unavailable', revision: 0, hash: '', reason: reason(error) } }
  }
  const draft = async (): Promise<SaveDetails['draft']> => {
    try {
      const listing = await (await DraftStore.at(root, request.workspaceId, books)).list({ workspaceId: request.workspaceId, bookId: request.bookId, chapterId: request.chapterId })
      const current = listing.drafts.find(item => item.branchId === request.branchId && item.operationId === request.operationId), latest = listing.drafts[0]
      return { state: current ? 'confirmed' : 'not-recorded', reason: listing.unreadable ? 'draft-unreadable' : '', unreadable: listing.unreadable, ...(current ? { current } : {}), ...(latest ? { latest } : {}) }
    } catch (error) { signal.throwIfAborted(); return { state: 'unavailable', reason: reason(error), unreadable: 0 } }
  }
  const backup = async (): Promise<SaveDetails['backup']> => {
    let attempt: SaveDetails['backup']['attempt'] = { state: 'none', attemptedAt: 0, reason: '' }
    try {
      const store = await BackupStore.at(root)
      attempt = await store.health(request.bookId)
      const listing = await store.listStatus(request.bookId)
      if (!listing.complete) return { state: 'unavailable', reason: 'backup-list-incomplete', attempt }
      const latest = listing.items[0]
      if (!latest) return { state: 'none', reason: '', attempt }
      const verified = await store.inspect(request.bookId, latest.backupId, signal)
      return { state: 'verified', reason: '', summary: verified.summary, attempt }
    } catch (error) { signal.throwIfAborted(); return { state: 'unavailable', reason: reason(error), attempt } }
  }
  const layers = await Promise.all([formal(), draft(), backup()])
  signal.throwIfAborted()
  return { formal: layers[0], draft: layers[1], backup: layers[2] }
}
