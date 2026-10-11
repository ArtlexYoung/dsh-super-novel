import React, { useEffect, useRef, useState } from 'react'
import { Button, Input } from './primitives.js'
import { Select } from './controls.js'
import { unwrap } from './books.js'

export function MaterialBatch({ api, sessionId, workspaceId, book, selectedIds, writable, t, changed, clear, refresh, lock }) {
  const [action, setAction] = useState('add-tags'), [tags, setTags] = useState(''), [linked, setLinked] = useState('')
  const [preview, setPreview] = useState(null), [result, setResult] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const pending = useRef(false), operation = useRef({ key: '', id: '' })
  useEffect(() => { lock(busy || !!preview); return () => lock(false) }, [busy, preview, lock])
  const run = async fn => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { await fn(new AbortController().signal) } catch (error) { setError(error.reason ?? 'storage-failed') } finally { pending.current = false; setBusy(false) }
  }
  const inspect = () => run(async signal => {
    const request = { workspaceId, bookId: book.bookId, expectedRevision: book.revision, chapterIds: [...selectedIds], action,
      tags: action === 'add-tags' ? [...new Set(tags.split(/[,，]/u).map(value => value.trim()).filter(Boolean))] : [], linkedChapterId: action === 'link-chapter' ? linked : '' }
    const key = JSON.stringify(request)
    if (operation.current.key !== key) operation.current = { key, id: crypto.randomUUID() }
    const input = { ...request, operationId: operation.current.id }, value = unwrap(await api.previewMaterialBatch(sessionId, input, signal))
    setPreview({ request: input, value }); setResult(null)
  })
  const submit = () => run(async signal => {
    const value = unwrap(await api.updateMaterialBatch(sessionId, preview.request, signal))
    changed(value); setResult(preview.value); setPreview(null); clear()
  })
  const outdated = preview && preview.value.revision !== book.revision
  return <section className="sn-material-batch">
    <p className="sn-notice">{t('batchSelectionHint')} · {selectedIds.length}/100 {t('selectedMaterials')}</p>
    {error && <p role="alert">{t(error)} <Button size="sm" disabled={busy} onClick={() => run(async () => { await refresh(); setPreview(null) })}>{t('refresh')}</Button></p>}
    {result ? <><p role="status">{t('batchCompleted')} · {result.items.length}</p><details><summary>{t('batchResults')}</summary>{result.items.map(item => <p key={item.before.chapterId}>{item.before.title} · {t(JSON.stringify(item.before) === JSON.stringify(item.after) ? 'batchUnchanged' : 'batchUpdated')}</p>)}</details><Button size="sm" onClick={() => setResult(null)}>{t('continueOrganizing')}</Button></> : preview ? <>
      <h3>{t('batchPreview')} · {preview.value.items.length}</h3><p className="sn-notice">{t('batchAtomicHint')}</p>
      {!preview.value.complete && <p role="status">{t('batchImpactIncomplete')}</p>}
      {outdated && <p role="alert">{t('batchSourceChanged')}</p>}
      <details className="sn-batch-changes" open><summary>{t('batchChanges')}</summary>{preview.value.items.map(item => <article className="sn-review-issue" key={item.before.chapterId}><strong>{item.before.title}</strong><p>{preview.request.action === 'add-tags' ? `${t('tags')}: ${(item.before.tags ?? []).join(' / ') || t('none')} → ${(item.after.tags ?? []).join(' / ')}` : preview.request.action === 'link-chapter' ? `${t('linkedChapters')}: ${book.chapters.find(source => source.chapterId === preview.request.linkedChapterId)?.title}` : `${t('status-' + (item.before.status ?? 'active'))} → ${t('status-archived')}`}</p><small>{item.uses} {t('generationUses')} · {item.backlinks} {t('backlinks')} · {item.draftBranches} {t('draftBranches')}</small></article>)}</details>
      <div className="sn-row sn-recovery-actions"><Button size="sm" variant="primary" disabled={busy || !writable || outdated && !error || error === 'revision-conflict' || error === 'recovery-required'} onClick={submit}>{t(error ? 'retryBatchCommit' : 'confirmBatch')}</Button><Button size="sm" disabled={busy} onClick={() => setPreview(null)}>{t('backToSelection')}</Button></div>
    </> : <>
      <Select aria-label={t('batchAction')} value={action} disabled={busy} onChange={event => setAction(event.target.value)}>{['add-tags', 'link-chapter', 'archive'].map(value => <option key={value} value={value}>{t('batch-' + value)}</option>)}</Select>
      {action === 'add-tags' && <Input className="sn-input" aria-label={t('batchTags')} placeholder={t('batchTags')} value={tags} maxLength={4096} disabled={busy} onChange={event => setTags(event.target.value)} />}
      {action === 'link-chapter' && <Select aria-label={t('batchLinkedChapter')} value={linked} disabled={busy} onChange={event => setLinked(event.target.value)}><option value="">{t('batchChooseChapter')}</option>{book.chapters.filter(item => !item.kind || item.kind === 'chapter').map(item => <option key={item.chapterId} value={item.chapterId}>{item.title}</option>)}</Select>}
      <div className="sn-row sn-recovery-actions"><Button size="sm" disabled={!writable || busy || !selectedIds.length || action === 'add-tags' && !tags.trim() || action === 'link-chapter' && !linked} onClick={inspect}>{t('previewBatch')}</Button><Button size="sm" disabled={busy || !selectedIds.length} onClick={clear}>{t('clearSelection')}</Button></div>
    </>}
  </section>
}
