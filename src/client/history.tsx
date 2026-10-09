import React, { useEffect, useRef, useState } from 'react'
import { Select } from './controls.js'
import { Button } from './primitives.js'
import { unwrap } from './books.js'

export function InterruptedRecovery({ api, sessionId, bookId, writable, t, saved }) {
  const [view, setView] = useState(null)
  const [content, setContent] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(null)
  const id = useRef({ key: '', value: '' })
  useEffect(() => () => pending.current?.abort(), [])
  const action = async fn => {
    if (pending.current) return
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError('')
    try { await fn(controller.signal) } catch (error) { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') }
    finally { pending.current = null; if (!controller.signal.aborted) setBusy(false) }
  }
  return <details className="sn-history"><summary>{t('interruptedDrafts')}</summary>
    {error && <p role="alert">{t(error)}</p>}
    <Button size="sm" disabled={busy} onClick={() => action(async signal => { const value = unwrap(await api.interruptedSave(sessionId, bookId, signal)); setView(value); setContent(value.diskContent) })}>{t('reviewRecovery')}</Button>
    {view && <><div className="sn-diff"><div><h4>{t('currentDisk')}</h4><pre>{view.diskContent}</pre></div><div><h4>{t('preparedText')}</h4><pre>{view.preparedContent}</pre></div></div>
      <Button size="sm" disabled={busy || !writable} onClick={() => setContent(view.preparedContent)}>{t('usePrepared')}</Button>
      <label className="sn-field">{t('mergedText')}<textarea aria-label={t('recoveryText')} value={content} readOnly={busy || !writable} onChange={event => setContent(event.target.value)} /></label>
      <Button size="sm" disabled={busy || !writable} onClick={() => {
        if (!window.confirm(t('settleConfirm'))) return
        action(async signal => {
          const request = { bookId, pendingHash: view.pendingHash, diskHash: view.diskHash, content }
          const key = JSON.stringify(request)
          if (id.current.key !== key) id.current = { key, value: crypto.randomUUID() }
          saved(unwrap(await api.settleInterruptedSave(sessionId, { ...request, operationId: id.current.value }, signal)))
        })
      }}>{t('settleSave')}</Button>
    </>}
  </details>
}

export function ChapterRecovery({ api, sessionId, book, chapterId, entry, writable, dirty, stale, t, saved, onBusy, beforeChange }) {
  const [history, setHistory] = useState([])
  const [version, setVersion] = useState(null)
  const [conflicts, setConflicts] = useState([])
  const [conflictId, setConflictId] = useState('')
  const [merged, setMerged] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [hasOlder, setHasOlder] = useState(false)
  const pending = useRef(null)
  const identities = useRef(new Map())
  const live = useRef(true)
  const conflict = conflicts.find(item => item.conflictId === conflictId)
  useEffect(() => {
    live.current = true
    return () => { live.current = false; pending.current?.abort() }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    Promise.all([api.chapterHistory(sessionId, book.bookId, chapterId, 0, controller.signal).then(unwrap),
      api.chapterConflicts(sessionId, book.bookId, chapterId, controller.signal).then(unwrap)]).then(([history, conflicts]) => {
      if (controller.signal.aborted) return
      setHistory(history); setHasOlder(history.length === 100); setConflicts(conflicts)
      setConflictId(previous => conflicts.some(item => item.conflictId === previous) ? previous : conflicts[0]?.conflictId ?? '')
    }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [api, sessionId, book.bookId, book.revision, chapterId, refresh])
  useEffect(() => { setMerged(conflict?.localContent ?? '') }, [conflictId])
  const identity = request => {
    const key = JSON.stringify(request)
    if (!identities.current.has(key)) identities.current.set(key, crypto.randomUUID())
    return identities.current.get(key)
  }
  const action = async (fn, reload = true) => {
    if (pending.current) return
    const controller = new AbortController(); pending.current = controller; setBusy(true); onBusy(true); setError('')
    try { await fn(controller.signal) }
    catch (error) { if (live.current && !controller.signal.aborted) setError(error.reason ?? 'storage-failed') }
    finally { pending.current = null; if (live.current) { setBusy(false); onBusy(false); if (reload) setRefresh(value => value + 1) } }
  }
  const preserve = () => action(async signal => {
    const request = { bookId: book.bookId, chapterId, baselineRevision: entry.bookRevision, baselineHash: entry.baseHash, localContent: entry.content }
    const result = unwrap(await api.preserveConflict(sessionId, { ...request, conflictId: identity({ ...request, diskHash: entry.diskHash }) }, signal))
    if (live.current) { setConflicts(previous => [result, ...previous.filter(item => item.conflictId !== result.conflictId)]); setConflictId(result.conflictId) }
  })
  const restore = () => {
    if (!window.confirm(t('restoreConfirm'))) return
    action(async signal => {
      const request = { bookId: book.bookId, chapterId, sourceOperationId: version.operationId, expectedSourceHash: version.hash,
        expectedRevision: book.revision, expectedHash: entry.diskHash }
      await beforeChange()
      unwrap(await api.restoreChapter(sessionId, { ...request, operationId: identity(request) }, signal))
      if (live.current) await saved()
    })
  }
  const resolve = choice => {
    if (!window.confirm(t('resolveConfirm'))) return
    action(async signal => {
      const request = { bookId: book.bookId, conflictId, expectedRevision: book.revision, expectedHash: entry.diskHash,
        choice, mergedContent: choice === 'merged' ? merged : '' }
      await beforeChange()
      unwrap(await api.resolveConflict(sessionId, { ...request, operationId: identity(request) }, signal))
      if (live.current) await saved()
    })
  }
  return <section className="sn-history" aria-label={t('history')}>
    {error && <p role="alert" className="sn-alert">{t(error)}</p>}
    <details><summary>{t('history')}</summary>
      <label className="sn-field">{t('savedVersion')}<Select aria-label={t('savedVersion')} value={version?.operationId ?? ''} disabled={busy} onChange={event => {
        const id = event.target.value
        if (!id) { setVersion(null); return }
        action(async signal => { const result = unwrap(await api.chapterVersion(sessionId, book.bookId, chapterId, id, signal)); if (live.current) setVersion(result) }, false)
      }}><option value="">{t('chooseVersion')}</option>{history.map(item => <option key={item.operationId} value={item.operationId}>{t('revision')} {item.chapterRevision} · {t(`source-${item.source}`)}</option>)}</Select></label>
      {hasOlder && <Button size="sm" disabled={busy} onClick={() => action(async signal => {
        const older = unwrap(await api.chapterHistory(sessionId, book.bookId, chapterId, history.at(-1).bookRevision, signal))
        if (live.current) { setHistory(previous => [...previous, ...older]); setHasOlder(older.length === 100) }
      }, false)}>{t('olderVersions')}</Button>}
      {version && <><div className="sn-diff"><div><h4>{t('currentDisk')}</h4><pre>{entry.diskContent}</pre></div><div><h4>{t('savedVersion')}</h4><pre aria-label={t('historicalText')}>{version.content}</pre></div></div>
        <Button size="sm" disabled={!writable || busy || dirty} onClick={restore}>{t('restoreVersion')}</Button>{dirty && <p role="status">{t('saveFirst')}</p>}</>}
    </details>
    <details open={stale || undefined}><summary>{t('conflictDrafts')}</summary>
      <Button size="sm" disabled={!writable || busy} onClick={preserve}>{t('preserveBoth')}</Button>
      {!!conflicts.length && <label className="sn-field">{t('conflictRecord')}<Select aria-label={t('conflictRecord')} value={conflictId} onChange={event => setConflictId(event.target.value)}>{conflicts.map(item => <option key={item.conflictId} value={item.conflictId}>{new Date(item.createdAt).toLocaleString()} · {t(item.resolved ? 'resolved' : 'unresolved')}</option>)}</Select></label>}
      {conflict && <><div className="sn-diff"><div><h4>{t('retainedLocal')}</h4><pre aria-label={t('retainedLocal')}>{conflict.localContent}</pre></div><div><h4>{t('retainedDisk')}</h4><pre aria-label={t('retainedDisk')}>{conflict.diskContent}</pre></div></div>
        {!conflict.resolved && <><label className="sn-field">{t('mergedText')}<textarea aria-label={t('mergedText')} value={merged} readOnly={!writable || busy} onChange={event => setMerged(event.target.value)} /></label>
          <div className="sn-row sn-recovery-actions"><Button size="sm" disabled={!writable || busy || entry.diskHash !== conflict.diskHash} onClick={() => resolve('disk')}>{t('useDisk')}</Button><Button size="sm" disabled={!writable || busy} onClick={() => resolve('local')}>{t('useLocal')}</Button><Button size="sm" disabled={!writable || busy} onClick={() => resolve('merged')}>{t('saveMerge')}</Button></div>
          {entry.diskHash !== conflict.diskHash && <p role="status">{t('diskChangedAgain')}</p>}
        </>}
      </>}
    </details>
  </section>
}
