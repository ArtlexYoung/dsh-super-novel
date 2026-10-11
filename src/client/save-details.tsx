import React, { useEffect, useRef, useState } from 'react'
import { Button, Input } from './primitives.js'
import { unwrap } from './books.js'

export function SaveDetailsPanel({ api, sessionId, workspaceId, book, chapterId, branchId, entry, draftState, open, writable, t, beforeChange, recovery }) {
  const [details, setDetails] = useState(null), [milestones, setMilestones] = useState(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false), [label, setLabel] = useState(''), [created, setCreated] = useState(null)
  const pending = useRef(false), request = useRef({ key: '', id: '' })
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setDetails(null)
    const input = { workspaceId, bookId: book.bookId, chapterId, branchId, operationId: entry.operationId }
    Promise.allSettled([api.saveDetails(sessionId, input, controller.signal).then(unwrap), api.bookMilestones(sessionId, workspaceId, book.bookId, controller.signal).then(unwrap)]).then(([status, listing]) => {
      if (controller.signal.aborted) return
      if (status.status === 'fulfilled') setDetails(status.value)
      if (listing.status === 'fulfilled') setMilestones(listing.value)
      setError(status.status === 'rejected' ? status.reason.reason ?? 'storage-failed' : listing.status === 'rejected' ? listing.reason.reason ?? 'storage-failed' : '')
    })
    return () => controller.abort()
  }, [api, sessionId, workspaceId, book.bookId, book.revision, chapterId, entry.operationId, draftState.kind, open, refresh])
  const create = async () => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try {
      await beforeChange()
      const key = JSON.stringify({ workspaceId, bookId: book.bookId, expectedRevision: book.revision, label: label.trim() })
      if (key !== request.current.key) request.current = { key, id: crypto.randomUUID() }
      const value = unwrap(await api.createMilestone(sessionId, { ...JSON.parse(key), backupId: request.current.id }, new AbortController().signal))
      setCreated(value); setRefresh(value => value + 1); setLabel('')
    } catch (error) { setError(error.reason ?? 'storage-failed') }
    finally { pending.current = false; setBusy(false) }
  }
  const timestamp = value => new Date(value).toLocaleString()
  return <div className="sn-save-details">
    <p className="sn-notice">{t('saveDetailsHint')}</p>
    {error && <p role="alert">{t(error)} <Button size="sm" disabled={busy} onClick={() => setRefresh(value => value + 1)}>{t('refresh')}</Button></p>}
    {!details && !error && <p role="status">{t('loading')}</p>}
    {details && <div className="sn-save-layers">
      <section><h4>{t('currentInputCheckpoint')}</h4><p role="status">{t('input-' + (entry.content === entry.diskContent && !entry.externallyModified && details.formal.state === 'saved' ? 'formal' : details.draft.state))}</p>
        {details.draft.current && <p className="sn-notice">{timestamp(details.draft.current.savedAt)} · #{details.draft.current.sequence}</p>}
        {details.draft.latest && !details.draft.current && <p className="sn-notice">{t('otherCheckpoint')}: {timestamp(details.draft.latest.savedAt)}</p>}
        {details.draft.reason && <p role="alert">{t(details.draft.reason)}</p>}
      </section>
      <section><h4>{t('formalDiskText')}</h4><p role="status">{t('formal-' + details.formal.state)}</p>{details.formal.revision > 0 && <p className="sn-notice">{t('revision')} {details.formal.revision}</p>}{details.formal.reason && <p role="alert">{t(details.formal.reason)}</p>}</section>
      <section><h4>{t('thisBookBackup')}</h4><p role="status">{t('backup-detail-' + details.backup.state)}</p>{details.backup.summary && <p className="sn-notice">{timestamp(details.backup.summary.createdAt)} · {t('revision')} {details.backup.summary.revision}{details.backup.summary.recoveryRequired && ` · ${t('recoverySite')}`}</p>}{details.backup.reason && <p role="alert">{t(details.backup.reason)}</p>}{details.backup.attempt.state === 'failed' && <p role="alert">{t('backupAttemptFailed')}: {t(details.backup.attempt.reason)}</p>}</section>
    </div>}
    <div className="sn-row"><Button size="sm" disabled={busy} onClick={() => setRefresh(value => value + 1)}>{t('refresh')}</Button><Button size="sm" disabled={busy} onClick={() => recovery()}>{t('backupsAndRecovery')}</Button></div>
    <section className="sn-milestones"><h4>{t('bookMilestones')}</h4><p className="sn-notice">{t('milestoneScope')}</p>
      {created && <p role="status">{t('milestoneCreated')}: {created.label}</p>}
      <details><summary>{t('newMilestone')}</summary><form onSubmit={event => { event.preventDefault(); create() }}><Input className="sn-input" aria-label={t('milestoneName')} value={label} maxLength={200} disabled={!writable || busy} onChange={event => setLabel(event.target.value)} placeholder={t('milestoneNameHint')} /><Button variant="primary" size="sm" type="submit" disabled={!writable || busy || !label.trim()}>{t('createMilestone')}</Button></form></details>
      {milestones && !milestones.complete && <p role="alert">{t('milestoneListIncomplete')}</p>}
      {!milestones?.items.length && <p className="sn-notice">{t('noMilestones')}</p>}
      {milestones?.items.map(item => <div className="sn-milestone-item" key={item.backupId} data-backup-id={item.backupId}><strong>{item.label}</strong><small>{timestamp(item.createdAt)} · {t('revision')} {item.revision} · {item.backupId.slice(0, 8)}</small><Button size="sm" onClick={() => recovery(item)}>{t('backupsAndRecovery')}</Button></div>)}
    </section>
  </div>
}
