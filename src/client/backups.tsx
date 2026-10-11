import React, { useEffect, useState } from 'react'
import { Button, Input } from './primitives.js'
import { unwrap } from './books.js'

export function Backups({ api, sessionId, workspaceId, book, writable, t, beforeBackup, restored, preferredOpen, switching, switched }) {
  const [settings, setSettings] = useState(null), [root, setRoot] = useState(''), [items, setItems] = useState([])
  const [preview, setPreview] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [refresh, setRefresh] = useState(0), [health, setHealth] = useState(null)
  const [open, setOpen] = useState(false), [copyRequest, setCopyRequest] = useState(null), [copy, setCopy] = useState(null)
  useEffect(() => {
    if (!preferredOpen?.version) return
    setOpen(true)
    if (!preferredOpen.backupId) return
    const controller = new AbortController(); setPreview(null); setError('')
    api.inspectBackup(sessionId, { workspaceId, bookId: preferredOpen.bookId, backupId: preferredOpen.backupId }, controller.signal).then(unwrap).then(value => {
      if (controller.signal.aborted) return
      if (value.manifestHash !== preferredOpen.manifestHash) { setError('invalid-backup'); return }
      setPreview(value)
    }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [api, sessionId, workspaceId, preferredOpen?.version])
  useEffect(() => {
    const controller = new AbortController()
    Promise.all([api.backupSettings(sessionId, workspaceId, controller.signal).then(unwrap), api.backupCatalog(sessionId, workspaceId, controller.signal).then(unwrap), book ? api.backupHealth(sessionId, workspaceId, book.bookId, controller.signal).then(unwrap) : Promise.resolve({ state: 'none' })])
      .then(([value, items, health]) => { if (!controller.signal.aborted) { setSettings(value); setRoot(value.root); setItems(items); setHealth(health) } })
      .catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [api, sessionId, workspaceId, book?.bookId, refresh, preferredOpen?.version])
  const run = async fn => { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await fn(new AbortController().signal) } catch (error) { setError(error.reason ?? 'storage-failed') } finally { setBusy(false) } }
  const query = (backupId, bookId = book?.bookId) => ({ workspaceId, bookId, backupId })
  const current = items.find(item => item.bookId === book?.bookId)
  return <details className="sn-backups" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{t('completeBackup')}</summary>
    <p className="sn-notice">{t('backupHint')}</p>
    {error && <p role="alert">{t(error)}</p>}{notice && <p role="status">{notice}</p>}
    {settings && <>
      <p className="sn-path">{settings.path}</p>
      <div className="sn-row sn-recovery-actions"><Button size="sm" disabled={busy || !writable || !book} onClick={() => run(async signal => { await beforeBackup(); const item = unwrap(await api.createBackup(sessionId, query(crypto.randomUUID()), signal)); setItems(items => [item, ...items]); setHealth({ state: 'verified' }); setNotice(t('backupVerified')) })}>{t('backupNow')}</Button><Button size="sm" disabled={busy} onClick={() => run(async signal => unwrap(await api.openBackupLocation(sessionId, workspaceId, signal)))}>{t('openBackupFolder')}</Button></div>
      <label className="sn-field">{t('backupRoot')}<Input className="sn-input" value={root} aria-label={t('backupRoot')} disabled={busy || !writable} onChange={event => setRoot(event.target.value)} /></label>
      <div className="sn-row sn-recovery-actions"><Button size="sm" disabled={busy || !writable || !root.trim()} onClick={() => run(async signal => { setSettings(unwrap(await api.configureBackups(sessionId, { workspaceId, root: root.trim(), automatic: settings.automatic }, signal))); setPreview(null); setRefresh(value => value + 1) })}>{t('saveBackupLocation')}</Button><Button size="sm" aria-pressed={settings.automatic} disabled={busy || !writable} onClick={() => run(async signal => setSettings(unwrap(await api.configureBackups(sessionId, { workspaceId, root: settings.root, automatic: !settings.automatic }, signal))))}>{t(settings.automatic ? 'automaticBackupOn' : 'automaticBackupOff')}</Button></div>
    </>}
    {health?.state === 'failed' && <p role="alert">{t('backupAttemptFailed')}: {t(health.reason)}</p>}
    <p role="status">{current ? `${t('lastVerifiedBackup')}: ${new Date(current.verifiedAt).toLocaleString()}` : t('noBackup')}</p>
    <nav className="sn-reference-list" aria-label={t('backupList')}>{items.map(item => <Button key={item.backupId} data-backup-id={item.backupId} size="sm" disabled={busy} onClick={() => run(async signal => setPreview(unwrap(await api.inspectBackup(sessionId, query(item.backupId, item.bookId), signal))))}>{item.title} · {new Date(item.createdAt).toLocaleString()} · {item.fileCount} {t('files')} · {item.backupId.slice(0, 8)}{item.recoveryRequired ? ` · ${t('recoverySite')}` : ''}</Button>)}</nav>
    {preview && <section className="sn-recovery"><h4>{t('verifiedBackupPreview')}</h4><p>{preview.summary.title} · {preview.summary.fileCount} {t('files')} · {preview.summary.bytes} B</p><p className="sn-notice">{t('restoreBackupHint')}</p><details><summary>{t('fileList')}</summary><pre className="sn-reference-text">{preview.files.join('\n')}</pre></details><Button size="sm" disabled={busy || !writable} onClick={() => run(async signal => { await beforeBackup(); const value = unwrap(await api.restoreBackup(sessionId, { ...query(preview.summary.backupId, preview.summary.bookId), manifestHash: preview.manifestHash }, signal)); setNotice(`${t('restoredCopy')}: ${value.root}`); restored(value.root); const request = { ...query(preview.summary.backupId, preview.summary.bookId), manifestHash: preview.manifestHash, root: value.root }; setCopy(null); setCopyRequest(request); setCopy(unwrap(await api.previewRestoredCopy(sessionId, request, signal))) })}>{t('restoreNewCopy')}</Button></section>}
    {copyRequest && <section className="sn-restored-copy"><h4>{t('restoredCopyPreview')}</h4><p className="sn-path">{copyRequest.root}</p><p className="sn-notice">{t('restoredCopyScope')}</p>
      <Button size="sm" disabled={busy} onClick={() => run(async signal => { setCopy(null); setCopy(unwrap(await api.previewRestoredCopy(sessionId, copyRequest, signal))) })}>{t('recheckCopy')}</Button>
      {copy && <><p>{copy.title} · {copy.chapterCount} {t('chapters')} · {copy.materialCount} {t('materials')} · {t('revision')} {copy.revision}</p>{!copy.ready && <p role="alert">{t('copyNeedsRecovery')}</p>}<details><summary>{t('copyDocumentPreview')}</summary>{copy.documents.map(item => <article key={item.chapterId}><h5>{item.title}</h5><pre className="sn-inbox-excerpt">{item.excerpt}</pre></article>)}</details><Button variant="primary" size="sm" disabled={busy || !writable || !copy.ready} onClick={() => run(async signal => {
        switching(true)
        try { await beforeBackup(); unwrap(await api.switchToRestoredCopy(sessionId, copyRequest, signal)); switched(copy.bookId) }
        finally { switching(false) }
      })}>{t('switchToCopy')}</Button></>}
    </section>}
  </details>
}
