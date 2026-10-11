import React, { useContext, useEffect, useRef, useState } from 'react'
import { Button } from './primitives.js'
import { DraftWriter } from './draft-writer.js'
import { FormDraftCache, readFormEnvelope } from './form-cache.js'
import { unwrap } from './books.js'
import { DraftBarrierContext } from './draft-context.js'

export function useFormDraft({ api, sessionId, workspaceId, book, chapterId, branchId, kind, baseHash, initial }) {
  const barrier = useContext(DraftBarrierContext)
  const identity = { workspaceId, bookId: book.bookId, chapterId }, cache = useRef(null), live = useRef(true), source = useRef(null), cleanup = useRef([])
  if (!cache.current) cache.current = new FormDraftCache(kind, identity, () => localStorage)
  const own = useRef(cache.current.read(branchId)), current = useRef(own.current.kind === 'found' ? readFormEnvelope(own.current.value.content, kind).value : initial)
  const [value, setValue] = useState(current.current), [status, setStatus] = useState({ kind: 'formal' }), [refresh, setRefresh] = useState(0)
  const writer = useRef(null)
  if (!writer.current) {
    writer.current = new DraftWriter({ ...identity, branchId }, {
      cache: request => cache.current.write(request), forget: request => cache.current.forget(request),
      checkpoint: request => api.checkpointFormDraft(sessionId, { ...request, kind }, new AbortController().signal).then(unwrap),
      settle: request => api.dismissFormDraft(sessionId, { ...request, kind }, new AbortController().signal).then(unwrap),
      changed: state => { if (live.current) setStatus(state) },
    })
    writer.current.sequence = cache.current.sequence(branchId)
    if (own.current.kind === 'found') writer.current.latest = own.current.value
  }
  useEffect(() => {
    live.current = true
    const checkpoint = () => writer.current.attempt(), unload = event => { if (current.current && writer.current.latest && writer.current.state.kind !== 'disk') { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('pagehide', checkpoint); window.addEventListener('beforeunload', unload)
    if (writer.current.latest) { barrier?.register(writer.current); checkpoint() }
    return () => { live.current = false; checkpoint(); window.removeEventListener('pagehide', checkpoint); window.removeEventListener('beforeunload', unload) }
  }, [])
  const update = (next, persist = true) => {
    current.current = next; setValue(next)
    if (next && persist) { writer.current.update({ content: JSON.stringify(next), operationId: crypto.randomUUID(), baseHash, bookRevision: book.revision }); barrier?.register(writer.current) }
  }
  const retryRetire = async () => {
    while (cleanup.current.length) {
      const { latest, previous } = cleanup.current[0]
      if (latest) {
        await writer.current.settle(latest, 'dismissed')
        // A failed cache cleanup may have cleared writer.latest already.
        await cache.current.forget(latest)
      }
      if (previous) {
        if (previous.disk) await api.dismissFormDraft(sessionId, { ...identity, kind, branchId: previous.branchId, sequence: previous.sequence, contentHash: previous.contentHash, action: 'dismissed' }, new AbortController().signal).then(unwrap)
        await cache.current.forget(previous)
        if (source.current === previous) source.current = null
      }
      cleanup.current.shift()
    }
    setRefresh(value => value + 1)
  }
  const retire = async () => {
    await writer.current.flush()
    const latest = writer.current.latest, previous = source.current
    if (latest || previous) cleanup.current.push({ latest, previous })
    await retryRetire()
  }
  return { value, update, status, refresh, kind, identity, cache: cache.current, flush: () => writer.current.flush(), retry: () => writer.current.attempt(), retire, retryRetire,
    restore: (record, envelope) => { source.current = record; update(envelope); setRefresh(value => value + 1) },
    composing: active => { writer.current.composing = active; if (!active) writer.current.attempt() } }
}

export function FormDraftStatus({ draft, t }) {
  if (draft.status.kind === 'formal') return <></>
  return <p className="sn-notice sn-form-draft-status" data-state={draft.status.kind} data-reason={draft.status.reason} role={['failed', 'browser-failed'].includes(draft.status.kind) ? 'alert' : 'status'}>
    {t('form-draft-' + draft.status.kind)}{['failed', 'browser-failed'].includes(draft.status.kind) && <Button size="sm" onClick={draft.retry}>{t('retryDraft')}</Button>}
  </p>
}

/** Other editor branches are previewed explicitly and never chosen automatically. */
export function FormRecovery({ draft, api, sessionId, t, preview, disabled }) {
  const [records, setRecords] = useState([]), [selected, setSelected] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    api.formDrafts(sessionId, { ...draft.identity, kind: draft.kind }, controller.signal).then(unwrap).then(result => {
      if (controller.signal.aborted) return
      const disk = result.drafts.map(record => ({ ...record, disk: true })), keys = new Set(disk.map(record => `${record.branchId}:${record.sequence}`))
      setRecords([...disk, ...draft.cache.list().filter(record => !keys.has(`${record.branchId}:${record.sequence}`))].sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0)).slice(0, 20))
      setError(result.unreadable ? 'invalid-form-draft' : '')
    }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [api, sessionId, draft.identity.workspaceId, draft.identity.bookId, draft.identity.chapterId, draft.kind, draft.refresh, revision])
  const inspect = async record => {
    setBusy(true); setError('')
    try {
      const value = record.disk ? unwrap(await api.formDraft(sessionId, { ...draft.identity, kind: draft.kind, branchId: record.branchId, sequence: record.sequence }, new AbortController().signal)) : record
      const envelope = readFormEnvelope(value.content, draft.kind)
      if (envelope.kind !== 'found') throw new Error('invalid-form-draft')
      setSelected({ record: { ...value, disk: !!record.disk }, envelope: envelope.value })
    } catch (error) { setError(error.reason ?? 'invalid-form-draft') }
    finally { setBusy(false) }
  }
  return <details className="sn-form-recovery"><summary>{t('recoverFormDraft')} {records.length ? `(${records.length})` : ''}</summary>
    <p className="sn-notice">{t('formRecoveryHint')}</p>{error && <p role="alert">{t(error)}</p>}
    <Button size="sm" disabled={busy} onClick={() => setRevision(value => value + 1)}>{t('refresh')}</Button>
    {!records.length && <p className="sn-notice">{t('noFormDrafts')}</p>}
    {records.map(record => <div className="sn-row sn-form-recovery-item" key={`${record.branchId}:${record.sequence}`}><span>{record.savedAt ? new Date(record.savedAt).toLocaleString() : t('browserFormCopy')}</span><Button size="sm" disabled={busy} onClick={() => inspect(record)}>{t('preview')}</Button></div>)}
    {selected && <div className="sn-form-recovery-preview">{preview(selected.envelope.form)}<Button size="sm" disabled={disabled || busy} onClick={async () => {
      setBusy(true)
      try { await draft.flush(); draft.restore(selected.record, selected.envelope); setSelected(null) }
      catch (error) { setError(error.reason ?? 'storage-failed') } finally { setBusy(false) }
    }}>{t('restoreFormInput')}</Button></div>}
  </details>
}
