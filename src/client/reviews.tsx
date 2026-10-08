import React, { useEffect, useRef, useState } from 'react'
import { Select } from './controls.js'
import { Button, Input } from './primitives.js'
import { unwrap } from './books.js'

export function Reviews({ api, sessionId, book, chapterId, entry, writable, dirty, t, revisionHint, locate, revised }) {
  const [items, setItems] = useState([]), [view, setView] = useState(null)
  const [candidates, setCandidates] = useState([]), [proposalId, setProposalId] = useState('')
  const [limits, setLimits] = useState({ minCharacters: 0, maxCharacters: 0, minParagraphs: 0, maxParagraphs: 0 })
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const [evidence, setEvidence] = useState(''), evidenceEditor = useRef(null)
  const pending = useRef(null), live = useRef(true), identities = useRef(new Map())
  useEffect(() => { live.current = true; return () => { live.current = false; pending.current?.abort() } }, [])
  useEffect(() => {
    const controller = new AbortController()
    Promise.all([api.chapterReviews(sessionId, book.bookId, chapterId, controller.signal).then(unwrap), api.proposals(sessionId, book.bookId, chapterId, controller.signal).then(unwrap)]).then(([reviews, candidates]) => {
      if (controller.signal.aborted || pending.current) return
      setItems(reviews); setCandidates(candidates); setView(previous => reviews.find(item => item.reviewId === previous?.reviewId) ?? reviews[0] ?? null)
      setProposalId(previous => candidates.some(item => item.proposalId === previous && ['review', 'generating'].includes(item.state)) ? previous : '')
    }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [api, sessionId, book.bookId, book.revision, chapterId, revisionHint, refresh])
  const running = candidates.some(item => item.state === 'generating')
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setRefresh(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [running])
  const identity = request => { const key = JSON.stringify(request); if (!identities.current.has(key)) identities.current.set(key, crypto.randomUUID()); return identities.current.get(key) }
  const action = async fn => {
    if (pending.current) return
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError('')
    try { await fn(controller.signal) } catch (error) { if (live.current && !controller.signal.aborted) setError(error.reason ?? 'storage-failed') }
    finally { pending.current = null; if (live.current) { setBusy(false); setRefresh(value => value + 1) } }
  }
  const review = () => action(async signal => {
    let expectedHash = entry.diskHash
    if (proposalId) expectedHash = unwrap(await api.proposal(sessionId, book.bookId, proposalId, signal)).candidateHash
    const request = { bookId: book.bookId, chapterId, proposalId, expectedRevision: book.revision, expectedHash, ...limits }
    const result = unwrap(await api.reviewChapter(sessionId, { ...request, reviewId: identity(request) }, signal))
    if (live.current) { setView(result); identities.current.delete(JSON.stringify(request)) }
  })
  const revise = issue => action(async signal => {
    const id = identity({ reviewId: view.reviewId, issueId: issue.issueId })
    const result = unwrap(await api.reviseIssue(sessionId, book.bookId, view.reviewId, issue.issueId, id, signal))
    if (live.current) { setProposalId(result.proposalId); revised(result.proposalId) }
  })
  const locateIssue = issue => {
    if (!view.proposalId) { locate(issue.start, issue.end); return }
    action(async signal => {
      const candidate = unwrap(await api.proposal(sessionId, book.bookId, view.proposalId, signal))
      if (candidate.candidateHash !== view.textHash) throw { reason: 'review-stale' }
      if (live.current) {
        setEvidence(candidate.candidate)
        setTimeout(() => { evidenceEditor.current?.focus(); evidenceEditor.current?.setSelectionRange(issue.start, issue.end) }, 0)
      }
    })
  }
  return <section className="sn-reviews" aria-label={t('reviews')}>
    <h3>{t('reviews')}</h3>{error && <p role="alert">{t(error)}</p>}
    <label className="sn-field">{t('reviewTarget')}<Select aria-label={t('reviewTarget')} value={proposalId} onChange={event => setProposalId(event.target.value)}><option value="">{t('savedChapter')}</option>{candidates.filter(item => ['review', 'generating'].includes(item.state)).map(item => <option key={item.proposalId} value={item.proposalId}>{t(item.mode)} · {t(item.state)} · {new Date(item.createdAt).toLocaleString()}</option>)}</Select></label>
    <details><summary>{t('mechanicalLimits')}</summary><div className="sn-limits">{Object.entries(limits).map(([key, value]) => <label className="sn-field" key={key}>{t(key)}<Input className="sn-input" type="number" min={0} max={key.includes('Paragraphs') ? 100000 : 4000000} step={1} aria-label={t(key)} value={value} onChange={event => setLimits(previous => ({ ...previous, [key]: Number(event.target.value) }))} /></label>)}</div></details>
    <div className="sn-row"><Button size="sm" disabled={!writable || busy || dirty || !!proposalId && !candidates.some(item => item.proposalId === proposalId && item.state === 'review')} onClick={review}>{t('runReview')}</Button>{busy && <Button size="sm" onClick={() => pending.current?.abort()}>{t('stop')}</Button>}</div>
    {!!items.length && <label className="sn-field">{t('reviewRecords')}<Select aria-label={t('reviewRecords')} value={view?.reviewId ?? ''} onChange={event => setView(items.find(item => item.reviewId === event.target.value))}>{items.map(item => <option key={item.reviewId} value={item.reviewId}>{new Date(item.createdAt).toLocaleString()} · {t(`review-${item.state}`)}</option>)}</Select></label>}
    {view && <><p className="sn-review-status" role="status">{t(`review-${view.state}`)} · {view.characters} {t('characters')} · {view.paragraphs} {t('paragraphs')}</p>
      {view.reason && <p role="status">{t(view.reason)}</p>}
      <div className="sn-review-dimensions">{view.dimensions.map(item => <span key={item.dimension}>{t(item.dimension)}: {t(`dimension-${item.state}`)}</span>)}</div>
      {view.issues.map(issue => <div className="sn-review-issue" key={issue.issueId}><p>{t(issue.message)} · {t(issue.dimension)}</p>{issue.suggestion && <p>{issue.suggestion}</p>}<blockquote>{issue.quote}</blockquote><div className="sn-row"><Button size="sm" disabled={busy || dirty || view.state === 'expired'} onClick={() => locateIssue(issue)}>{t('locateEvidence')}</Button><Button size="sm" disabled={!writable || dirty || busy || view.state === 'expired' || issue.start === issue.end} onClick={() => revise(issue)}>{t('reviseIssue')}</Button></div></div>)}
    </>}
    {evidence && <textarea ref={evidenceEditor} readOnly aria-label={t('reviewEvidence')} value={evidence} />}
  </section>
}
