import React, { useEffect, useState } from 'react'
import { Button, Input, IconSearchOutline16 } from './primitives.js'
import { Select } from './controls.js'
import { unwrap } from './books.js'

export function BookSearchPanel({ api, sessionId, workspaceId, book, open, dirty, t, preview }) {
  const [query, setQuery] = useState(''), [kind, setKind] = useState('all'), [archived, setArchived] = useState(false), [offset, setOffset] = useState(0)
  const [view, setView] = useState({ kind: 'idle' }), [retry, setRetry] = useState(0)
  useEffect(() => setOffset(0), [query, kind, archived])
  useEffect(() => {
    if (!open || !query.trim()) { setView({ kind: 'idle' }); return }
    const controller = new AbortController()
    setView({ kind: 'loading' })
    const timer = setTimeout(() => api.searchBook(sessionId, { workspaceId, bookId: book.bookId, query, kind, includeArchived: archived, offset }, controller.signal).then(unwrap)
      .then(value => { if (!controller.signal.aborted) setView({ kind: 'ready', value }) })
      .catch(error => { if (!controller.signal.aborted) setView({ kind: 'error', reason: error.reason ?? 'storage-failed' }) }), 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [api, sessionId, workspaceId, book.bookId, book.revision, query, kind, archived, offset, open, retry])
  return <div className="sn-book-search">
    <div className="sn-search"><IconSearchOutline16 /><Input className="sn-input" type="search" aria-label={t('searchBookText')} placeholder={t('searchBookHint')} maxLength={500} value={query} onChange={event => setQuery(event.target.value)} /></div>
    <div className="sn-row"><Select aria-label={t('searchBookScope')} value={kind} onChange={event => setKind(event.target.value)}>{['all', 'chapter', 'materials', 'character', 'world', 'outline', 'scene'].map(value => <option key={value} value={value}>{t('search-kind-' + value)}</option>)}</Select><Button size="sm" aria-pressed={archived} onClick={() => setArchived(value => !value)}>{t('includeArchived')}</Button></div>
    <p className="sn-notice">{t(dirty ? 'searchSavedDraftHint' : 'searchSavedHint')}</p>
    {view.kind === 'idle' && <p className="sn-search-empty">{t('searchBookEmpty')}</p>}
    {view.kind === 'loading' && <p role="status">{t('loading')}</p>}
    {view.kind === 'error' && <p role="alert">{t(view.reason)} <Button size="sm" onClick={() => setRetry(value => value + 1)}>{t('refresh')}</Button></p>}
    {view.kind === 'ready' && <>
      <p role="status">{view.value.total}{view.value.complete ? '' : '+'} {t('searchMatches')}{!view.value.complete && ` · ${t('searchIncomplete')}`}</p>
      {!view.value.total && <p className="sn-search-empty">{t('noMatchingDocuments')}</p>}
      <nav className="sn-search-results" aria-label={t('searchMatches')}>{view.value.items.map(item => <Button size="sm" key={item.chapterId} onClick={() => preview(item)}>
        <span className="sn-search-result-title">{item.title}<small>{t(item.kind)}{item.archived ? ` · ${t('status-archived')}` : ''}{item.externallyModified ? ` · ${t('sourceChanged')}` : ''}</small></span><span className="sn-search-snippet">{item.snippet || t('emptyReference')}</span>
      </Button>)}</nav>
      {view.value.total > 50 && <div className="sn-pagination"><Button size="sm" disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 50))}>{t('previousPage')}</Button><span>{Math.floor(offset / 50) + 1}</span><Button size="sm" disabled={offset + 50 >= view.value.total} onClick={() => setOffset(value => value + 50)}>{t('nextPage')}</Button></div>}
    </>}
  </div>
}
