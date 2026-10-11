import type { BookSnapshot, BookStructure } from '../types.js'

export function outlinePlan(book: BookSnapshot): BookStructure {
  if (book.schemaVersion !== 3) throw new Error('structure-migration-required')
  return { volumes: [...(book.volumes ?? [])].map(item => ({ ...item })), storylines: [...(book.storylines ?? [])].map(item => ({ ...item })),
    chapters: book.chapters.filter(item => !item.kind || item.kind === 'chapter').map(item => ({ chapterId: item.chapterId, ...item.structure!, storylineIds: [...item.structure!.storylineIds] })) }
}

/** Volume order is canonical; the author's relative chapter order stays stable within each group. */
export function groupOutline(plan: BookStructure): BookStructure {
  const ranks = new Map(plan.volumes.map((item, at) => [item.volumeId, at]))
  return { ...plan, chapters: [...plan.chapters].sort((a, b) => (ranks.get(a.volumeId) ?? ranks.size) - (ranks.get(b.volumeId) ?? ranks.size)) }
}
export function moveOutlineChapter(plan: BookStructure, chapterId: string, direction: -1 | 1): BookStructure {
  const chapter = plan.chapters.find(item => item.chapterId === chapterId)
  if (!chapter) throw new Error('chapter-not-found')
  const peers = plan.chapters.filter(item => item.volumeId === chapter.volumeId), at = peers.findIndex(item => item.chapterId === chapterId), target = peers[at + direction]
  if (!target) return plan
  const next = [...plan.chapters], from = next.findIndex(item => item.chapterId === chapterId), to = next.findIndex(item => item.chapterId === target.chapterId)
  const original = next[from]!
  next[from] = next[to]!; next[to] = original
  return { ...plan, chapters: next }
}
export function rebindOutline(plan: BookStructure, book: BookSnapshot): BookStructure {
  const saved = outlinePlan(book), ids = new Set(saved.chapters.map(item => item.chapterId)), known = new Set(plan.chapters.map(item => item.chapterId))
  const volumes = new Set(plan.volumes.map(item => item.volumeId)), storylines = new Set(plan.storylines.map(item => item.storylineId))
  return groupOutline({ ...plan, chapters: [...plan.chapters.filter(item => ids.has(item.chapterId)), ...saved.chapters.filter(item => !known.has(item.chapterId))]
    .map(item => ({ ...item, volumeId: volumes.has(item.volumeId) ? item.volumeId : '', storylineIds: item.storylineIds.filter(id => storylines.has(id)) })) })
}
