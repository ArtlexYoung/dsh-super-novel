import React, { useEffect, useRef, useState } from 'react'
import { Button } from './primitives.js'
import { Select } from './controls.js'
import { unwrap } from './books.js'

export function CandidateInboxPanel({ api, sessionId, workspaceId, book, open, revisionHint, t, review, organize }) {
  const [kind, setKind] = useState('all'), [cursors, setCursors] = useState(['']), [result, setResult] = useState(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(false)
  const root = useRef(null)
  const cursor = cursors.at(-1)
  useEffect(() => { const body = root.current?.closest('.sn-panel-body'); if (body) body.scrollTop = 0 }, [kind, cursor])
  const running = !!result?.items.some(item => item.state === 'generating')
  useEffect(() => {
    if (!open || !running) return
    const timer = setInterval(() => setRefresh(value => value + 1), 2000)
    return () => clearInterval(timer)
  }, [open, running])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoading(true); setError('')
    api.candidateInbox(sessionId, { workspaceId, bookId: book.bookId, kind, cursor }, controller.signal).then(unwrap)
      .then(value => { if (!controller.signal.aborted) setResult(value) })
      .catch(error => { if (!controller.signal.aborted) { setResult(null); setError(error.reason ?? 'storage-failed') } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [api, sessionId, workspaceId, book.bookId, book.revision, revisionHint, open, kind, cursor, refresh])
  return <section ref={root} className="sn-candidate-inbox">
    <p className="sn-notice">{t('candidateInboxHint')}</p>
    <div className="sn-row sn-recovery-actions"><Select aria-label={t('candidateInboxFilter')} value={kind} onChange={event => { setKind(event.target.value); setCursors(['']); setResult(null) }}>{['all', 'writing', 'facts', 'intent', 'story', 'source'].map(value => <option key={value} value={value}>{t('inbox-' + value)}</option>)}</Select><Button size="sm" disabled={loading} onClick={() => setRefresh(value => value + 1)}>{t('refresh')}</Button></div>
    {error && <p role="alert">{t(error)}</p>}{loading && !result && <p role="status">{t('loading')}</p>}
    {result && <>
      {!result.complete && <p role="status">{t('inboxIncomplete')}{result.unreadable ? ` · ${result.unreadable} ${t('inboxUnreadable')}` : ''}</p>}
      {!result.items.length && <p className="sn-notice">{t(result.nextCursor ? 'inboxNoItemsOnPage' : 'inboxEmpty')}</p>}
      <div className="sn-inbox-items">{result.items.map(item => <article className="sn-review-issue" key={item.key} data-candidate-key={item.key}>
        <small>{t('inbox-' + item.kind)} · {t(item.state)}</small><h3>{item.title}</h3><p className="sn-inbox-excerpt">{item.preview}</p>
        {item.createdAt > 0 && <small>{new Date(item.createdAt).toLocaleString()}</small>}
        {item.state === 'expired' && <p className="sn-notice">{t('inboxExpiredHint')}</p>}
        <Button size="sm" onClick={() => review(item)}>{t(item.kind === 'source' ? 'inboxCheckSource' : 'inboxReview')}</Button>
      </article>)}</div>
      <nav className="sn-pagination" aria-label={t('candidateInboxPages')}><Button size="sm" disabled={loading || cursors.length < 2} onClick={() => setCursors(previous => previous.slice(0, -1))}>{t('previousPage')}</Button><Button size="sm" disabled={loading || !result.nextCursor} onClick={() => setCursors(previous => [...previous, result.nextCursor])}>{t('nextPage')}</Button></nav>
    </>}
    <details><summary>{t('inboxMaterialActions')}</summary><p className="sn-notice">{t('inboxMaterialActionsHint')}</p><Button size="sm" onClick={organize}>{t('newMaterialWithAI')}</Button></details>
  </section>
}
