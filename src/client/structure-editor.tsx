import React, { useEffect, useRef, useState } from 'react'
import { Button, Input, IconChevronUpOutline14, IconChevronDownOutline14 } from './primitives.js'
import { Select } from './controls.js'
import { useFormDraft, FormDraftStatus, FormRecovery } from './form-drafts.js'
import { outlinePlan, groupOutline, moveOutlineChapter, rebindOutline } from './outline-plan.js'
import { StructurePreview } from './structure-preview.js'
import { unwrap } from './books.js'

function Groups({ plan, change, disabled, t }) {
  const [volumeTitle, setVolumeTitle] = useState(''), [lineTitle, setLineTitle] = useState('')
  const move = (key, idKey, id, direction) => {
    const items = [...plan[key]], at = items.findIndex(item => item[idKey] === id), next = at + direction
    if (next < 0 || next >= items.length) return
    const item = items.splice(at, 1)[0]; items.splice(next, 0, item)
    change(groupOutline({ ...plan, [key]: items }))
  }
  return <details className="sn-outline-groups"><summary>{t('manageVolumesStorylines')}</summary>
    {['volumes', 'storylines'].map(key => {
      const idKey = key === 'volumes' ? 'volumeId' : 'storylineId', title = key === 'volumes' ? volumeTitle : lineTitle, setTitle = key === 'volumes' ? setVolumeTitle : setLineTitle
      return <section key={key}><h4>{t(key)}</h4>{plan[key].map((item, at) => <div className="sn-outline-group-row" key={item[idKey]}>
        <Input className="sn-input" aria-label={`${t(key === 'volumes' ? 'volumeTitle' : 'storylineTitle')} ${at + 1}`} value={item.title} maxLength={200} disabled={disabled} onChange={event => change({ ...plan, [key]: plan[key].map(group => group[idKey] === item[idKey] ? { ...group, title: event.target.value } : group) })} />
        {key === 'volumes' && <div className="sn-row"><Button size="sm" aria-label={`${t('moveUp')} ${item.title}`} disabled={disabled || !at} onClick={() => move(key, idKey, item[idKey], -1)}><IconChevronUpOutline14 /></Button><Button size="sm" aria-label={`${t('moveDown')} ${item.title}`} disabled={disabled || at === plan[key].length - 1} onClick={() => move(key, idKey, item[idKey], 1)}><IconChevronDownOutline14 /></Button></div>}
        <Button size="sm" disabled={disabled} aria-label={`${t('removeStructureGroup')} ${item.title}`} onClick={() => change(groupOutline({ ...plan, [key]: plan[key].filter(group => group[idKey] !== item[idKey]), chapters: plan.chapters.map(chapter => key === 'volumes' && chapter.volumeId === item.volumeId ? { ...chapter, volumeId: '' } : key === 'storylines' ? { ...chapter, storylineIds: chapter.storylineIds.filter(id => id !== item.storylineId) } : chapter) }))}>{t('removeStructureGroup')}</Button>
      </div>)}<form className="sn-row" onSubmit={event => { event.preventDefault(); change({ ...plan, [key]: [...plan[key], { [idKey]: crypto.randomUUID(), title: title.trim() }] }); setTitle('') }}><Input className="sn-input" aria-label={t(key === 'volumes' ? 'newVolumeTitle' : 'newStorylineTitle')} value={title} maxLength={200} disabled={disabled} onChange={event => setTitle(event.target.value)} /><Button size="sm" type="submit" disabled={disabled || !title.trim() || plan[key].length >= 1000}>{t(key === 'volumes' ? 'addVolume' : 'addStoryline')}</Button></form></section>
    })}
    <p className="sn-notice">{t('removeStructureGroupHint')}</p>
  </details>
}

