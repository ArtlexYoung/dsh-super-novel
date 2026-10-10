import React, { useEffect, useRef, useState } from 'react'
import { Button, IconChevronLeftOutline14, IconChevronRightOutline14 } from './primitives.js'
import { DocumentLinks } from './document-links.js'
import { unwrap } from './books.js'

export function DocumentReader({ api, sessionId, workspaceId, book, target, open, writable, t, back, edit }) {
  const [history, setHistory] = useState([target]), [at, setAt] = useState(0), [view, setView] = useState({ kind: 'loading' }), [retry, setRetry] = useState(0)
  const match = useRef(null), heading = useRef(null)
  const current = history[at]
  const navigate = next => { setHistory(previous => [...previous.slice(0, at + 1), next].slice(-40)); setAt(Math.min(at + 1, 39)) }
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setView({ kind: 'loading' })
    api.documentPreview(sessionId, { workspaceId, bookId: book.bookId, chapterId: current.chapterId, proposalId: current.proposalId ?? '' }, controller.signal).then(unwrap)
      .then(value => { if (!controller.signal.aborted) { setView({ kind: 'ready', value }); heading.current?.focus({ preventScroll: true }) } })
      .catch(error => { if (!controller.signal.aborted) setView({ kind: 'error', reason: error.reason ?? 'storage-failed' }) })
    return () => controller.abort()
  }, [api, sessionId, workspaceId, book.bookId, book.revision, current, open, retry])
  useEffect(() => { if (open && view.kind === 'ready') match.current?.scrollIntoView({ block: 'center' }) }, [view, open])
  const document = view.kind === 'ready' ? view.value.document : false
  const item = document && document.book.chapters.find(item => item.chapterId === current.chapterId)
  const text = document ? view.value.proposal?.candidate ?? document.content : ''
  const stale = document && !current.proposalId && (current.hash && current.hash !== document.hash || current.quote && text.slice(current.start, current.end) !== current.quote)
  const highlighted = document && !stale && !current.proposalId && current.quote && text.slice(current.start, current.end) === current.quote
  return <div className="sn-document-reader">
    <div className="sn-reader-navigation"><Button size="sm" onClick={back}><IconChevronLeftOutline14 />{t('backToList')}</Button><div className="sn-row"><Button size="sm" aria-label={t('readerBack')} disabled={at === 0} onClick={() => setAt(value => value - 1)}><IconChevronLeftOutline14 /></Button><Button size="sm" aria-label={t('readerForward')} disabled={at === history.length - 1} onClick={() => setAt(value => value + 1)}><IconChevronRightOutline14 /></Button></div></div>
    {view.kind === 'loading' && <p role="status">{t('loading')}</p>}
    {view.kind === 'error' && <p role="alert">{t(view.reason)} <Button size="sm" onClick={() => setRetry(value => value + 1)}>{t('refresh')}</Button></p>}
    {document && item && <>
      <h3 ref={heading} tabIndex={-1}>{item.title}</h3><p className="sn-notice">{t(item.kind ?? 'chapter')} · v{item.revision} · {t('savedReferenceHint')}</p>
      {stale && <p role="alert">{t('readerSourceChanged')}</p>}
      {document.externallyModified && <p role="status">{t('external')}</p>}
      {view.value.proposal && <p role="status">{t('candidate')} · {t(view.value.proposal.state)}</p>}
      {stale && current.quote && <blockquote>{current.quote}</blockquote>}
      <pre className="sn-reference-text sn-reader-text">{highlighted ? <>{text.slice(0, current.start)}<mark ref={match}>{text.slice(current.start, current.end)}</mark>{text.slice(current.end)}</> : text || t('emptyReference')}</pre>
      <Button size="sm" disabled={!writable || ['archived', 'trashed'].includes(item.status)} onClick={() => edit(current.chapterId, highlighted ? { hash: document.hash, start: current.start, end: current.end, quote: current.quote } : false, current.proposalId ?? '')}>{t(view.value.proposal ? 'openCandidate' : 'openDocument')}</Button>
      <DocumentLinks book={document.book} item={item} references={view.value.references} t={t} navigate={navigate} />
    </>}
  </div>
}
