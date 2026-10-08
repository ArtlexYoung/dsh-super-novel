import React, { useEffect, useRef, useState } from 'react'
import { Select } from './controls.js'
import { Button, Input } from './primitives.js'
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
    {request && <><label className="sn-field">{t('importTitle')}<Input className="sn-input" aria-label={t('importTitle')} maxLength={200} value={request.title} disabled={busy} onChange={event => { setRequest({ ...request, operationId: crypto.randomUUID(), title: event.target.value }); setPreview(null) }} /></label>
      <label className="sn-field">{t('chapterBoundaries')}<Select aria-label={t('chapterBoundaries')} value={request.mode} disabled={busy} onChange={event => inspect({ ...request, operationId: crypto.randomUUID(), mode: event.target.value })}>{['single', 'headings', 'archive'].map(mode => <option key={mode} value={mode}>{t(`import-${mode}`)}</option>)}</Select></label>
      {!preview && <Button size="sm" disabled={busy} onClick={() => inspect(request)}>{t('previewImport')}</Button>}
    </>}
    {preview && <><p role="status">{preview.bytes} B · {preview.chapters.length} {t('chapters')} · {t('notAnalyzed')}</p><ol className="sn-import-preview">{preview.chapters.slice(0, 100).map((item, i) => <li key={i}>{item.title} · {item.characters}</li>)}</ol><Button size="sm" disabled={!writable || busy} onClick={() => action(async signal => { imported(unwrap(await api.importBook(sessionId, request, signal))); setPreview(null); setRequest(null) })}>{t('confirmImport')}</Button></>}
    {busy && <Button size="sm" onClick={() => pending.current?.abort()}>{t('stop')}</Button>}
    {book && <><label className="sn-field">{t('exportScope')}<Select aria-label={t('exportScope')} value={scope} onChange={event => setScope(event.target.value)}><option value="chapters">{t('chapters')}</option><option value="materials">{t('materialsView')}</option></Select></label><label className="sn-field">{t('exportFormat')}<Select aria-label={t('exportFormat')} value={format} onChange={event => setFormat(event.target.value)}><option value="md">Markdown</option><option value="txt">TXT</option></Select></label>
      <Button size="sm" disabled={busy || book.recoveryRequired} onClick={() => action(async signal => {
        const ids = book.chapters.filter(item => scope === 'chapters' ? !item.kind || item.kind === 'chapter' : item.kind && !['chapter', 'facts', 'voice'].includes(item.kind)).map(item => item.chapterId)
        const result = unwrap(await api.exportBook(sessionId, book.bookId, ids, signal)), url = URL.createObjectURL(new Blob([result.text], { type: 'text/plain;charset=utf-8' })), anchor = document.createElement('a')
        anchor.href = url; anchor.download = `${result.title.replace(/[\\/:*?"<>|]/g, '_')}.${format}`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      })}>{t('export')}</Button></>}
  </details>
}
