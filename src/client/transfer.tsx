import React, { useEffect, useRef, useState } from 'react'
import { unwrap } from './books.js'
export function Transfer({ api, sessionId, book, writable, t, imported }) {
  const [request, setRequest] = useState(null), [preview, setPreview] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [scope, setScope] = useState('chapters'), [format, setFormat] = useState('md')
  const pending = useRef(null), live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false; pending.current?.abort() } }, [])
  const action = async fn => {
    if (pending.current) return
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError('')
    try { await fn(controller.signal) } catch (error) { if (!controller.signal.aborted) setError(error.reason ?? 'invalid-import') }
    finally { pending.current = null; if (live.current) setBusy(false) }
  }
  const inspect = next => action(async signal => { setPreview(null); setRequest(next); setPreview(unwrap(await api.previewImport(sessionId, next, signal))) })
  return <details className="sn-transfer"><summary>{t('importExport')}</summary>{error && <p role="alert">{t(error)}</p>}
    <label className="sn-field">{t('importFile')}<input aria-label={t('importFile')} type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" disabled={!writable || busy} onChange={event => {
      const file = event.target.files[0]; if (!file) return
      action(async signal => {
        setPreview(null); setRequest(null)
        if (file.size > 8 * 1024 * 1024) throw { reason: 'too-large' }
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer())
        const next = { operationId: crypto.randomUUID(), title: file.name.replace(/\.(md|markdown|txt)$/iu, ''), text, mode: text.startsWith('<!-- dsh-super-novel-export ') ? 'archive' : 'headings' }
        setRequest(next); setPreview(unwrap(await api.previewImport(sessionId, next, signal)))
      })
    }} /></label>
    {request && <><label className="sn-field">{t('importTitle')}<input aria-label={t('importTitle')} maxLength={200} value={request.title} disabled={busy} onChange={event => { setRequest({ ...request, operationId: crypto.randomUUID(), title: event.target.value }); setPreview(null) }} /></label>
      <label className="sn-field">{t('chapterBoundaries')}<select aria-label={t('chapterBoundaries')} value={request.mode} disabled={busy} onChange={event => inspect({ ...request, operationId: crypto.randomUUID(), mode: event.target.value })}>{['single', 'headings', 'archive'].map(mode => <option key={mode} value={mode}>{t(`import-${mode}`)}</option>)}</select></label>
      {!preview && <button disabled={busy} onClick={() => inspect(request)}>{t('previewImport')}</button>}
    </>}
    {preview && <><p role="status">{preview.bytes} B · {preview.chapters.length} {t('chapters')} · {t('notAnalyzed')}</p><ol className="sn-import-preview">{preview.chapters.slice(0, 100).map((item, i) => <li key={i}>{item.title} · {item.characters}</li>)}</ol><button disabled={!writable || busy} onClick={() => action(async signal => { imported(unwrap(await api.importBook(sessionId, request, signal))); setPreview(null); setRequest(null) })}>{t('confirmImport')}</button></>}
    {busy && <button onClick={() => pending.current?.abort()}>{t('stop')}</button>}
    {book && <><label className="sn-field">{t('exportScope')}<select aria-label={t('exportScope')} value={scope} onChange={event => setScope(event.target.value)}><option value="chapters">{t('chapters')}</option><option value="materials">{t('materialsView')}</option></select></label><label className="sn-field">{t('exportFormat')}<select aria-label={t('exportFormat')} value={format} onChange={event => setFormat(event.target.value)}><option value="md">Markdown</option><option value="txt">TXT</option></select></label>
      <button disabled={busy || book.recoveryRequired} onClick={() => action(async signal => {
        const ids = book.chapters.filter(item => scope === 'chapters' ? !item.kind || item.kind === 'chapter' : item.kind && !['chapter', 'facts', 'voice'].includes(item.kind)).map(item => item.chapterId)
        const result = unwrap(await api.exportBook(sessionId, book.bookId, ids, signal)), url = URL.createObjectURL(new Blob([result.text], { type: 'text/plain;charset=utf-8' })), anchor = document.createElement('a')
        anchor.href = url; anchor.download = `${result.title.replace(/[\\/:*?"<>|]/g, '_')}.${format}`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      })}>{t('export')}</button></>}
  </details>
}
