import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { BookError, chapterLinks, hash, idSchema, materialKind } from '../domain/books.js'
import { parseFactDocument, parseFactProposal } from '../domain/facts.js'
import { parseProposal } from '../domain/proposals.js'
import type { BookSnapshot, StructureImpacts } from '../types.js'
import { BookFiles } from './book-files.js'
import { intentRecordSchema, intentSuggestionSchema } from './intent-store.js'
import { reviewRecordSchema } from './review-store.js'
import { storyRecordSchema, storySuggestionSchema } from './story-store.js'

export const STRUCTURE_LIMITS = { names: 10_000, scans: 500, bytes: 32 * 1024 * 1024, items: 1000 } as const

/** Advisory references for an order change. Actual expiry is still decided by the original stores. */
export async function structureImpacts(files: BookFiles, workspaceId: string, book: BookSnapshot, moved: readonly string[], signal: AbortSignal): Promise<StructureImpacts> {
  const affected = new Set(moved), items: StructureImpacts['items'][number][] = [], fingerprint = createHash('sha256')
  let complete = true, unreadable = 0, scanned = 0, bytes = 0
  const folder = `novels/${book.bookId}`, title = (id: string): string => book.chapters.find(item => item.chapterId === id)?.title ?? id
  const check = (): void => { signal.throwIfAborted(); if (scanned >= STRUCTURE_LIMITS.scans || bytes >= STRUCTURE_LIMITS.bytes || items.length >= STRUCTURE_LIMITS.items) throw new BookError('impact-budget') }
  const add = (kind: StructureImpacts['items'][number]['kind'], id: string, chapterId: string, label: string): void => { check(); items.push({ kind, id, chapterId, title: label }) }
  const read = async (path: string): Promise<string> => {
    check(); scanned++
    const file = await files.read(path, Math.min(16 * 1024 * 1024, STRUCTURE_LIMITS.bytes - bytes))
    if (!file.exists) throw new BookError('revision-conflict')
    bytes += Buffer.byteLength(file.text); fingerprint.update(path).update('\0').update(hash(file.text)).update('\0')
    return file.text
  }
  const names = async (path: string): Promise<string[]> => {
    signal.throwIfAborted()
    try { const result = await readdir(await files.path(path)); if (result.length > STRUCTURE_LIMITS.names) complete = false; return result.sort().slice(0, STRUCTURE_LIMITS.names) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  const attempt = async (fn: () => Promise<void>): Promise<void> => {
    try { await fn() } catch (error) { if (signal.aborted || error instanceof BookError && error.code === 'impact-budget') throw error; complete = false; unreadable++ }
  }
  const latest = async (path: string): Promise<{ text: string; version: number }[]> => {
    const versions = (await names(path)).filter(name => /^\d{8}\.json$/.test(name))
    if (!versions.length) return []
    if (versions.some((name, at) => Number(name.slice(0, 8)) !== at + 1)) throw new BookError('invalid-format')
    return [{ text: await read(`${path}/${versions.at(-1)!}`), version: versions.length }]
  }
  try {
    if (affected.size) {
      for (const item of book.chapters) {
        signal.throwIfAborted()
        if (materialKind(item.kind) && (item.sourceEvidence && affected.has(item.sourceEvidence.chapterId) || chapterLinks(item).some(id => affected.has(id)))) add('material', item.chapterId, item.chapterId, item.title)
        if (item.kind === 'facts' && item.linkedChapterId && affected.has(item.linkedChapterId)) await attempt(async () => {
          parseFactDocument(await read(`${folder}/chapters/${item.chapterId}.md`)); add('facts', item.chapterId, item.linkedChapterId!, item.title)
        })
      }
      for (const name of await names(`${folder}/proposals`)) if (name.endsWith('.json') && idSchema.safeParse(name.slice(0, -5)).success) await attempt(async () => {
        const value = parseProposal(await read(`${folder}/proposals/${name}`), workspaceId, book.bookId, name.slice(0, -5))
        if (affected.has(value.request.chapterId) || value.context?.some(item => affected.has(item.chapterId)) || value.request.useFacts || value.request.useStoryState || value.voiceContext?.some(item => affected.has(item.sourceChapterId))) {
          add('proposal', value.request.proposalId, value.request.chapterId, title(value.request.chapterId))
        }
      })
      for (const name of await names(`${folder}/reviews`)) if (name.endsWith('.json') && idSchema.safeParse(name.slice(0, -5)).success) await attempt(async () => {
        const value = reviewRecordSchema.parse(JSON.parse(await read(`${folder}/reviews/${name}`)))
        if (value.workspaceId !== workspaceId || value.request.bookId !== book.bookId || value.request.reviewId !== name.slice(0, -5)) throw new BookError('invalid-format')
        // Reviews can carry a preceding-fact context even if their own position stays fixed.
        add('review', value.request.reviewId, value.request.chapterId, title(value.request.chapterId))
      })
      for (const name of await names(`${folder}/fact-proposals`)) if (name.endsWith('.json') && idSchema.safeParse(name.slice(0, -5)).success) await attempt(async () => {
        const value = parseFactProposal(await read(`${folder}/fact-proposals/${name}`), workspaceId, book.bookId, name.slice(0, -5))
        if (affected.has(value.request.sourceChapterId)) add('fact-suggestion', value.request.proposalId, value.request.sourceChapterId, title(value.request.sourceChapterId))
      })
      for (const name of await names(`${folder}/intent-proposals`)) if (name.endsWith('.json') && idSchema.safeParse(name.slice(0, -5)).success) await attempt(async () => {
        const value = intentSuggestionSchema.parse(JSON.parse(await read(`${folder}/intent-proposals/${name}`)))
        if (value.request.workspaceId !== workspaceId || value.request.bookId !== book.bookId || value.request.proposalId !== name.slice(0, -5)) throw new BookError('invalid-format')
        if (affected.has(value.request.chapterId)) add('intent', value.request.proposalId, value.request.chapterId, title(value.request.chapterId))
      })
      for (const name of await names(`${folder}/story-proposals`)) if (name.endsWith('.json') && idSchema.safeParse(name.slice(0, -5)).success) await attempt(async () => {
        const value = storySuggestionSchema.parse(JSON.parse(await read(`${folder}/story-proposals/${name}`)))
        if (value.request.workspaceId !== workspaceId || value.request.bookId !== book.bookId || value.request.proposalId !== name.slice(0, -5)) throw new BookError('invalid-format')
        if (affected.has(value.request.chapterId)) add('story-suggestion', value.request.proposalId, value.request.chapterId, title(value.request.chapterId))
      })
      for (const chapterId of moved) await attempt(async () => {
        for (const item of await latest(`${folder}/intents/${chapterId}`)) {
          const value = intentRecordSchema.parse(JSON.parse(item.text))
          if (value.request.workspaceId !== workspaceId || value.request.bookId !== book.bookId || value.request.chapterId !== chapterId || value.request.expectedVersion + 1 !== item.version) throw new BookError('invalid-format')
          add('intent', chapterId, chapterId, title(chapterId))
        }
      })
      await attempt(async () => {
        for (const item of await latest(`${folder}/story-state`)) {
          const value = storyRecordSchema.parse(JSON.parse(item.text))
          if (value.request.workspaceId !== workspaceId || value.request.bookId !== book.bookId || value.request.expectedVersion + 1 !== item.version) throw new BookError('invalid-format')
          for (const event of value.events) if (affected.has(event.evidence.chapterId)) add('event', event.eventId, event.evidence.chapterId, event.title)
          for (const record of value.foreshadows) if (record.planted && affected.has(record.planted.chapterId) || record.resolved && affected.has(record.resolved.chapterId)) add('foreshadow', record.foreshadowId, record.planted?.chapterId ?? '', record.title)
        }
      })
    }
  } catch (error) { if (signal.aborted) throw error; if (error instanceof BookError && error.code === 'impact-budget') complete = false; else { complete = false; unreadable++ } }
  signal.throwIfAborted()
  return { items, complete, unreadable, scanned, sourceHash: fingerprint.digest('hex') }
}
