import React, { useState } from 'react'
import { Button } from './primitives.js'

export function StructurePreview({ book, preview, busy, writable, t, confirm, edit }) {
  const [page, setPage] = useState(0), [all, setAll] = useState(false), [impactPage, setImpactPage] = useState(0)
  const changes = preview.value.changes.filter(item => all || item.beforePosition !== item.afterPosition || JSON.stringify(item.before) !== JSON.stringify(item.after))
  const at = Math.min(page, Math.max(0, Math.ceil(changes.length / 25) - 1)), outdated = preview.value.revision !== book.revision || book.recoveryRequired
  const volume = (id, plan) => plan.volumes.find(item => item.volumeId === id)?.title ?? t('unassignedVolume')
  return <section className="sn-structure-preview">
    <p className="sn-notice">{t('structurePreviewHint')}</p>
    {outdated && <p role="alert">{t('structureSourceChanged')}</p>}
    <div className="sn-row sn-structure-actions"><Button size="sm" disabled={busy} onClick={edit}>{t('backToStructureInput')}</Button><Button variant="primary" size="sm" disabled={busy || !writable || outdated} onClick={confirm}>{t('confirmStructure')}</Button></div>
    <div className="sn-structure-groups-preview">
      <p>{t('volumes')}: {(book.volumes ?? []).map(item => item.title).join(' / ') || t('none')} → {preview.request.structure.volumes.map(item => item.title).join(' / ') || t('none')}</p>
      <p>{t('storylines')}: {(book.storylines ?? []).map(item => item.title).join(' / ') || t('none')} → {preview.request.structure.storylines.map(item => item.title).join(' / ') || t('none')}</p>
    </div>
    <div className="sn-row sn-structure-list-heading"><strong>{changes.length} {t(all ? 'chapters' : 'structureChangedChapters')}</strong><Button size="sm" onClick={() => { setAll(value => !value); setPage(0) }}>{t(all ? 'showChangedChapters' : 'showAllChapters')}</Button></div>
    <div className="sn-structure-changes">{changes.slice(at * 25, at * 25 + 25).map(item => <article key={item.chapterId} className="sn-structure-change">
      <strong>{item.title}</strong><p>{t('structurePosition')}: {item.beforePosition} → {item.afterPosition} · {volume(item.before.volumeId, { volumes: book.volumes ?? [] })} → {volume(item.after.volumeId, preview.request.structure)}</p>
      <p>{t('chapterProgress')}: {t('progress-' + item.before.progress)} → {t('progress-' + item.after.progress)}</p>
      {JSON.stringify(item.before.storylineIds) !== JSON.stringify(item.after.storylineIds) && <p>{t('storylines')}: {item.before.storylineIds.map(id => book.storylines?.find(line => line.storylineId === id)?.title ?? id).join(' / ') || t('none')} → {item.after.storylineIds.map(id => preview.request.structure.storylines.find(line => line.storylineId === id)?.title ?? id).join(' / ') || t('none')}</p>}
      {item.before.summary !== item.after.summary && <details><summary>{t('chapterSummary')}</summary><blockquote>{item.before.summary || t('none')}</blockquote><blockquote>{item.after.summary || t('none')}</blockquote></details>}
    </article>)}</div>
    {changes.length > 25 && <div className="sn-pagination"><Button size="sm" disabled={!at} onClick={() => setPage(at - 1)}>{t('previousPage')}</Button><span>{at + 1} / {Math.ceil(changes.length / 25)}</span><Button size="sm" disabled={(at + 1) * 25 >= changes.length} onClick={() => setPage(at + 1)}>{t('nextPage')}</Button></div>}
    {!!preview.value.movedChapterIds.length && <details className="sn-structure-impact" open><summary>{t('structureRelatedRecords')} ({preview.value.impacts.items.length})</summary><p className="sn-notice">{t('structureImpactHint')}</p>
      {!preview.value.impacts.complete && <p role="alert">{t('structureImpactIncomplete')} {preview.value.impacts.unreadable ? `${preview.value.impacts.unreadable} ${t('inboxUnreadable')}` : ''}</p>}
      {preview.value.impacts.items.slice(impactPage * 25, impactPage * 25 + 25).map(item => <p key={`${item.kind}:${item.id}`}><span>{t('structure-kind-' + item.kind)}</span> · {item.title} · {t('structureNeedsCheck')}</p>)}
      {!preview.value.impacts.items.length && <p>{t('structureNoRelatedRecords')}</p>}
      {preview.value.impacts.items.length > 25 && <div className="sn-pagination"><Button size="sm" disabled={!impactPage} onClick={() => setImpactPage(value => value - 1)}>{t('previousPage')}</Button><span>{impactPage + 1} / {Math.ceil(preview.value.impacts.items.length / 25)}</span><Button size="sm" disabled={(impactPage + 1) * 25 >= preview.value.impacts.items.length} onClick={() => setImpactPage(value => value + 1)}>{t('nextPage')}</Button></div>}
    </details>}
  </section>
}
