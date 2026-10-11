import React, { useEffect, useRef, useState } from 'react'
import { Button, Input } from './primitives.js'
import { Select } from './controls.js'
import { materialKinds } from './materials.js'
import { MaterialDetail } from './material-detail.js'
import { MaterialBatch } from './material-batch.js'
import { MaterialViews, defaultMaterialFilters } from './material-views.js'
import { unwrap } from './books.js'

export function MaterialLibrary({ api, sessionId, workspaceId, book, branchId, chapterId, writable, t, changed, edit, navigate, beforeGenerate, candidate }) {
  const [filters, setFilters] = useState(defaultMaterialFilters), [offset, setOffset] = useState(0)
  const [result, setResult] = useState(null), [selected, setSelected] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [batch, setBatch] = useState(false), [batchLocked, setBatchLocked] = useState(false), [selectedIds, setSelectedIds] = useState([]), [viewName, setViewName] = useState(''), [viewId, setViewId] = useState('')
  const viewsStore = useRef(null)
  if (!viewsStore.current) viewsStore.current = new MaterialViews(`${workspaceId}:${book.bookId}`, () => localStorage)
  const [views, setViews] = useState(() => viewsStore.current.read()), [viewError, setViewError] = useState('')
  const upgrade = useRef({ operationId: crypto.randomUUID(), backupId: crypto.randomUUID() }), pending = useRef(false)
  const item = book.chapters.find(item => item.chapterId === selected), chapters = book.chapters.filter(item => !item.kind || item.kind === 'chapter')
  const update = (key, value) => { setFilters(previous => ({ ...previous, [key]: value })); setViewId('') }
  useEffect(() => setOffset(0), [filters])
  useEffect(() => {
    const controller = new AbortController(); setResult(null); setError('')
    const timer = setTimeout(() => api.searchMaterials(sessionId, { bookId: book.bookId, ...filters, offset }, controller.signal).then(unwrap)
      .then(value => { if (!controller.signal.aborted) setResult(value) }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') }), 150)
    return () => { clearTimeout(timer); controller.abort() }
  }, [api, sessionId, book.bookId, book.revision, filters, offset])
  const run = async fn => { if (pending.current) return; pending.current = true; setBusy(true); setError(''); try { await fn(new AbortController().signal) } catch (error) { setError(error.reason ?? 'storage-failed') } finally { pending.current = false; setBusy(false) } }
  const refresh = async () => { const library = unwrap(await api.library(sessionId, new AbortController().signal)), current = library.books.find(value => value.bookId === book.bookId); if (!current) throw { reason: 'book-not-found' }; changed(current) }
  const saveViews = next => { if (viewsStore.current.write(next).saved) { setViews(next); setViewError(''); return true }; setViewError('savedViewFailed'); return false }
  const preset = value => { setViewId(''); setFilters({ ...defaultMaterialFilters(), ...(value === 'characters' ? { kind: 'character', linkedChapterId: chapterId } : value === 'inbox' ? { status: 'inbox' } : { attention: value }) }) }
  const toggle = id => setSelectedIds(previous => previous.includes(id) ? previous.filter(value => value !== id) : previous.length < 100 ? [...previous, id] : previous)
  return <div className="sn-material-library">
    {error && <p role="alert">{t(error)} <Button size="sm" disabled={busy} onClick={() => run(refresh)}>{t('refresh')}</Button></p>}
    {book.schemaVersion === 1 && <section className="sn-recovery"><p>{t('upgradeMaterialsHint')}</p><Button size="sm" disabled={!writable || busy} onClick={() => run(async signal => changed(unwrap(await api.upgradeBook(sessionId, { workspaceId, bookId: book.bookId, expectedRevision: book.revision, ...upgrade.current }, signal))))}>{t('enableMaterialLibrary')}</Button></section>}
    {item ? <MaterialDetail key={item.chapterId} {...{ api, sessionId, workspaceId, book, item, branchId, writable, t, changed, edit, navigate, beforeGenerate, candidate }} close={() => setSelected('')} /> : <>
      <div hidden={batchLocked}>
      <Input className="sn-input" type="search" aria-label={t('fulltextMaterials')} placeholder={t('fulltextMaterials')} value={filters.query} maxLength={500} onChange={event => update('query', event.target.value)} />
      <div className="sn-row"><Select aria-label={t('referenceType')} value={filters.kind} onChange={event => update('kind', event.target.value)}><option value="all">{t('allMaterialTypes')}</option>{materialKinds.map(value => <option key={value} value={value}>{t(value)}</option>)}</Select><Button size="sm" aria-pressed={filters.favorite} onClick={() => update('favorite', !filters.favorite)}>{t('favorite')}</Button></div>
      <details className="sn-material-filters"><summary>{t('filterMaterials')}</summary><Select aria-label={t('materialStatus')} value={filters.status} onChange={event => update('status', event.target.value)}>{['available', 'inbox', 'archived', 'trashed', 'all'].map(value => <option key={value} value={value}>{t('status-' + value)}</option>)}</Select><Input className="sn-input" aria-label={t('filterTag')} maxLength={80} value={filters.tag} placeholder={t('filterTag')} onChange={event => update('tag', event.target.value)} /><Select aria-label={t('filterLinkedChapter')} value={filters.linkedChapterId} onChange={event => update('linkedChapterId', event.target.value)}><option value="">{t('allRelatedChapters')}</option>{chapters.map(item => <option key={item.chapterId} value={item.chapterId}>{item.title}</option>)}</Select></details>
      <details className="sn-saved-views"><summary>{t('savedMaterialViews')}</summary>{viewError && <p role="alert">{t(viewError)}</p>}
        <Select aria-label={t('savedMaterialViews')} value={viewId} onChange={event => { const value = views.find(value => value.id === event.target.value); setViewId(event.target.value); if (value) setFilters(value.filters) }}><option value="">{t('chooseSavedView')}</option>{views.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</Select>
        <div className="sn-row"><Input className="sn-input" aria-label={t('savedViewName')} value={viewName} maxLength={60} placeholder={t('savedViewName')} onChange={event => setViewName(event.target.value)} /><Button size="sm" disabled={!viewName.trim() || views.length >= 20 && !views.some(value => value.name === viewName.trim())} onClick={() => { const value = { id: views.find(value => value.name === viewName.trim())?.id ?? crypto.randomUUID(), name: viewName.trim(), filters: { ...filters } }; if (saveViews([...views.filter(prior => prior.id !== value.id), value])) setViewName('') }}>{t('saveView')}</Button></div>
        <Button size="sm" disabled={!viewId} onClick={() => { if (saveViews(views.filter(value => value.id !== viewId))) setViewId('') }}>{t('removeView')}</Button>
      </details>
      <details className="sn-maintenance"><summary>{t('materialsToOrganize')}</summary><p className="sn-notice">{t('materialsToOrganizeHint')}</p><div className="sn-row sn-recovery-actions">{['characters', 'inbox', 'untagged', 'unlinked', 'stale'].map(value => <Button key={value} size="sm" disabled={value === 'characters' && !chapterId} onClick={() => preset(value)}>{t('maintenance-' + value)}</Button>)}</div></details>
      <div className="sn-row"><Select aria-label={t('materialAttention')} value={filters.attention} onChange={event => update('attention', event.target.value)}>{['all', 'untagged', 'unlinked', 'stale'].map(value => <option key={value} value={value}>{t('attention-' + value)}</option>)}</Select>{book.schemaVersion === 2 && <Button size="sm" aria-pressed={batch} disabled={busy || batchLocked} onClick={() => setBatch(value => !value)}>{t('batchOrganize')}</Button>}</div>
      </div>
      {batch && <MaterialBatch {...{ api, sessionId, workspaceId, book, selectedIds, writable, t, changed, refresh }} lock={setBatchLocked} clear={() => setSelectedIds([])} />}
      <div hidden={batchLocked}>{!result ? <p role="status">{t('loading')}</p> : <><p role="status">{result.total} {t('materialsShort')}{!result.complete || result.externalIds.length ? ` · ${t('searchIncomplete')}` : ''}</p><nav className="sn-reference-list" aria-label={t('materialLibrary')}>{result.items.map(item => <div className="sn-material-list-row" key={item.chapterId}>{batch && <input type="checkbox" aria-label={`${t('selectMaterial')} ${item.title}`} checked={selectedIds.includes(item.chapterId)} disabled={batchLocked || !selectedIds.includes(item.chapterId) && selectedIds.length >= 100} onChange={() => toggle(item.chapterId)} />}<Button size="sm" disabled={batchLocked} onClick={() => setSelected(item.chapterId)}><span>{item.favorite ? '★ ' : ''}{item.title}</span><small>{t(item.kind)} · {t('status-' + (item.status ?? 'active'))}{item.tags?.length ? ` · ${item.tags.join(' / ')}` : ''}</small></Button></div>)}</nav><div className="sn-pagination"><Button size="sm" disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 100))}>{t('previousPage')}</Button><Button size="sm" disabled={offset + 100 >= result.total} onClick={() => setOffset(value => value + 100)}>{t('nextPage')}</Button></div></>}</div>
    </>}
  </div>
}
