import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Input, IconChevronLeftOutline14, IconSearchOutline16 } from './primitives.js'
import { Select } from './controls.js'
import { materialKinds } from './materials.js'
import { DocumentLinks } from './document-links.js'
import { unwrap } from './books.js'

/** Reading a reference never changes the active chapter, selection, or writing baseline. */
export function ReferencePanel({ api, sessionId, book, chapterId, open, writable, workspaceId, t, edit, navigate, manage }) {
  const [query, setQuery] = useState(''), [kind, setKind] = useState('all'), [selected, setSelected] = useState('')
  const [view, setView] = useState({ kind: 'idle' }), [filter, setFilter] = useState('all'), [searchResult, setSearchResult] = useState(null)
  const preferenceKey = `super-novel.references:${workspaceId}:${book.bookId}`
  const [preferences, setPreferences] = useState(() => { try { const value = JSON.parse(localStorage.getItem(preferenceKey) || '{}'); return { pinned: Array.isArray(value.pinned) ? value.pinned.filter(id => typeof id === 'string').slice(0, 20) : [], recent: Array.isArray(value.recent) ? value.recent.filter(id => typeof id === 'string').slice(0, 20) : [] } } catch { return { pinned: [], recent: [] } } })
  const remember = next => { setPreferences(next); try { localStorage.setItem(preferenceKey, JSON.stringify(next)) } catch { /* Reference preferences never affect the manuscript. */ } }
  const select = id => { setView({ kind: 'loading' }); setSelected(id); remember({ ...preferences, recent: [id, ...preferences.recent.filter(item => item !== id)].slice(0, 20) }) }
  const previewHeading = useRef(null)
  const materials = useMemo(() => book.chapters.filter(item => materialKinds.includes(item.kind) && !['archived', 'trashed'].includes(item.status)).sort((a, b) =>
    Number(b.linkedChapterId === chapterId || b.linkedChapterIds?.includes(chapterId)) - Number(a.linkedChapterId === chapterId || a.linkedChapterIds?.includes(chapterId))), [book, chapterId])
  const filtered = materials.filter(item => (kind === 'all' || item.kind === kind) &&
    (filter === 'all' || filter === 'chapter' && (item.linkedChapterId === chapterId || item.linkedChapterIds?.includes(chapterId)) || filter === 'favorite' && item.favorite || filter === 'pinned' && preferences.pinned.includes(item.chapterId) || filter === 'recent' && preferences.recent.includes(item.chapterId)) &&
    (!query.trim() || searchResult?.items.some(result => result.chapterId === item.chapterId)))
  if (filter === 'recent') filtered.sort((a, b) => preferences.recent.indexOf(a.chapterId) - preferences.recent.indexOf(b.chapterId))
  useEffect(() => {
    if (!open || !query.trim()) { setSearchResult(null); return }
    const controller = new AbortController()
    const timer = setTimeout(() => api.searchMaterials(sessionId, { bookId: book.bookId, query, kind, tag: '', status: 'available', linkedChapterId: '', favorite: false, offset: 0 }, controller.signal).then(unwrap).then(value => { if (!controller.signal.aborted) setSearchResult(value) }).catch(error => { if (!controller.signal.aborted) setView({ kind: 'error', reason: error.reason ?? 'storage-failed' }) }), 150)
    return () => { clearTimeout(timer); controller.abort() }
  }, [api, sessionId, book.bookId, book.revision, query, kind, open])
  const item = materials.find(item => item.chapterId === selected)
  useEffect(() => {
    if (!open || !item) return
    previewHeading.current?.focus({ preventScroll: true })
    const controller = new AbortController()
    setView({ kind: 'loading' })
    api.documentPreview(sessionId, { workspaceId, bookId: book.bookId, chapterId: item.chapterId, proposalId: '' }, controller.signal).then(unwrap).then(value => {
      if (!controller.signal.aborted) setView({ kind: 'ready', value: value.document, references: value.references })
    }).catch(error => { if (!controller.signal.aborted) setView({ kind: 'error', reason: error.reason ?? 'storage-failed' }) })
    return () => controller.abort()
  }, [api, sessionId, workspaceId, book.bookId, book.revision, item?.chapterId, open])
  return <div className="sn-reference-panel">
    {item ? <>
      <Button size="sm" className="sn-reference-back" onClick={() => setSelected('')}><IconChevronLeftOutline14 />{t('referenceList')}</Button>
      <div className="sn-reference-meta">{t(item.kind)}{item.linkedChapterId === chapterId && <span>{t('thisChapter')}</span>}</div>
      <h3 tabIndex={-1} ref={previewHeading}>{item.title}</h3><Button size="sm" aria-pressed={preferences.pinned.includes(item.chapterId)} disabled={!preferences.pinned.includes(item.chapterId) && preferences.pinned.length >= 20} onClick={() => remember({ ...preferences, pinned: preferences.pinned.includes(item.chapterId) ? preferences.pinned.filter(id => id !== item.chapterId) : [...preferences.pinned, item.chapterId] })}>{t('pinReference')}</Button>
      {view.kind === 'loading' && <p role="status">{t('loading')}</p>}
      {view.kind === 'error' && <p role="alert">{t(view.reason)}</p>}
      {view.kind === 'ready' && <><p className="sn-notice">{t('savedReferenceHint')}</p><pre className="sn-reference-text">{view.value.content || t('emptyReference')}</pre><Button size="sm" disabled={!writable} onClick={() => edit(item.chapterId)}>{t('editReference')}</Button><DocumentLinks book={view.value.book} item={item} references={view.references} t={t} navigate={navigate} /></>}
    </> : <>
      <div className="sn-modes" role="group" aria-label={t('referenceFilter')}>{['all', 'chapter', 'favorite', 'pinned', 'recent'].map(value => <Button size="sm" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t('reference-' + value)}</Button>)}</div>
      <div className="sn-search"><IconSearchOutline16 /><Input className="sn-input" type="search" aria-label={t('searchReferences')} placeholder={t('searchHint')} value={query} onChange={event => setQuery(event.target.value)} /></div>
      <Select aria-label={t('referenceType')} value={kind} onChange={event => setKind(event.target.value)}><option value="all">{t('allMaterialTypes')}</option>{materialKinds.map(value => <option key={value} value={value}>{t(value)}</option>)}</Select>
      <nav className="sn-reference-list" aria-label={t('referenceList')}>{filtered.slice(0, 100).map(item => <Button size="sm" key={item.chapterId} onClick={() => select(item.chapterId)}><span>{item.title}</span><small>{t(item.kind)}{item.linkedChapterId === chapterId ? ` · ${t('thisChapter')}` : ''}</small></Button>)}</nav>
      {!filtered.length && <p className="sn-notice">{t(materials.length ? 'noMatchingDocuments' : 'noMaterials')}</p>}
      {query.trim() && (!searchResult || !searchResult.complete || searchResult.total > 100) && <p role="status">{t(searchResult ? 'referenceLimit' : 'loading')}</p>}
      {filtered.length > 100 && <p className="sn-notice">{t('referenceLimit')}</p>}
      <Button size="sm" onClick={manage}>{t('manageMaterials')}</Button>
    </>}
  </div>
}
