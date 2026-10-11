import React, { useEffect, useRef, useState } from 'react'
import { Button, Input, IconRefreshOutline16 } from './primitives.js'
import { Select } from './controls.js'
import { StructureEditor } from './structure-editor.js'
import { unwrap } from './books.js'

export function BookOutlinePanel({ api, sessionId, workspaceId, book, chapterId, branchId, open, preferredAction, writable, t, changed, beforeChange, writeChapter, intent, scene }) {
  const [query, setQuery] = useState(''), [volume, setVolume] = useState('all'), [line, setLine] = useState('all'), [progress, setProgress] = useState('all'), [offset, setOffset] = useState(0)
  const [result, setResult] = useState(null), [editing, setEditing] = useState(false), [selected, setSelected] = useState(chapterId), [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const activation = useRef({ operationId: crypto.randomUUID(), backupId: crypto.randomUUID() }), latest = useRef(0)
  const prose = book.chapters.filter(item => !item.kind || item.kind === 'chapter')
  useEffect(() => { if (preferredAction && open) { setSelected(preferredAction.chapterId); setEditing(true) } }, [preferredAction?.id, open])
  useEffect(() => {
    if (!open || book.schemaVersion !== 3 || book.recoveryRequired) return
    const controller = new AbortController(), generation = ++latest.current
    const timer = setTimeout(() => {
      api.bookOutline(sessionId, { workspaceId, bookId: book.bookId, query, offset, volumeId: volume, storylineId: line, progress }, controller.signal).then(unwrap).then(value => {
        if (!controller.signal.aborted && generation === latest.current) { setResult(value); setError('') }
      }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    }, 150)
    return () => { clearTimeout(timer); controller.abort() }
  }, [api, sessionId, workspaceId, book.bookId, book.revision, book.schemaVersion, book.recoveryRequired, query, volume, line, progress, offset, refresh, open])
  const enable = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { await beforeChange(); const value = unwrap(await api.enableBookStructure(sessionId, { workspaceId, bookId: book.bookId, expectedRevision: book.revision, ...activation.current }, new AbortController().signal)); changed(value); setRefresh(value => value + 1) }
    catch (error) { setError(error.reason ?? 'storage-failed') } finally { setBusy(false) }
  }
  const filter = (set, value) => { set(value); setOffset(0) }
  const arrange = id => { setSelected(id); setEditing(true) }
  return <div className="sn-book-outline">
    {error && <p role="alert">{t(error)}</p>}
    {book.schemaVersion !== 3 ? <div className="sn-outline-activation"><h3>{t('enableStructureTitle')}</h3><p>{t('enableStructureHint')}</p><p className="sn-notice">{t('enableStructureCompatibility')}</p><Button variant="primary" size="sm" disabled={busy || !writable || book.recoveryRequired} onClick={enable}>{t('enableStructure')}</Button>{busy && <p role="status">{t('enablingStructure')}</p>}</div> : <>
      {editing && result ? <StructureEditor key={`${workspaceId}:${book.bookId}`} api={api} sessionId={sessionId} workspaceId={workspaceId} book={book} baseHash={result.structureHash} branchId={branchId} selectedId={selected} preferredAction={preferredAction} writable={writable && !book.recoveryRequired} t={t} changed={changed} beforeChange={beforeChange} back={() => { setEditing(false); setRefresh(value => value + 1) }} /> : <>
        <div className="sn-outline-summary"><span>{prose.length} {t('chapters')}</span><span>{prose.filter(item => item.structure.progress === 'complete').length} {t('progress-complete')}</span><span>{book.volumes.length} {t('volumes')}</span><span>{book.storylines.length} {t('storylines')}</span></div>
        <div className="sn-row"><Button variant="primary" size="sm" disabled={!result || busy || !writable || book.recoveryRequired} onClick={() => arrange(chapterId)}>{t('arrangeStructure')}</Button><Button size="sm" aria-label={t('refresh')} disabled={busy} onClick={() => setRefresh(value => value + 1)}><IconRefreshOutline16 /></Button></div>
        <Input className="sn-input" type="search" aria-label={t('searchOutline')} placeholder={t('searchOutlineHint')} value={query} onChange={event => filter(setQuery, event.target.value)} />
        <details className="sn-outline-filters"><summary>{t('filterOutline')}{[volume, line, progress].some(value => value !== 'all') ? ` · ${t('activeFilters')}` : ''}</summary>
          <Select aria-label={t('filterVolume')} value={volume} onChange={event => filter(setVolume, event.target.value)}><option value="all">{t('allVolumes')}</option><option value="">{t('unassignedVolume')}</option>{book.volumes.map(item => <option key={item.volumeId} value={item.volumeId}>{item.title}</option>)}</Select>
          <Select aria-label={t('filterStoryline')} value={line} onChange={event => filter(setLine, event.target.value)}><option value="all">{t('allStorylines')}</option>{book.storylines.map(item => <option key={item.storylineId} value={item.storylineId}>{item.title}</option>)}</Select>
          <Select aria-label={t('filterChapterProgress')} value={progress} onChange={event => filter(setProgress, event.target.value)}><option value="all">{t('allProgress')}</option>{['unwritten', 'draft', 'revise', 'complete'].map(value => <option key={value} value={value}>{t('progress-' + value)}</option>)}</Select>
          <Button size="sm" onClick={() => { setQuery(''); setVolume('all'); setLine('all'); setProgress('all'); setOffset(0) }}>{t('clearFilters')}</Button>
        </details>
        {!result && <p role="status">{t('loading')}</p>}
        {result && !result.complete && <p role="status">{t('outlineIncomplete')} {result.unreadable} {t('inboxUnreadable')}</p>}
        {result && <><p className="sn-notice" role="status">{result.total} {t('chapters')} · {t('outlineReadingHint')}</p><div className="sn-outline-cards">{result.items.map(item => <article key={item.chapterId} className="sn-outline-card" data-chapter-id={item.chapterId}>
          <div className="sn-outline-card-meta"><span>{String(item.position).padStart(2, '0')} · {book.volumes.find(group => group.volumeId === item.structure.volumeId)?.title ?? t('unassignedVolume')}</span><span>{t('progress-' + item.structure.progress)}</span></div>
          <Button size="sm" className="sn-outline-card-title" onClick={() => writeChapter(item.chapterId)}>{item.title}</Button>
          <p className="sn-inbox-excerpt sn-outline-card-summary">{item.structure.summary || t('outlineNoSummary')}</p>
          {!!item.structure.storylineIds.length && <p className="sn-outline-card-lines">{item.structure.storylineIds.map(id => book.storylines.find(group => group.storylineId === id)?.title ?? id).join(' · ')}</p>}
          {(item.viewpoint || item.goal) && <p className="sn-inbox-excerpt sn-outline-intent">{item.viewpoint && `${t('intent-viewpoint')}: ${item.viewpoint} · `}{item.goal && `${t('intent-goal')}: ${item.goal}`}</p>}
          {!!item.sceneIds.length && <details className="sn-outline-scenes"><summary>{t('linkedSceneCards')} ({item.sceneIds.length})</summary><div className="sn-link-list">{item.sceneIds.map(id => <Button size="sm" key={id} onClick={() => scene(id)}>{book.chapters.find(document => document.chapterId === id)?.title ?? id}</Button>)}</div></details>}
          <div className="sn-row sn-outline-card-actions"><Button size="sm" disabled={!writable || book.recoveryRequired} onClick={() => arrange(item.chapterId)}>{t('arrangeChapter')}</Button><Button size="sm" onClick={() => intent(item.chapterId)}>{t('chapterIntent')}</Button></div>
        </article>)}</div>{!result.items.length && <p>{t('noMatchingDocuments')}</p>}
          {result.total > 25 && <div className="sn-pagination"><Button size="sm" disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 25))}>{t('previousPage')}</Button><span>{Math.floor(offset / 25) + 1} / {Math.ceil(result.total / 25)}</span><Button size="sm" disabled={offset + 25 >= result.total} onClick={() => setOffset(value => value + 25)}>{t('nextPage')}</Button></div>}
        </>}
      </>}
    </>}
  </div>
}
