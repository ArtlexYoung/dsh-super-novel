import React, { useEffect, useRef, useState } from 'react'
import { Button, Input } from './primitives.js'
import { Select } from './controls.js'
import { materialKinds } from './materials.js'
import { DocumentLinks } from './document-links.js'
import { materialForm } from './form-cache.js'
import { useFormDraft, FormDraftStatus, FormRecovery } from './form-drafts.js'
import { unwrap } from './books.js'

export function MaterialDetail({ api, sessionId, workspaceId, book, item, branchId, writable, t, changed, edit, navigate, beforeGenerate, candidate, backToInbox, close }) {
  const [detail, setDetail] = useState(null), [references, setReferences] = useState(null), [linkQuery, setLinkQuery] = useState('')
  const [generation, setGeneration] = useState(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const operation = useRef({ key: '', id: '' }), pending = useRef(false), live = useRef(true)
  const current = materialForm(item), token = JSON.stringify(current)
  const draft = useFormDraft({ api, sessionId, workspaceId, book, chapterId: item.chapterId, branchId, kind: 'material', baseHash: item.hash, initial: { schemaVersion: 1, kind: 'material', base: current, form: current } })
  const form = draft.value.form, unsaved = JSON.stringify(form) !== JSON.stringify(draft.value.base), conflict = token !== JSON.stringify(draft.value.base)
  useEffect(() => { if (!unsaved && conflict) draft.update({ ...draft.value, base: current, form: current }, false) }, [token, unsaved])
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    Promise.all([api.chapter(sessionId, book.bookId, item.chapterId, controller.signal).then(unwrap), api.materialReferences(sessionId, book.bookId, item.chapterId, controller.signal).then(unwrap)])
      .then(([value, refs]) => { if (!controller.signal.aborted) { setDetail(value); setReferences(refs) } }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [api, sessionId, book.bookId, book.revision, item.chapterId])
  const run = async fn => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(''); setNotice('')
    try { await fn(new AbortController().signal) } catch (error) { if (live.current) setError(error.reason ?? 'storage-failed') }
    finally { pending.current = false; if (live.current) setBusy(false) }
  }
  const id = request => { const key = JSON.stringify(request); if (operation.current.key !== key) operation.current = { key, id: crypto.randomUUID() }; return operation.current.id }
  const update = next => draft.update({ ...draft.value, form: next })
  const save = next => run(async signal => {
    if (conflict) throw { reason: 'formMetadataConflict' }
    if (next.status !== (item.status ?? 'active') && ['archived', 'trashed'].includes(next.status) && !window.confirm(`${t('materialMoveConfirm')}\n${references?.uses.length ?? 0} ${t('generationUses')} · ${references?.draftBranches ?? 0} ${t('draftBranches')} · ${references?.incoming.length ?? 0} ${t('backlinks')}`)) return
    update(next); await draft.flush()
    const split = value => [...new Set(value.split(/[,，]/u).map(value => value.trim()).filter(Boolean))]
    const request = { workspaceId, bookId: book.bookId, chapterId: item.chapterId, expectedRevision: book.revision, ...next, tags: split(next.tags), aliases: split(next.aliases) }
    const value = unwrap(await api.updateMaterial(sessionId, { ...request, operationId: id(request) }, signal))
    changed(value); setNotice('materialDetailsSaved')
    const saved = materialForm(value.chapters.find(record => record.chapterId === item.chapterId))
    draft.update({ ...draft.value, base: saved, form: saved }, false)
    try { await draft.retire() } catch { setError('formCleanupFailed') }
  })
  const chapters = book.chapters.filter(item => !item.kind || item.kind === 'chapter')
  const preview = value => <div><p>{t('tags')}: {value.tags || t('none')}</p><p>{t('aliases')}: {value.aliases || t('none')}</p><p>{t('status-' + value.status)}{value.favorite ? ` · ${t('favorite')}` : ''}</p><p>{t('linkedChapters')}: {value.linkedChapterIds.map(id => book.chapters.find(item => item.chapterId === id)?.title ?? t('missingLinkedChapter')).join(' / ') || t('none')}</p><p>{t('relatedMaterials')}: {value.relatedMaterialIds.map(id => book.chapters.find(item => item.chapterId === id)?.title ?? t('missingLinkedChapter')).join(' / ') || t('none')}</p></div>
  return <div className="sn-material-detail">
    {backToInbox && <Button size="sm" disabled={busy} onClick={backToInbox}>{t('inboxBack')}</Button>}
    {error && <p role="alert">{t(error)}{error === 'formCleanupFailed' && <Button size="sm" disabled={busy} onClick={() => run(async () => { try { await draft.retryRetire() } catch { setError('formCleanupFailed') } })}>{t('retryDraft')}</Button>}</p>}{notice && <p role="status">{t(notice)}</p>}
    <Button size="sm" disabled={busy} onClick={() => run(async () => { await draft.flush(); close() })}>{t('referenceList')}</Button><h3>{item.title}</h3>
    {detail ? <pre className="sn-reference-text">{detail.content || t('emptyReference')}</pre> : <p role="status">{t('loading')}</p>}
    <p className="sn-notice">{t('materialVersion')}: {item.revision} · {t('status-' + (item.status ?? 'active'))}</p>
    <div className="sn-row sn-recovery-actions"><Button size="sm" disabled={!writable || busy || ['archived', 'trashed'].includes(item.status)} onClick={() => run(async () => { await draft.flush(); await edit(item.chapterId) })}>{t('editReference')}</Button>
      {detail && <Button size="sm" disabled={!writable || busy || unsaved || ['archived', 'trashed'].includes(item.status) || detail.externallyModified} onClick={() => run(async signal => {
        await draft.flush(); await beforeGenerate()
        const request = { workspaceId, bookId: book.bookId, chapterId: item.chapterId, expectedRevision: book.revision, expectedHash: detail.hash, mode: 'draft', start: 0, end: detail.content.length, instruction: t('organizeMaterialInstruction'), materials: '', ...([...current.linkedChapterIds, ...current.relatedMaterialIds].length ? { materialIds: [...new Set([...current.linkedChapterIds, ...current.relatedMaterialIds])].filter(id => !['archived', 'trashed'].includes(book.chapters.find(item => item.chapterId === id)?.status)) } : {}) }
        const input = { ...request, proposalId: id(request) }, context = unwrap(await api.generationContext(sessionId, input, signal))
        if (live.current) setGeneration({ request: input, context, token })
      })}>{t('aiOrganizeCandidate')}</Button>}
    </div>
    {generation && <section className="sn-material-ai-preview"><h3>{t('materialAIPreview')}</h3><p className="sn-notice">{t('materialAIPreviewHint')}</p>
      {generation.request.expectedRevision !== book.revision || generation.token !== token ? <p role="alert">{t('materialAIStale')}</p> : null}
      <p>{generation.context.bytes} / {generation.context.maxBytes} {t('contextBytes')}</p>
      <details><summary>{t('contextSources')}</summary>{generation.context.sections.map((section, index) => <article key={index}><strong>{section.title}</strong><pre className="sn-inbox-excerpt">{section.content}</pre></article>)}</details>
      <div className="sn-row sn-recovery-actions"><Button size="sm" variant="primary" disabled={!writable || busy || unsaved || generation.context.state !== 'ready' || generation.request.expectedRevision !== book.revision || generation.token !== token} onClick={() => run(async signal => {
        await draft.flush(); await beforeGenerate()
        const value = unwrap(await api.generateChapter(sessionId, generation.request, signal))
        if (live.current) { setGeneration(null); candidate(item.chapterId, value.proposalId) }
      })}>{t('materialAIConfirm')}</Button><Button size="sm" disabled={busy} onClick={() => setGeneration(null)}>{t('cancel')}</Button></div>
    </section>}
    {book.schemaVersion === 2 && <details className="sn-material-organize"><summary>{t('organizeMaterial')}{unsaved ? ` · ${t('unconfirmedForm')}` : ''}</summary>
      <FormDraftStatus draft={draft} t={t} />
      {conflict && unsaved && <div role="alert"><p>{t('formMetadataConflict')}</p><details><summary>{t('currentMaterialDetails')}</summary>{preview(current)}</details><Button size="sm" disabled={busy || !writable} onClick={() => draft.update({ ...draft.value, base: current })}>{t('rebaseFormInput')}</Button></div>}
      <fieldset className="sn-material-form" disabled={busy || !writable} onCompositionStart={() => draft.composing(true)} onCompositionEnd={() => draft.composing(false)}>
        <label className="sn-field">{t('tags')}<Input className="sn-input" value={form.tags} maxLength={4096} aria-label={t('tags')} onChange={event => update({ ...form, tags: event.target.value })} /></label>
        <label className="sn-field">{t('aliases')}<Input className="sn-input" value={form.aliases} maxLength={8000} aria-label={t('aliases')} onChange={event => update({ ...form, aliases: event.target.value })} /></label>
        <div className="sn-row"><Button size="sm" aria-pressed={form.favorite} onClick={() => update({ ...form, favorite: !form.favorite })}>{t('favorite')}</Button><Select aria-label={t('materialStatus')} value={form.status} onChange={event => update({ ...form, status: event.target.value })}>{['active', 'inbox', 'archived', 'trashed'].map(value => <option key={value} value={value}>{t('status-' + value)}</option>)}</Select></div>
        <details><summary>{t('linkedChapters')}</summary><Input className="sn-input" aria-label={t('searchLinks')} value={linkQuery} onChange={event => setLinkQuery(event.target.value)} /><div className="sn-material-list">{chapters.filter(item => item.title.includes(linkQuery)).slice(0, 100).map(chapter => <Button key={chapter.chapterId} size="sm" aria-pressed={form.linkedChapterIds.includes(chapter.chapterId)} onClick={() => update({ ...form, linkedChapterIds: form.linkedChapterIds.includes(chapter.chapterId) ? form.linkedChapterIds.filter(id => id !== chapter.chapterId) : [...form.linkedChapterIds, chapter.chapterId] })}>{chapter.title}</Button>)}</div></details>
        <details><summary>{t('relatedMaterials')}</summary><div className="sn-material-list">{book.chapters.filter(source => materialKinds.includes(source.kind) && source.chapterId !== item.chapterId && source.title.includes(linkQuery)).slice(0, 100).map(source => <Button key={source.chapterId} size="sm" aria-pressed={form.relatedMaterialIds.includes(source.chapterId)} onClick={() => update({ ...form, relatedMaterialIds: form.relatedMaterialIds.includes(source.chapterId) ? form.relatedMaterialIds.filter(id => id !== source.chapterId) : [...form.relatedMaterialIds, source.chapterId] })}>{source.title}</Button>)}</div></details>
        <div className="sn-row sn-recovery-actions"><Button size="sm" variant="primary" disabled={!writable || busy || conflict || !unsaved} onClick={() => save(form)}>{t('saveMaterialDetails')}</Button>{['archived', 'trashed'].includes(item.status) && <Button size="sm" disabled={!writable || busy || conflict} onClick={() => save({ ...form, status: 'active' })}>{t('restoreMaterial')}</Button>}</div>
      </fieldset>
      <FormRecovery draft={draft} api={api} sessionId={sessionId} t={t} preview={preview} disabled={busy || !writable} />
    </details>}
    {references && <DocumentLinks book={book} item={item} references={references} t={t} navigate={navigate} />}
  </div>
}
