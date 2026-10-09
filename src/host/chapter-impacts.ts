import { readdir } from 'node:fs/promises'
import { BookError, idSchema } from '../domain/books.js'
import { parseFactDocument } from '../domain/facts.js'
import type { ChapterImpacts } from '../types.js'
import { BookFiles } from './book-files.js'
import { BookStore } from './book-store.js'
import { ProposalStore } from './proposal-store.js'
import { ReviewStore } from './review-store.js'
import { StoryStore } from './story-store.js'

/** Derived dependency report; no mutation, automatic rewrites, or paid calls. */
export async function chapterImpacts(root: string, workspaceId: string, books: BookStore, bookId: string, chapterId: string, signal: AbortSignal): Promise<ChapterImpacts> {
  const source = await books.readChapter(bookId, chapterId), document = source.book.chapters.find(item => item.chapterId === chapterId)!, files = await BookFiles.at(root)
  const items: ChapterImpacts['items'][number][] = [], proposals = await ProposalStore.at(root, workspaceId, books), reviews = await ReviewStore.at(root, workspaceId, books)
  let complete = true, bytes = 0
  const check = (): void => { signal.throwIfAborted(); if (items.length >= 1000 || bytes > 128 * 1024 * 1024) throw new BookError('impact-budget') }
  const account = (text: string): void => { bytes += Buffer.byteLength(text); check() }
  const add = (kind: ChapterImpacts['items'][number]['kind'], id: string, targetId: string, title: string, expired: boolean): void => { items.push({ kind, id, chapterId: targetId, title, state: expired ? 'expired' : 'current' }) }
  try {
    for (const item of source.book.chapters) {
      check()
      if (item.sourceEvidence?.chapterId === chapterId) add('material', item.chapterId, item.chapterId, item.title, item.sourceEvidence.hash !== source.hash || item.sourceEvidence.revision !== document.revision || source.externallyModified)
      if (item.kind === 'facts' && item.linkedChapterId === chapterId) {
        const current = await books.readChapter(bookId, item.chapterId)
        account(current.content)
        const fact = parseFactDocument(current.content)
        const expired = fact.sourceHash !== source.hash || fact.sourceRevision !== document.revision || source.externallyModified || current.externallyModified
        add('facts', item.chapterId, item.chapterId, item.title, expired)
        if (fact.summary) add('summary', item.chapterId, item.chapterId, fact.summary.text.slice(0, 120), expired)
      }
    }
    const folder = `novels/${bookId}/proposals`; let names: string[]
    try { names = await readdir(await files.path(folder)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = []; else throw error }
    if (names.length > 10_000) complete = false
    for (const name of names.slice(0, 10_000)) if (name.endsWith('.json') && idSchema.safeParse(name.slice(0, -5)).success) {
      check(); const file = await files.read(`${folder}/${name}`, 32 * 1024 * 1024); account(file.text)
      const proposal = await proposals.read(bookId, name.slice(0, -5)), story = JSON.parse(proposal.storyContext?.content || '{}')
      const affected = proposal.request.chapterId === chapterId || proposal.context?.some(item => item.chapterId === chapterId) || proposal.factContext?.sources.some(item => item.chapterId === chapterId) || proposal.voiceContext?.some(item => item.sourceChapterId === chapterId) || story.events?.some((item: { evidence?: { chapterId: string }; source?: { chapterId: string } }) => (item.evidence ?? item.source)?.chapterId === chapterId) || story.foreshadows?.some((item: { planted: { chapterId: string }; resolved?: { chapterId: string } }) => item.planted.chapterId === chapterId || item.resolved?.chapterId === chapterId)
      if (affected) {
        const view = await proposals.view(bookId, proposal.request.proposalId, false)
        const stale = view.state === 'expired' || proposal.context?.some(item => item.chapterId === chapterId && (item.hash !== source.hash || item.revision !== document.revision)) || proposal.factContext?.sources.some(item => item.chapterId === chapterId && (item.hash !== source.hash || item.revision !== document.revision)) || proposal.voiceContext?.some(item => item.sourceChapterId === chapterId && item.sourceHash !== source.hash)
        add('proposal', view.proposalId, view.chapterId, source.book.chapters.find(item => item.chapterId === view.chapterId)?.title ?? view.mode, !!stale)
      }
    }
    const relatedProposals = new Set(items.filter(item => item.kind === 'proposal').map(item => item.id))
    const reviewFolder = `novels/${bookId}/reviews`
    try { names = await readdir(await files.path(reviewFolder)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = []; else throw error }
    if (names.length > 10_000) complete = false
    for (const name of names.slice(0, 10_000)) if (name.endsWith('.json') && idSchema.safeParse(name.slice(0, -5)).success) {
      check(); const file = await files.read(`${reviewFolder}/${name}`, 32 * 1024 * 1024); account(file.text)
      const value = JSON.parse(file.text)
      if (value.request.chapterId !== chapterId && !relatedProposals.has(value.request.proposalId) && !value.request.materialIds?.includes(chapterId)) continue
      const review = await reviews.get(bookId, name.slice(0, -5))
      add('review', review.reviewId, review.chapterId, source.book.chapters.find(item => item.chapterId === review.chapterId)?.title ?? review.reviewId, review.state === 'expired')
    }
    const story = await (await StoryStore.at(root, workspaceId, books)).read(bookId)
    account(JSON.stringify(story))
    for (const item of story.events) if (item.evidence.chapterId === chapterId) { check(); add('event', item.eventId, chapterId, item.title, item.state === 'expired') }
    for (const item of story.foreshadows) if (item.planted?.chapterId === chapterId || item.resolved?.chapterId === chapterId) { check(); add('foreshadow', item.foreshadowId, chapterId, item.title, item.state === 'expired') }
  } catch (error) { if (error instanceof BookError && error.code === 'impact-budget') complete = false; else throw error }
  if ((await books.readBook(bookId)).revision !== source.book.revision) throw new BookError('revision-conflict')
  return { items, complete }
}
