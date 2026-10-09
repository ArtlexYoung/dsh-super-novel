import React, { useEffect, useRef, useState } from 'react'
import { Button, Input } from './primitives.js'
import { Select } from './controls.js'
import { materialKinds } from './materials.js'
import { unwrap } from './books.js'

const links = item => [...new Set([...(item.linkedChapterIds ?? []), ...(item.linkedChapterId ? [item.linkedChapterId] : [])])]
export function MaterialLibrary({ api, sessionId, workspaceId, book, writable, t, changed, edit, beforeGenerate, candidate }) {
  const [query, setQuery] = useState(''), [kind, setKind] = useState('all'), [status, setStatus] = useState('available'), [favorite, setFavorite] = useState(false), [tag, setTag] = useState(''), [linked, setLinked] = useState(''), [offset, setOffset] = useState(0), [linkQuery, setLinkQuery] = useState('')
  const [result, setResult] = useState(null), [selected, setSelected] = useState(''), [detail, setDetail] = useState(null), [references, setReferences] = useState(null)
  const [form, setForm] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const operation = useRef({ key: '', id: '' }), upgrade = useRef({ operationId: crypto.randomUUID(), backupId: crypto.randomUUID() })
  const item = book.chapters.find(item => item.chapterId === selected)
  const chapters = book.chapters.filter(item => !item.kind || item.kind === 'chapter')
  useEffect(() => setOffset(0), [query, kind, status, favorite, tag, linked])
  useEffect(() => {
    const controller = new AbortController()
    setResult(null)
    const timer = setTimeout(() => api.searchMaterials(sessionId, { bookId: book.bookId, query, kind, status, favorite, tag, linkedChapterId: linked, offset }, controller.signal).then(unwrap)
      .then(value => { if (!controller.signal.aborted) setResult(value) }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') }), 150)
    return () => { clearTimeout(timer); controller.abort() }
  }, [api, sessionId, book.bookId, book.revision, query, kind, status, favorite, tag, linked, offset])
  useEffect(() => {
    if (!item) { setDetail(null); setForm(null); return }
    const controller = new AbortController()
    setDetail(null); setReferences(null)
    setForm({ tags: (item.tags ?? []).join(', '), aliases: (item.aliases ?? []).join(', '), favorite: !!item.favorite, status: item.status ?? 'active', linkedChapterIds: links(item), relatedMaterialIds: item.relatedMaterialIds ?? [] })
    Promise.all([api.chapter(sessionId, book.bookId, item.chapterId, controller.signal).then(unwrap), api.materialReferences(sessionId, book.bookId, item.chapterId, controller.signal).then(unwrap)])
      .then(([value, references]) => { if (!controller.signal.aborted) { setDetail(value); setReferences(references) } }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [api, sessionId, book.bookId, book.revision, item?.chapterId])
  const run = async fn => { if (busy) return; setBusy(true); setError(''); try { await fn(new AbortController().signal) } catch (error) { setError(error.reason ?? 'storage-failed') } finally { setBusy(false) } }
  const save = next => run(async signal => {
    if (next.status !== (item.status ?? 'active') && ['archived', 'trashed'].includes(next.status) && !window.confirm(`${t('materialMoveConfirm')}\n${references?.uses.length ?? 0} ${t('generationUses')} · ${references?.draftBranches ?? 0} ${t('draftBranches')} · ${references?.incoming.length ?? 0} ${t('backlinks')}`)) return
    const split = value => [...new Set(value.split(/[,，]/u).map(value => value.trim()).filter(Boolean))]
    const request = { workspaceId, bookId: book.bookId, chapterId: item.chapterId, expectedRevision: book.revision, ...next, tags: split(next.tags), aliases: split(next.aliases) }
    const key = JSON.stringify(request)
    if (operation.current.key !== key) operation.current = { key, id: crypto.randomUUID() }
    changed(unwrap(await api.updateMaterial(sessionId, { ...request, operationId: operation.current.id }, signal)))
  })
  return <div className="sn-material-library">
    {error && <p role="alert">{t(error)}</p>}
    {book.schemaVersion === 1 && <section className="sn-recovery"><p>{t('upgradeMaterialsHint')}</p><Button size="sm" disabled={!writable || busy} onClick={() => run(async signal => changed(unwrap(await api.upgradeBook(sessionId, { workspaceId, bookId: book.bookId, expectedRevision: book.revision, ...upgrade.current }, signal))))}>{t('enableMaterialLibrary')}</Button></section>}
    {item && form ? <>
      <Button size="sm" onClick={() => setSelected('')}>{t('referenceList')}</Button><h3>{item.title}</h3>
      {detail ? <pre className="sn-reference-text">{detail.content || t('emptyReference')}</pre> : <p role="status">{t('loading')}</p>}
      <p className="sn-notice">{t('materialVersion')}: {item.revision} · {t('status-' + (item.status ?? 'active'))}</p>
      {item.sourceEvidence && <p className="sn-notice">{t('selectionSource')}: {book.chapters.find(source => source.chapterId === item.sourceEvidence.chapterId)?.title} · v{item.sourceEvidence.revision}{book.chapters.find(source => source.chapterId === item.sourceEvidence.chapterId)?.hash !== item.sourceEvidence.hash ? ` · ${t('sourceChanged')}` : ''}</p>}
      <Button size="sm" disabled={!writable || busy || ['archived', 'trashed'].includes(item.status)} onClick={() => edit(item.chapterId)}>{t('editReference')}</Button>
      {detail && <Button size="sm" disabled={!writable || busy || ['archived', 'trashed'].includes(item.status) || detail.externallyModified} onClick={() => run(async signal => {
        await beforeGenerate()
        const request = { bookId: book.bookId, chapterId: item.chapterId, expectedRevision: book.revision, expectedHash: detail.hash, mode: 'draft', start: 0, end: detail.content.length, instruction: t('organizeMaterialInstruction'), materials: '', ...(item.relatedMaterialIds?.length ? { materialIds: item.relatedMaterialIds.filter(id => !['archived', 'trashed'].includes(book.chapters.find(item => item.chapterId === id)?.status)) } : {}) }
        const key = JSON.stringify(request)
        if (operation.current.key !== key) operation.current = { key, id: crypto.randomUUID() }
        const value = unwrap(await api.generateChapter(sessionId, { ...request, proposalId: operation.current.id }, signal))
        candidate(item.chapterId, value.proposalId)
      })}>{t('aiOrganizeCandidate')}</Button>}
      {book.schemaVersion === 2 && <details><summary>{t('organizeMaterial')}</summary>
        <label className="sn-field">{t('tags')}<Input className="sn-input" value={form.tags} aria-label={t('tags')} onChange={event => setForm({ ...form, tags: event.target.value })} /></label>
        <label className="sn-field">{t('aliases')}<Input className="sn-input" value={form.aliases} aria-label={t('aliases')} onChange={event => setForm({ ...form, aliases: event.target.value })} /></label>
        <Button size="sm" aria-pressed={form.favorite} onClick={() => setForm({ ...form, favorite: !form.favorite })}>{t('favorite')}</Button>
        <Select aria-label={t('materialStatus')} value={form.status} onChange={event => setForm({ ...form, status: event.target.value })}>{['active', 'inbox', 'archived', 'trashed'].map(value => <option key={value} value={value}>{t('status-' + value)}</option>)}</Select>
        <details><summary>{t('linkedChapters')}</summary><Input className="sn-input" aria-label={t('searchLinks')} value={linkQuery} onChange={event => setLinkQuery(event.target.value)} />{chapters.filter(item => item.title.includes(linkQuery)).slice(0, 100).map(chapter => <Button key={chapter.chapterId} size="sm" aria-pressed={form.linkedChapterIds.includes(chapter.chapterId)} onClick={() => setForm({ ...form, linkedChapterIds: form.linkedChapterIds.includes(chapter.chapterId) ? form.linkedChapterIds.filter(id => id !== chapter.chapterId) : [...form.linkedChapterIds, chapter.chapterId] })}>{chapter.title}</Button>)}</details>
        <details><summary>{t('relatedMaterials')}</summary>{book.chapters.filter(source => materialKinds.includes(source.kind) && source.chapterId !== item.chapterId && source.title.includes(linkQuery)).slice(0, 100).map(source => <Button key={source.chapterId} size="sm" aria-pressed={form.relatedMaterialIds.includes(source.chapterId)} onClick={() => setForm({ ...form, relatedMaterialIds: form.relatedMaterialIds.includes(source.chapterId) ? form.relatedMaterialIds.filter(id => id !== source.chapterId) : [...form.relatedMaterialIds, source.chapterId] })}>{source.title}</Button>)}</details>
        <Button size="sm" variant="primary" disabled={!writable || busy} onClick={() => save(form)}>{t('saveMaterialDetails')}</Button>
        {['archived', 'trashed'].includes(item.status) && <Button size="sm" disabled={!writable || busy} onClick={() => save({ ...form, status: 'active' })}>{t('restoreMaterial')}</Button>}
      </details>}
      {references && <details><summary>{t('sourcesAndUses')}</summary><p>{t('linkedChapters')}: {references.linkedChapterIds.map(id => book.chapters.find(item => item.chapterId === id)?.title).join('、') || t('none')}</p><p>{t('backlinks')}: {references.incoming.map(id => book.chapters.find(item => item.chapterId === id)?.title).join('、') || t('none')}</p><p>{t('evidenceSources')}: {references.evidenceChapterIds.map(id => book.chapters.find(item => item.chapterId === id)?.title).join('、') || t('none')}</p><ul>{references.uses.map(use => <li key={use.proposalId}>{book.chapters.find(item => item.chapterId === use.chapterId)?.title} · v{use.revision} · {use.state}{use.stale ? ` · ${t('sourceChanged')}` : ''}</li>)}</ul>{!references.complete && <p role="status">{t('searchIncomplete')}</p>}</details>}
    </> : <>
      <Input className="sn-input" type="search" aria-label={t('fulltextMaterials')} placeholder={t('fulltextMaterials')} value={query} onChange={event => setQuery(event.target.value)} />
      <div className="sn-row"><Select aria-label={t('referenceType')} value={kind} onChange={event => setKind(event.target.value)}><option value="all">{t('allMaterialTypes')}</option>{materialKinds.map(value => <option key={value} value={value}>{t(value)}</option>)}</Select><Button size="sm" aria-pressed={favorite} onClick={() => setFavorite(value => !value)}>{t('favorite')}</Button></div>
      <details><summary>{t('filterMaterials')}</summary><Select aria-label={t('materialStatus')} value={status} onChange={event => setStatus(event.target.value)}>{['available', 'inbox', 'archived', 'trashed', 'all'].map(value => <option key={value} value={value}>{t('status-' + value)}</option>)}</Select><Input className="sn-input" aria-label={t('filterTag')} value={tag} placeholder={t('filterTag')} onChange={event => setTag(event.target.value)} /><Select aria-label={t('filterLinkedChapter')} value={linked} onChange={event => setLinked(event.target.value)}><option value="">{t('allRelatedChapters')}</option>{chapters.map(item => <option key={item.chapterId} value={item.chapterId}>{item.title}</option>)}</Select></details>
      {!result ? <p role="status">{t('loading')}</p> : <><p role="status">{result.total} {t('materialsShort')}{!result.complete || result.externalIds.length ? ` · ${t('searchIncomplete')}` : ''}</p><nav className="sn-reference-list" aria-label={t('materialLibrary')}>{result.items.map(item => <Button key={item.chapterId} size="sm" onClick={() => setSelected(item.chapterId)}><span>{item.favorite ? '★ ' : ''}{item.title}</span><small>{t(item.kind)} · {t('status-' + (item.status ?? 'active'))}{item.tags?.length ? ` · ${item.tags.join(' / ')}` : ''}</small></Button>)}</nav><div className="sn-pagination"><Button size="sm" disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 100))}>{t('previousPage')}</Button><Button size="sm" disabled={offset + 100 >= result.total} onClick={() => setOffset(value => value + 100)}>{t('nextPage')}</Button></div></>}
    </>}
  </div>
}
