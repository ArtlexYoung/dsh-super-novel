import React, { useEffect, useState } from 'react'
import { Button } from './primitives.js'
import { unwrap } from './books.js'
import { readCachedDrafts } from './draft-cache.js'

export function DraftRecovery({ api, sessionId, workspaceId, bookId, chapterId, entry, writable, t, restore, beforeRestore }) {
  const [drafts, setDrafts] = useState([]), [preview, setPreview] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0)
  const [open, setOpen] = useState(false)
  const query = { workspaceId, bookId, chapterId }
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setPreview(previous => previous?.workspaceId === workspaceId && previous?.bookId === bookId && previous?.chapterId === chapterId ? previous : null)
    Promise.allSettled([api.chapterDrafts(sessionId, query, controller.signal).then(unwrap), readCachedDrafts(workspaceId, bookId, chapterId)]).then(([diskResult, browserResult]) => {
      if (controller.signal.aborted) return
      const disk = diskResult.status === 'fulfilled' ? diskResult.value.drafts : []
      const browser = browserResult.status === 'fulfilled' ? browserResult.value : { drafts: [] }
      const saved = disk.map(item => ({ ...item, source: 'disk' }))
      const local = browser.drafts.filter(item => !saved.some(value => value.branchId === item.branchId && value.sequence === item.sequence)).map(item => ({ ...item, source: 'browser' }))
      setDrafts([...local, ...saved]); setError(diskResult.status === 'rejected' ? diskResult.reason.reason ?? 'storage-failed' : diskResult.value.unreadable ? 'draft-unreadable' : '')
    }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [api, sessionId, workspaceId, bookId, chapterId, open, refresh])
  const run = async fn => {
    if (busy) return
    setBusy(true); setError('')
    try { await fn(new AbortController().signal) } catch (error) { setError(error.reason ?? 'storage-failed') }
    finally { setBusy(false) }
  }
  return <details className="sn-draft-recovery" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{t('recoverDrafts')}{drafts.length ? ` · ${drafts.length}` : ''}</summary>
    <p className="sn-notice">{t('recoverDraftHint')}</p>
    {error && <p role="alert">{t(error)}</p>}
    <Button size="sm" disabled={busy} onClick={() => setRefresh(value => value + 1)}>{t('refresh')}</Button>
    {!drafts.length && !error && <p>{t('noDrafts')}</p>}
    {drafts.map(draft => <div className="sn-draft-item" key={`${draft.source}:${draft.branchId}:${draft.sequence}`}><span>{t(draft.source === 'disk' ? 'diskDraft' : 'browserDraft')} · {draft.savedAt ? new Date(draft.savedAt).toLocaleString() : ''} · #{draft.sequence} · {draft.branchId.slice(0, 8)}</span><Button size="sm" disabled={busy} onClick={() => run(async signal => {
      setPreview(draft.source === 'browser' ? draft : unwrap(await api.readDraft(sessionId, { ...query, branchId: draft.branchId, sequence: draft.sequence }, signal)))
    })}>{t('preview')}</Button></div>)}
    {preview && <div className="sn-draft-preview">
      {preview.baseHash !== entry.diskHash && <p role="alert">{t('draftBaselineChanged')}</p>}
      <div className="sn-diff"><div><h4>{t('currentDisk')}</h4><pre>{entry.diskContent}</pre></div><div><h4>{t('diskDraft')}</h4><pre>{preview.content}</pre></div></div>
      <Button size="sm" variant="primary" disabled={busy || !writable} onClick={() => run(async () => { await beforeRestore(); restore(preview); setPreview(null) })}>{t('restoreToEditor')}</Button>
      <Button size="sm" disabled={busy} onClick={() => setPreview(null)}>{t('cancel')}</Button>
    </div>}
  </details>
}