export function StructureEditor({ api, sessionId, workspaceId, book, baseHash, branchId, selectedId, preferredAction, writable, t, changed, beforeChange, back }) {
  const draft = useFormDraft({ api, sessionId, workspaceId, book, chapterId: book.bookId, branchId, kind: 'structure', baseHash, initial: { schemaVersion: 1, kind: 'structure', base: book.revision, form: outlinePlan(book) } })
  const [selected, setSelected] = useState(selectedId), [preview, setPreview] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), [retireError, setRetireError] = useState(false)
  const pending = useRef(false), handled = useRef(''), operation = useRef({ key: '', id: '' })
  const plan = draft.value.form, chapter = plan.chapters.find(item => item.chapterId === selected) ?? plan.chapters[0], outdated = draft.value.base !== book.revision
  const update = next => { draft.update({ ...draft.value, form: next }); setPreview(null); setSaved(false) }
  const run = async fn => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { await fn(new AbortController().signal) } catch (error) { setError(error.reason ?? error.message ?? 'storage-failed') } finally { pending.current = false; setBusy(false) }
  }
  const inspect = form => run(async signal => {
    await draft.flush(); await beforeChange()
    const request = { workspaceId, bookId: book.bookId, expectedRevision: draft.value.base, structure: form }
    const key = JSON.stringify(request)
    if (key !== operation.current.key) operation.current = { key, id: crypto.randomUUID() }
    const input = { ...request, operationId: operation.current.id }, value = unwrap(await api.previewBookStructure(sessionId, input, signal))
    setPreview({ request: input, value })
  })
  useEffect(() => { if (selectedId) setSelected(selectedId) }, [selectedId])
  useEffect(() => {
    if (!preferredAction || preferredAction.id === handled.current) return
    handled.current = preferredAction.id; setSelected(preferredAction.chapterId)
    if (preferredAction.direction) { const next = moveOutlineChapter(draft.value.form, preferredAction.chapterId, preferredAction.direction); update(next) }
  }, [preferredAction?.id])
  const submit = () => run(async signal => {
    await draft.flush(); await beforeChange()
    const value = unwrap(await api.updateBookStructure(sessionId, { ...preview.request, previewHash: preview.value.previewHash }, signal))
    changed(value); setPreview(null); setSaved(true)
    draft.update({ schemaVersion: 1, kind: 'structure', base: value.revision, form: outlinePlan(value) }, false)
    try { await draft.retire(); setRetireError(false) } catch { setRetireError(true) }
  })
  const undo = () => run(async signal => {
    const value = unwrap(await api.undoBookStructure(sessionId, { workspaceId, bookId: book.bookId }, signal))
    if (!value.available) { setError('structureUndoUnavailable'); return }
    draft.update({ schemaVersion: 1, kind: 'structure', base: book.revision, form: value.structure }); setSaved(false); setPreview(null)
  })
  const peers = chapter ? plan.chapters.filter(item => item.volumeId === chapter.volumeId) : [], at = peers.findIndex(item => item.chapterId === chapter?.chapterId)
  const field = (key, value) => update({ ...plan, chapters: plan.chapters.map(item => item.chapterId === chapter.chapterId ? { ...item, [key]: value } : item) })
  return <div className="sn-structure-editor">
    {error && <p role="alert">{t(error)}</p>}
    {saved && <p role="status">{t('structureSaved')}</p>}
    {retireError && <p role="alert">{t('formCleanupFailed')} <Button size="sm" disabled={busy} onClick={() => run(async () => { await draft.retryRetire(); setRetireError(false) })}>{t('retryDraft')}</Button></p>}
    {preview ? <StructurePreview book={book} preview={preview} busy={busy} writable={writable} t={t} edit={() => setPreview(null)} confirm={submit} /> : <>
      <p className="sn-notice">{t('structureEditingHint')}</p><FormDraftStatus draft={draft} t={t} />
      {outdated && <div className="sn-alert" role="alert"><p>{t('structureSourceChanged')}</p><details><summary>{t('currentBookStructure')}</summary>{book.chapters.filter(item => !item.kind || item.kind === 'chapter').map((item, index) => <p key={item.chapterId}>{index + 1}. {item.title} · {book.volumes?.find(group => group.volumeId === item.structure.volumeId)?.title ?? t('unassignedVolume')} · {t('progress-' + item.structure.progress)}</p>)}</details><Button size="sm" disabled={busy || !writable} onClick={() => { draft.update({ schemaVersion: 1, kind: 'structure', base: book.revision, form: rebindOutline(plan, book) }); setSaved(false) }}>{t('rebindStructure')}</Button></div>}
      <div className="sn-row sn-structure-actions"><Button size="sm" disabled={busy} onClick={() => run(async () => { await draft.flush(); back() })}>{t('backToOutline')}</Button><Button variant="primary" size="sm" disabled={busy || !writable || outdated} onClick={() => inspect(plan)}>{t('previewStructure')}</Button></div>
      <fieldset className="sn-outline-fields" disabled={busy || !writable}>
        <Groups plan={plan} change={update} disabled={busy || !writable} t={t} />
        {chapter ? <section className="sn-outline-chapter-form">
          <label>{t('chapter')}<Select aria-label={t('arrangeChapter')} value={chapter.chapterId} onChange={event => setSelected(event.target.value)}>{plan.chapters.map((item, index) => <option key={item.chapterId} value={item.chapterId}>{index + 1}. {book.chapters.find(document => document.chapterId === item.chapterId)?.title ?? item.chapterId}</option>)}</Select></label>
          <div className="sn-row"><Button size="sm" disabled={busy || !writable || at <= 0} onClick={() => update(moveOutlineChapter(plan, chapter.chapterId, -1))}><IconChevronUpOutline14 />{t('moveUp')}</Button><Button size="sm" disabled={busy || !writable || at === peers.length - 1} onClick={() => update(moveOutlineChapter(plan, chapter.chapterId, 1))}><IconChevronDownOutline14 />{t('moveDown')}</Button></div>
          <div className="sn-outline-field-pair"><label>{t('volume')}<Select aria-label={t('chapterVolume')} value={chapter.volumeId} onChange={event => update(groupOutline({ ...plan, chapters: plan.chapters.map(item => item.chapterId === chapter.chapterId ? { ...item, volumeId: event.target.value } : item) }))}><option value="">{t('unassignedVolume')}</option>{plan.volumes.map(item => <option key={item.volumeId} value={item.volumeId}>{item.title}</option>)}</Select></label>
            <label>{t('chapterProgress')}<Select aria-label={t('chapterProgress')} value={chapter.progress} onChange={event => field('progress', event.target.value)}>{['unwritten', 'draft', 'revise', 'complete'].map(value => <option key={value} value={value}>{t('progress-' + value)}</option>)}</Select></label></div>
          <label>{t('chapterSummary')}<textarea className="sn-outline-summary" aria-label={t('chapterSummary')} maxLength={4000} value={chapter.summary} placeholder={t('chapterSummaryHint')} onCompositionStart={() => draft.composing(true)} onCompositionEnd={() => draft.composing(false)} onChange={event => field('summary', event.target.value)} /></label>
          {!!plan.storylines.length && <details className="sn-outline-line-selector"><summary>{t('chapterStorylines')} ({chapter.storylineIds.length})</summary>{plan.storylines.map(item => <label key={item.storylineId}><input type="checkbox" checked={chapter.storylineIds.includes(item.storylineId)} disabled={!chapter.storylineIds.includes(item.storylineId) && chapter.storylineIds.length >= 100} onChange={event => field('storylineIds', event.target.checked ? [...chapter.storylineIds, item.storylineId] : chapter.storylineIds.filter(id => id !== item.storylineId))} />{item.title || t('untitledStructureGroup')}</label>)}</details>}
          <p className="sn-notice">{t('structureIntentSceneHint')}</p>
        </section> : <p>{t('noChapters')}</p>}
      </fieldset>
      <FormRecovery draft={draft} api={api} sessionId={sessionId} t={t} disabled={busy || !writable} preview={form => <div>{form.volumes.map(item => <p key={item.volumeId}>{t('volume')}: {item.title}</p>)}{form.chapters.slice(0, 25).map(item => <p key={item.chapterId}>{book.chapters.find(document => document.chapterId === item.chapterId)?.title ?? item.chapterId} · {t('progress-' + item.progress)}<span className="sn-inbox-excerpt">{item.summary}</span></p>)}{form.chapters.length > 25 && <p>{t('structureDraftPreviewLimit')}</p>}</div>} />
      <Button size="sm" disabled={busy || !writable || !book.lastStructureOperationId} onClick={undo}>{t('undoStructurePreview')}</Button>
    </>}
  </div>
}
