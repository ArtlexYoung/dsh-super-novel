import React, { useEffect, useRef, useState } from 'react'
import { Button, Input } from './primitives.js'
import { Select } from './controls.js'
import { unwrap } from './books.js'

/** Scope changes never generate; only the explicit start button consumes a request. */
export function BookReviewPanel({ api, sessionId, workspaceId, book, chapterId, open, revisionHint, writable, t, beforeGenerate, navigate, revised }) {
  const chapters = book.chapters.filter(item => (!item.kind || item.kind === 'chapter') && !['archived', 'trashed'].includes(item.status))
  const [ids, setIds] = useState(() => {
    const at = Math.max(0, chapters.findIndex(item => item.chapterId === chapterId))
    return chapters.slice(Math.max(0, Math.min(at, chapters.length - 2)), at + 2).slice(0, 2).map(item => item.chapterId)
  })
  const [line, setLine] = useState(''), [focus, setFocus] = useState(''), [query, setQuery] = useState(''), [page, setPage] = useState(0)
  const [phase, setPhase] = useState('scope'), [preview, setPreview] = useState(null), [view, setView] = useState(null), [records, setRecords] = useState(null)
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [active, setActive] = useState(''), [issuePage, setIssuePage] = useState(0), [refresh, setRefresh] = useState(0)
  const [stopping, setStopping] = useState(false), stopPending = useRef(false)
  const pending = useRef(null), mounted = useRef(true), request = useRef(null), decisions = useRef(new Map()), candidates = useRef(new Map()), root = useRef(null)
  const scope = () => ({ workspaceId, bookId: book.bookId, expectedRevision: book.revision, chapterIds: line ? [] : ids, storylineId: line, focus })
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort() } }, [])
  useEffect(() => { setPreview(null); if (phase === 'preview') setPhase('scope') }, [book.revision])
  useEffect(() => { const body = root.current?.closest('.sn-panel-body'); if (body) body.scrollTop = 0 }, [phase, page, issuePage])
  useEffect(() => {
    if (!open || busy) return
    const controller = new AbortController()
    api.bookReviews(sessionId, workspaceId, book.bookId, controller.signal).then(unwrap).then(value => { if (!controller.signal.aborted) setRecords(value) }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    if (view) api.bookReview(sessionId, workspaceId, book.bookId, view.reviewId, controller.signal).then(unwrap).then(value => { if (!controller.signal.aborted) setView(value) }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [open, api, sessionId, workspaceId, book.bookId, book.revision, revisionHint, busy, refresh])
  const perform = async (kind, work) => {
    if (pending.current) return
    const controller = new AbortController(); pending.current = controller; setBusy(kind); setError('')
    try { await work(controller.signal) } catch (error) { if (mounted.current) setError(controller.signal.aborted ? 'book-review-stopped' : error.reason ?? 'storage-failed') }
    finally { if (pending.current === controller) pending.current = null; if (mounted.current) { setBusy(''); setRefresh(value => value + 1) } }
  }
  const showResult = value => { setView(value); setPhase('result'); setActive(value.issues[0]?.issueId ?? ''); setIssuePage(0) }
  const inspect = () => perform('preview', async signal => {
    await beforeGenerate()
    const value = unwrap(await api.previewBookReview(sessionId, scope(), signal))
    if (mounted.current) { setPreview({ value, scope: scope() }); request.current = null; setPhase('preview') }
  })
  const start = () => perform('run', async signal => {
    await beforeGenerate()
    if (!request.current) request.current = { ...preview.scope, reviewId: crypto.randomUUID(), previewHash: preview.value.previewHash, maxCalls: 1 }
    setPhase('result'); setView(null)
    try { const value = unwrap(await api.reviewBookRange(sessionId, request.current, signal)); if (mounted.current) showResult(value) }
    finally {
      // Query after a lost reply, never resend. The reservation also survives a page reload.
      if (mounted.current) {
        try { const value = unwrap(await api.bookReview(sessionId, workspaceId, book.bookId, request.current.reviewId, new AbortController().signal)); if (mounted.current) showResult(value) }
        catch (error) { if (mounted.current) setError(error.reason ?? 'storage-failed') }
      }
    }
  })
  const reopen = id => perform('read', async signal => { const value = unwrap(await api.bookReview(sessionId, workspaceId, book.bookId, id, signal)); if (mounted.current) showResult(value) })
  const stop = async reviewId => {
    if (stopPending.current || !reviewId) return
    const independent = !pending.current
    stopPending.current = true; setStopping(true); if (independent) setBusy('stop')
    try {
      const value = unwrap(await api.stopBookReview(sessionId, workspaceId, book.bookId, reviewId, new AbortController().signal))
      if (mounted.current) { showResult(value); pending.current?.abort() }
    } catch (error) { if (mounted.current) setError(error.reason ?? 'storage-failed') }
    finally { stopPending.current = false; if (mounted.current) { setStopping(false); if (independent) setBusy('') } }
  }
  const decide = (issue, action) => perform('decision', async signal => {
    const key = `${view.reviewId}:${issue.issueId}:${action}`
    if (!decisions.current.has(key)) decisions.current.set(key, crypto.randomUUID())
    const value = unwrap(await api.decideBookIssue(sessionId, { workspaceId, bookId: book.bookId, reviewId: view.reviewId, issueId: issue.issueId, resultHash: view.resultHash, operationId: decisions.current.get(key), action }, signal))
    if (mounted.current) setView(value)
  })
  const revise = issue => perform('revision', async signal => {
    await beforeGenerate()
    const key = `${view.reviewId}:${issue.issueId}`
    if (!candidates.current.has(key)) candidates.current.set(key, crypto.randomUUID())
    const value = unwrap(await api.reviseBookIssue(sessionId, { workspaceId, bookId: book.bookId, reviewId: view.reviewId, issueId: issue.issueId, proposalId: candidates.current.get(key) }, signal))
    await revised(issue.targetChapterId, value.proposalId)
  })
  const newScope = () => { request.current = null; setPreview(null); setPhase('scope'); setError('') }
  const filtered = chapters.filter(item => item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const selected = line ? chapters.filter(item => item.structure?.storylineIds.includes(line)) : chapters.filter(item => ids.includes(item.chapterId))
  return <div ref={root} className="sn-book-reviews" data-phase={phase} data-busy={busy || undefined}>
    <p className="sn-review-steps" aria-label={t('brSteps')}>{t('brStep-' + phase)}</p>
    {error && <p role="alert">{t(error)}</p>}
    {busy && <div className="sn-row" role="status"><span>{t(stopping ? 'brStopping' : 'brBusy-' + busy)}</span>{busy === 'run' && <Button size="sm" disabled={stopping} onClick={() => stop(request.current?.reviewId)}>{t('stop')}</Button>}</div>}
    {phase === 'scope' && <>
      <p className="sn-notice">{t('brScopeHint')}</p>
      {!!book.storylines?.length && <Select aria-label={t('brRange')} value={line} disabled={!!busy} onChange={event => { setLine(event.target.value); setPage(0) }}><option value="">{t('brSelectChapters')}</option>{book.storylines.map(item => <option key={item.storylineId} value={item.storylineId}>{item.title}</option>)}</Select>}
      <p className="sn-review-selection" role="status">{selected.length} / 20 {t('brSelected')}</p>
      {!line && <>
        <Input className="sn-input" type="search" aria-label={t('brSearch')} placeholder={t('brSearch')} value={query} onChange={event => { setQuery(event.target.value); setPage(0) }} />
        <div className="sn-review-chapters">{filtered.slice(page * 20, (page + 1) * 20).map(item => <label key={item.chapterId}><input type="checkbox" checked={ids.includes(item.chapterId)} disabled={!!busy || !ids.includes(item.chapterId) && ids.length >= 20} onChange={event => setIds(values => event.target.checked ? [...values, item.chapterId] : values.filter(id => id !== item.chapterId))} /><span>{chapters.indexOf(item) + 1}. {item.title}</span></label>)}</div>
        {!filtered.length && <p>{t('noMatchingDocuments')}</p>}
        {filtered.length > 20 && <nav className="sn-pagination"><Button size="sm" disabled={!page} onClick={() => setPage(value => value - 1)}>{t('previousPage')}</Button><span>{page + 1} / {Math.ceil(filtered.length / 20)}</span><Button size="sm" disabled={(page + 1) * 20 >= filtered.length} onClick={() => setPage(value => value + 1)}>{t('nextPage')}</Button></nav>}
        <details><summary>{t('brSelectedTitles')} ({selected.length})</summary><ol>{selected.map(item => <li key={item.chapterId}>{item.title}</li>)}</ol></details>
      </>}
      <label className="sn-review-focus-label">{t('brFocus')}<Input className="sn-input" aria-label={t('brFocus')} placeholder={t('brFocusHint')} value={focus} maxLength={4000} disabled={!!busy} onChange={event => setFocus(event.target.value)} /></label>
      <Button variant="primary" size="sm" disabled={!!busy || book.recoveryRequired || selected.length < 2 || selected.length > 20} onClick={inspect}>{t('brPreview')}</Button>
    </>}
    {phase === 'preview' && preview && <>
      <p className="sn-notice">{t('brSavedOnly')}</p>
      <div className="sn-review-budget" role="status"><strong>{preview.value.chapters.length} / {preview.value.totalChapters} {t('chapters')}</strong><span>{(preview.value.bytes / 1024).toFixed(1)} / 256 KiB</span><span>{t('brOneCall')}</span></div>
      {!preview.value.ready && <p role="alert">{t('context-too-large')}</p>}
      {!preview.value.complete && <p role="status">{t('book-review-sources-incomplete')}</p>}
      {!preview.value.contiguous && <p role="status">{t('book-review-range-gaps')}</p>}
      <div className="sn-row sn-review-primary-actions"><Button size="sm" disabled={!!busy} onClick={newScope}>{t('brChangeScope')}</Button><Button variant="primary" size="sm" disabled={!!busy || !writable || !preview.value.ready} onClick={start}>{t('brStart')}</Button></div>
      <details className="sn-review-saved-sources"><summary>{t('brSavedSources')} ({preview.value.chapters.length})</summary>{preview.value.chapters.map(item => <div className="sn-row" key={item.chapterId}><Button size="sm" onClick={() => navigate({ chapterId: item.chapterId, hash: item.hash })}>{item.title}</Button><small>v{item.revision}</small></div>)}</details>
      <details><summary>{t('brSupportingSources')} ({preview.value.sources.length})</summary><p className="sn-notice">{t('brSourcesHint')}</p>{preview.value.sources.map((item, at) => <details className="sn-review-source" key={at}><summary>{t('brSource-' + item.kind)} · {item.title} · {t('brSourceState-' + item.state)}</summary><pre className="sn-reference-text">{item.content || t('emptyReference')}</pre></details>)}</details>
    </>}
    {phase === 'result' && <>
      {view && <>
        <div className="sn-review-budget" role="status"><strong>{t('review-' + (view.state === 'checked' ? 'passed' : view.state))}</strong><span>{view.chapters.length} / {view.totalChapters} {t('chapters')} · {view.issues.length} {t('brIssues')}</span><small>{new Date(view.createdAt).toLocaleString()}</small></div>
        <p className="sn-notice">{t('brScopedResult')}</p>
        {!!view.reason && <p role="status">{t(view.reason)}</p>}
        <div className="sn-review-dimensions">{view.dimensions.map(item => <span key={item.dimension}>{t('brDimension-' + item.dimension)} · {t('brState-' + item.state)}</span>)}</div>
        {!!view.unknowns.length && <details><summary>{t('brUnknowns')} ({view.unknowns.length})</summary><ul>{view.unknowns.map((item, at) => <li key={at}>{t(item)}</li>)}</ul></details>}
        {!view.issues.length && <p>{t('brNoIssues')}</p>}
        <div className="sn-review-checklist">{view.issues.slice(issuePage * 10, (issuePage + 1) * 10).map(issue => <details className="sn-review-issue" key={issue.issueId} data-issue-id={issue.issueId} open={active === issue.issueId}>
          <summary onClick={event => { event.preventDefault(); setActive(value => value === issue.issueId ? '' : issue.issueId) }}><span>{t('brDimension-' + issue.dimension)} · {t('brDecision-' + issue.decision)}</span><strong>{issue.message}</strong></summary>
          <p>{issue.suggestion}</p><h4>{t('brEvidence')}</h4>
          {issue.evidence.map((item, at) => <div className="sn-review-evidence" key={at}><Button size="sm" onClick={() => navigate(item)}>{view.chapters.find(chapter => chapter.chapterId === item.chapterId)?.title ?? item.chapterId}</Button><blockquote>{item.quote}</blockquote></div>)}
          {issue.impact && <p><strong>{t('brImpact')}</strong> {issue.impact}</p>}{issue.authorQuestion && <p><strong>{t('brAuthorQuestion')}</strong> {issue.authorQuestion}</p>}
          <p className="sn-notice">{t('brTarget')} {view.chapters.find(item => item.chapterId === issue.targetChapterId)?.title ?? issue.targetChapterId}</p>
          {issue.decision === 'unconfirmed' ? <div className="sn-row"><Button size="sm" disabled={!!busy || !writable || view.state === 'expired'} onClick={() => decide(issue, 'confirm')}>{t('brConfirm')}</Button><Button size="sm" disabled={!!busy || !writable} onClick={() => decide(issue, 'dismiss')}>{t('brDismiss')}</Button></div> : issue.decision === 'confirmed' && <><p className="sn-notice">{t('brRevisionHint')}</p><Button variant="primary" size="sm" disabled={!!busy || !writable || view.state === 'expired'} onClick={() => revise(issue)}>{t('brRevise')}</Button></>}
        </details>)}</div>
        {view.issues.length > 10 && <nav className="sn-pagination"><Button size="sm" disabled={!issuePage} onClick={() => setIssuePage(value => value - 1)}>{t('previousPage')}</Button><span>{issuePage + 1} / {Math.ceil(view.issues.length / 10)}</span><Button size="sm" disabled={(issuePage + 1) * 10 >= view.issues.length} onClick={() => setIssuePage(value => value + 1)}>{t('nextPage')}</Button></nav>}
        <Button size="sm" disabled={!!busy} onClick={() => reopen(view.reviewId)}>{t('brRecheck')}</Button>
        {!view.calls && !view.issues.length && <Button size="sm" disabled={!!busy || !writable} onClick={() => stop(view.reviewId)}>{t('brStopExisting')}</Button>}
      </>}
      {!busy && <div className="sn-row"><Button size="sm" onClick={newScope}>{t('brNewReview')}</Button></div>}
    </>}
    <details className="sn-review-records"><summary>{t('brRecords')}</summary><p className="sn-notice">{t('brRecordsHint')}</p><Button size="sm" disabled={!!busy} onClick={() => setRefresh(value => value + 1)}>{t('refresh')}</Button>{records && !records.complete && <p role="status">{t('brRecordsIncomplete')} · {records.unreadable} {t('inboxUnreadable')}</p>}{records && !records.items.length && <p>{t('brNoRecords')}</p>}{records?.items.map(item => <Button className="sn-review-record" size="sm" key={item.reviewId} disabled={!!busy} onClick={() => reopen(item.reviewId)}><span>{new Date(item.createdAt).toLocaleString()} · {item.reviewId.slice(0, 8)}</span><small>{item.chapters.length} {t('chapters')} · {t('review-' + (item.state === 'checked' ? 'passed' : item.state))}</small></Button>)}</details>
  </div>
}
