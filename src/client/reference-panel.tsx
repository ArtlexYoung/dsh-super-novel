import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Input, IconChevronLeftOutline14, IconSearchOutline16 } from './primitives.js'
import { Select } from './controls.js'
import { materialKinds } from './materials.js'
import { unwrap } from './books.js'

/** Reading a reference never changes the active chapter, selection, or writing baseline. */
export function ReferencePanel({ api, sessionId, book, chapterId, open, writable, t, edit, manage }) {
  const [query, setQuery] = useState(''), [kind, setKind] = useState('all'), [selected, setSelected] = useState('')
  const [view, setView] = useState({ kind: 'idle' })
  const previewHeading = useRef(null)
  const materials = useMemo(() => book.chapters.filter(item => materialKinds.includes(item.kind) && !['archived', 'trashed'].includes(item.status)).sort((a, b) =>
    Number(b.linkedChapterId === chapterId || b.linkedChapterIds?.includes(chapterId)) - Number(a.linkedChapterId === chapterId || a.linkedChapterIds?.includes(chapterId))), [book, chapterId])
  const filtered = materials.filter(item => (kind === 'all' || item.kind === kind) && item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const item = materials.find(item => item.chapterId === selected)
  useEffect(() => {
    if (!open || !item) return
    previewHeading.current?.focus({ preventScroll: true })
    const controller = new AbortController()
    setView({ kind: 'loading' })
    api.chapter(sessionId, book.bookId, item.chapterId, controller.signal).then(unwrap).then(value => {
      if (!controller.signal.aborted) setView({ kind: 'ready', value })
    }).catch(error => { if (!controller.signal.aborted) setView({ kind: 'error', reason: error.reason ?? 'storage-failed' }) })
    return () => controller.abort()
  }, [api, sessionId, book.bookId, book.revision, item?.chapterId, open])
  return <div className="sn-reference-panel">
    {item ? <>
      <Button size="sm" className="sn-reference-back" onClick={() => setSelected('')}><IconChevronLeftOutline14 />{t('referenceList')}</Button>
      <div className="sn-reference-meta">{t(item.kind)}{item.linkedChapterId === chapterId && <span>{t('thisChapter')}</span>}</div>
      <h3 tabIndex={-1} ref={previewHeading}>{item.title}</h3>
      {view.kind === 'loading' && <p role="status">{t('loading')}</p>}
      {view.kind === 'error' && <p role="alert">{t(view.reason)}</p>}
      {view.kind === 'ready' && <><p className="sn-notice">{t('savedReferenceHint')}</p><pre className="sn-reference-text">{view.value.content || t('emptyReference')}</pre><Button size="sm" disabled={!writable} onClick={() => edit(item.chapterId)}>{t('editReference')}</Button></>}
    </> : <>
      <div className="sn-search"><IconSearchOutline16 /><Input className="sn-input" type="search" aria-label={t('searchReferences')} placeholder={t('searchHint')} value={query} onChange={event => setQuery(event.target.value)} /></div>
      <Select aria-label={t('referenceType')} value={kind} onChange={event => setKind(event.target.value)}><option value="all">{t('allMaterialTypes')}</option>{materialKinds.map(value => <option key={value} value={value}>{t(value)}</option>)}</Select>
      <nav className="sn-reference-list" aria-label={t('referenceList')}>{filtered.slice(0, 100).map(item => <Button size="sm" key={item.chapterId} onClick={() => { setView({ kind: 'loading' }); setSelected(item.chapterId) }}><span>{item.title}</span><small>{t(item.kind)}{item.linkedChapterId === chapterId ? ` · ${t('thisChapter')}` : ''}</small></Button>)}</nav>
      {!filtered.length && <p className="sn-notice">{t(materials.length ? 'noMatchingDocuments' : 'noMaterials')}</p>}
      {filtered.length > 100 && <p className="sn-notice">{t('referenceLimit')}</p>}
      <Button size="sm" onClick={manage}>{t('manageMaterials')}</Button>
    </>}
  </div>
}
