import React from 'react'
import { Button } from './primitives.js'

/** Stable document IDs keep renamed and identically titled references distinct. */
export function DocumentLinks({ book, item, references, t, navigate }) {
  const list = (title, ids) => <div className="sn-document-links"><h4>{t(title)}</h4>{ids.length ? <div className="sn-link-list">{ids.slice(0, 100).map(id => {
    const source = book.chapters.find(record => record.chapterId === id)
    return <Button size="sm" key={id} disabled={!source} onClick={() => navigate({ chapterId: id })}>{source?.title ?? t('missingLinkedChapter')}</Button>
  })}</div> : <p className="sn-notice">{t('none')}</p>}{ids.length > 100 && <p className="sn-notice">{t('referenceLimit')}</p>}</div>
  const linked = [...new Set([...(item.linkedChapterIds ?? []), ...(item.linkedChapterId ? [item.linkedChapterId] : [])])]
  const incoming = references?.incoming ?? book.chapters.filter(source => source.relatedMaterialIds?.includes(item.chapterId)).map(source => source.chapterId)
  const related = book.chapters.filter(source => source.linkedChapterId === item.chapterId || source.linkedChapterIds?.includes(item.chapterId)).map(source => source.chapterId)
  const evidence = item.sourceEvidence
  return <details className="sn-document-references"><summary>{t('sourcesAndUses')}</summary>
    {evidence && <div className="sn-document-links"><h4>{t('selectionSource')}</h4><Button size="sm" onClick={() => navigate({ ...evidence })}>{book.chapters.find(source => source.chapterId === evidence.chapterId)?.title ?? t('missingLinkedChapter')} · v{evidence.revision}</Button></div>}
    {list('linkedChapters', references?.linkedChapterIds ?? linked)}
    {list('relatedMaterials', item.relatedMaterialIds ?? [])}
    {list('backlinks', incoming)}
    {related.length > 0 && list('chapterReferences', related)}
    {references?.evidenceChapterIds.length > 0 && list('evidenceSources', references.evidenceChapterIds)}
    {!!references?.uses.length && <div className="sn-document-links"><h4>{t('generationUses')}</h4><div className="sn-link-list">{references.uses.slice(0, 100).map(use => <Button size="sm" key={use.proposalId} onClick={() => navigate({ chapterId: use.chapterId, proposalId: use.proposalId })}>{book.chapters.find(source => source.chapterId === use.chapterId)?.title ?? t('missingLinkedChapter')} · {t(use.state)}{use.stale ? ` · ${t('sourceChanged')}` : ''}</Button>)}</div>{references.uses.length > 100 && <p className="sn-notice">{t('referenceLimit')}</p>}</div>}
    {references && !references.complete && <p role="status">{t('searchIncomplete')}</p>}
  </details>
}
