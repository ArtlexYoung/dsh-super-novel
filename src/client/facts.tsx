import React, { useEffect, useRef, useState } from 'react'
import { unwrap } from './books.js'

export function Facts({ api, sessionId, book, chapterId, entry, selection, writable, dirty, t, revisionHint, adopted, locate }) {
  const [items, setItems] = useState([])
  const [view, setView] = useState(null)
  const [subject, setSubject] = useState('')
  const [predicate, setPredicate] = useState('')
  const [value, setValue] = useState('')
  const [scope, setScope] = useState('reader')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const pending = useRef(null)
  const live = useRef(true)
  const identity = useRef({ key: '', id: '' })
  const characters = book.chapters.filter(item => item.kind === 'character')
  useEffect(() => { live.current = true; return () => { live.current = false; pending.current?.abort() } }, [])
  useEffect(() => {
    const controller = new AbortController()
    api.factProposals(sessionId, book.bookId, chapterId, controller.signal).then(unwrap).then(items => {
      if (controller.signal.aborted || pending.current) return
      setItems(items); setView(previous => items.find(item => item.proposalId === previous?.proposalId) ?? items[0] ?? null)
    }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [api, sessionId, book.bookId, book.revision, chapterId, refresh, revisionHint])
  const action = async fn => {
    if (pending.current) return
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError('')
    try { await fn(controller.signal) }
    catch (error) { if (live.current && !controller.signal.aborted) setError(error.reason ?? 'storage-failed') }
    finally { pending.current = null; if (live.current) { setBusy(false); setRefresh(value => value + 1) } }
  }
  const requestId = request => {
    const key = JSON.stringify(request)
    if (identity.current.key !== key) identity.current = { key, id: crypto.randomUUID() }
    return identity.current.id
  }
  const generate = () => action(async signal => {
    const request = { bookId: book.bookId, sourceChapterId: chapterId, expectedRevision: book.revision, expectedHash: entry.diskHash }
    const result = unwrap(await api.generateFacts(sessionId, { ...request, proposalId: requestId(request) }, signal))
    if (live.current) setView(result)
  })
  const add = () => action(async signal => {
    const previous = items.find(item => item.state === 'accepted')
    const oldFacts = (previous?.facts ?? []).map(({ factId, sourceRevision, sourceHash, ...fact }) => fact)
    const request = { bookId: book.bookId, sourceChapterId: chapterId, expectedRevision: book.revision, expectedHash: entry.diskHash,
      facts: [...oldFacts, { subject, predicate, value, scope: scope === 'reader' ? { kind: 'reader' } : { kind: 'character', characterId: scope }, sourceChapterId: chapterId,
        quote: entry.diskContent.slice(selection.start, selection.end), start: selection.start, end: selection.end }], ...(previous?.summary ? { summary: previous.summary } : {}), coverage: previous?.coverage ?? 'selection' }
    const result = unwrap(await api.proposeFacts(sessionId, { ...request, proposalId: requestId(request) }, signal))
    if (live.current) setView(result)
  })
  const decide = accept => action(async signal => {
    const result = unwrap(await api[accept ? 'acceptFacts' : 'rejectFacts'](sessionId, book.bookId, view.proposalId, view.factsHash, signal))
    if (live.current) { setView(result); if (accept) adopted() }
  })
  return <section className="sn-facts" aria-label={t('facts')}>
    <h3>{t('facts')}</h3>
    {error && <p role="alert">{t(error)}</p>}
    <p role="status">{t(!items.some(item => item.state === 'accepted' && item.coverage === 'chapter') ? 'factsPending' : 'factsAccepted')}</p>
    <div className="sn-row"><button disabled={!writable || dirty || busy || !entry.diskContent.trim()} onClick={generate}>{t('extractFacts')}</button>{busy && <button onClick={() => pending.current?.abort()}>{t('stop')}</button>}</div>
    <details><summary>{t('manualFact')}</summary>
      <label className="sn-field">{t('subject')}<input aria-label={t('subject')} value={subject} onChange={event => setSubject(event.target.value)} /></label>
      <label className="sn-field">{t('predicate')}<input aria-label={t('predicate')} value={predicate} onChange={event => setPredicate(event.target.value)} /></label>
      <label className="sn-field">{t('factValue')}<input aria-label={t('factValue')} value={value} onChange={event => setValue(event.target.value)} /></label>
      <label className="sn-field">{t('knowledgeScope')}<select aria-label={t('knowledgeScope')} value={scope} onChange={event => setScope(event.target.value)}><option value="reader">{t('reader')}</option>{characters.map(item => <option key={item.chapterId} value={item.chapterId}>{item.title}</option>)}</select></label>
      <blockquote>{entry.diskContent.slice(selection.start, selection.end)}</blockquote>
      <button disabled={!writable || busy || dirty || selection.start === selection.end || !subject.trim() || !predicate.trim() || !value.trim()} onClick={add}>{t('saveFactCandidate')}</button>
    </details>
    {!!items.length && <label className="sn-field">{t('factRecords')}<select aria-label={t('factRecords')} value={view?.proposalId ?? ''} onChange={event => setView(items.find(item => item.proposalId === event.target.value))}>{items.map(item => <option key={item.proposalId} value={item.proposalId}>{new Date(item.createdAt).toLocaleString()} · {t(item.state)}</option>)}</select></label>}
    {view && <><p role="status">{t(view.state)}</p>{view.summary && <p>{view.summary.text}</p>}
      {view.facts.map(fact => <div className="sn-fact" key={fact.factId}><p>{fact.subject} · {fact.predicate} · {fact.value}</p><p className="sn-notice">{fact.scope.kind === 'reader' ? t('reader') : characters.find(item => item.chapterId === fact.scope.characterId)?.title ?? t('unknownCharacter')}</p><blockquote>{fact.quote}</blockquote><button disabled={view.state === 'expired'} onClick={() => locate(fact.start, fact.end)}>{t('locateEvidence')}</button></div>)}
      <div className="sn-row"><button disabled={!writable || busy || dirty || view.state !== 'review'} onClick={() => decide(true)}>{t('acceptFacts')}</button><button disabled={!writable || busy || view.state === 'accepted' || view.state === 'rejected'} onClick={() => decide(false)}>{t('reject')}</button></div>
    </>}
  </section>
}
