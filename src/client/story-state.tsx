import React, { useEffect, useRef, useState } from 'react'
import { Button, Input } from './primitives.js'
import { Select } from './controls.js'
import { unwrap } from './books.js'

export function StoryStatePanel({ api, sessionId, workspaceId, book, chapterId, entry, selection, open, writable, dirty, t, changed, locate, openChapter }) {
  const [state, setState] = useState(null), [suggestions, setSuggestions] = useState([]), [impacts, setImpacts] = useState(null)
  const [tab, setTab] = useState('timeline'), [order, setOrder] = useState('narrative'), [character, setCharacter] = useState('')
  const [form, setFormValue] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const pending = useRef(null), live = useRef(true), operation = useRef({ key: '', id: '' })
  const formVersion = useRef(0)
  const setForm = next => {
    if (next && (next.eventId ?? next.foreshadowId) !== (form?.eventId ?? form?.foreshadowId)) formVersion.current = state?.version ?? 0
    setFormValue(next)
  }
  useEffect(() => { live.current = true; return () => { live.current = false; pending.current?.abort() } }, [])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    Promise.all([api.storyState(sessionId, book.bookId, controller.signal).then(unwrap), api.chapterStateSuggestions(sessionId, book.bookId, chapterId, controller.signal).then(unwrap)]).then(([value, candidates]) => {
      if (!controller.signal.aborted && !pending.current) { setState(value); setSuggestions(candidates) }
    }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [api, sessionId, book.bookId, chapterId, book.revision, open])
  const action = async fn => {
    if (pending.current) return
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError('')
    try { await fn(controller.signal) } catch (error) { if (live.current && !controller.signal.aborted) setError(error.reason ?? 'storage-failed') }
    finally { pending.current = null; if (live.current) setBusy(false) }
  }
  const identity = request => { const key = JSON.stringify(request); if (operation.current.key !== key) operation.current = { key, id: crypto.randomUUID() }; return operation.current.id }
  const evidence = () => ({ chapterId, revision: book.chapters.find(item => item.chapterId === chapterId).revision, hash: entry.diskHash, start: selection.start, end: selection.end, quote: entry.diskContent.slice(selection.start, selection.end) })
  const canQuote = !dirty && selection.end > selection.start && selection.end - selection.start <= 8000
  const quote = value => <div className="sn-story-evidence"><blockquote>{value.quote}</blockquote><Button size="sm" disabled={busy} onClick={() => value.chapterId === chapterId ? locate(value.start, value.end) : openChapter(value.chapterId)}>{t('locateEvidence')} · {book.chapters.find(item => item.chapterId === value.chapterId)?.title}</Button></div>
  const save = () => action(async signal => {
    const { kind, ...item } = form, request = { workspaceId, bookId: book.bookId, expectedVersion: formVersion.current, expectedRevision: book.revision, [kind]: item }
    const value = unwrap(await api.saveStoryState(sessionId, { ...request, operationId: identity(request) }, signal))
    if (live.current) { setState(value); setForm(null); changed() }
  })
  const suggest = () => action(async signal => {
    const request = { workspaceId, bookId: book.bookId, chapterId, expectedRevision: book.revision, expectedHash: entry.diskHash }, value = unwrap(await api.suggestChapterState(sessionId, { ...request, proposalId: identity(request) }, signal))
    if (live.current) { setSuggestions(previous => [value, ...previous.filter(item => item.proposalId !== value.proposalId)]); setTab('suggestions') }
  })
  const inspectImpacts = () => action(async signal => { const value = unwrap(await api.chapterImpacts(sessionId, book.bookId, chapterId, signal)); if (live.current) { setImpacts(value); setTab('impacts') } })
  const events = (state?.events ?? []).filter(item => !character || item.changes.some(change => change.characterId === character))
  if (order === 'story') events.sort((a, b) => (a.time.kind === 'known' ? a.time.order : Infinity) - (b.time.kind === 'known' ? b.time.order : Infinity) || a.narrativeOrder - b.narrativeOrder || a.evidence.start - b.evidence.start)
  const newEvent = () => setForm({ kind: 'event', eventId: crypto.randomUUID(), title: '', time: { kind: 'unknown' }, evidence: evidence(), changes: [] })
  const newThread = () => setForm({ kind: 'foreshadow', foreshadowId: crypto.randomUUID(), title: '', note: '', status: 'planned' })
  const changeStatus = status => {
    if (status === 'planned') { const { planted, resolved, ...rest } = form; setForm({ ...rest, status }); return }
    const { resolved, ...rest } = form
    setForm({ ...rest, status, planted: form.planted ?? (canQuote ? evidence() : undefined), ...(status === 'resolved' ? { resolved: form.resolved ?? (canQuote ? evidence() : undefined) } : {}) })
  }
  const validForm = form?.title.trim() && (form.kind === 'event' ? !!form.evidence : form.status === 'planned' || !!form.planted && (form.status !== 'resolved' || !!form.resolved))
  const newChange = () => setForm({ ...form, changes: [...form.changes, { characterId: book.chapters.find(item => item.kind === 'character' && !['archived','trashed'].includes(item.status))?.chapterId ?? '', kind: 'location', value: '' }] })
  const updateChange = (index, key, value) => setForm({ ...form, changes: form.changes.map((item, at) => at === index ? { ...item, [key]: value } : item) })
  return <section className="sn-story-state">
    <p className="sn-notice">{t('storyStateHint')}</p>{error && <p role="alert">{t(error)}</p>}
    <div className="sn-modes">{['timeline','foreshadows','suggestions'].map(value => <Button size="sm" key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{t('story-' + value)}</Button>)}<Button size="sm" disabled={busy} onClick={inspectImpacts}>{t('chapterImpacts')}</Button></div>
    {form ? <fieldset className="sn-story-form" disabled={busy || !writable}><h3>{t('confirmStoryRecord')}</h3><label className="sn-field">{t('storyRecordTitle')}<Input className="sn-input" aria-label={t('storyRecordTitle')} maxLength={200} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></label>
      {form.kind === 'event' ? <>
        {quote(form.evidence)}<Button size="sm" disabled={!canQuote || busy} onClick={() => setForm({ ...form, evidence: evidence() })}>{t('replaceStoryEvidence')}</Button>
        <details><summary>{t('storyTime')}</summary><label className="sn-field"><Select aria-label={t('storyTime')} value={form.time.kind} onChange={event => setForm({ ...form, time: event.target.value === 'unknown' ? { kind: 'unknown' } : { kind: 'known', label: '', order: 0 } })}><option value="unknown">{t('unknownTime')}</option><option value="known">{t('knownTime')}</option></Select></label>{form.time.kind === 'known' && <><Input className="sn-input" aria-label={t('storyTimeLabel')} value={form.time.label} onChange={event => setForm({ ...form, time: { ...form.time, label: event.target.value } })} /><Input className="sn-input" aria-label={t('storyOrderNumber')} type="number" value={form.time.order} onChange={event => setForm({ ...form, time: { ...form.time, order: Number(event.target.value) } })} /></>}</details>
        <details open={form.changes.length > 0}><summary>{t('characterChanges')}</summary>{form.changes.map((change, index) => <div className="sn-review-issue" key={index}><Select aria-label={`${t('changeCharacter')} ${index + 1}`} value={change.characterId} onChange={event => updateChange(index, 'characterId', event.target.value)}>{book.chapters.filter(item => item.kind === 'character' && !['archived','trashed'].includes(item.status)).map(item => <option key={item.chapterId} value={item.chapterId}>{item.title}</option>)}</Select><Select aria-label={`${t('changeKind')} ${index + 1}`} value={change.kind} onChange={event => updateChange(index, 'kind', event.target.value)}>{['location','injury','item','knowledge'].map(kind => <option key={kind} value={kind}>{t('change-' + kind)}</option>)}</Select><Input className="sn-input" aria-label={`${t('changeValue')} ${index + 1}`} maxLength={2000} value={change.value} onChange={event => updateChange(index, 'value', event.target.value)} /><Button size="sm" onClick={() => setForm({ ...form, changes: form.changes.filter((_, at) => at !== index) })}>{t('removeChange')}</Button></div>)}<Button size="sm" disabled={!book.chapters.some(item => item.kind === 'character') || form.changes.length >= 100} onClick={newChange}>{t('addCharacterChange')}</Button></details>
      </> : <><label className="sn-field">{t('foreshadowStatus')}<Select aria-label={t('foreshadowStatus')} value={form.status} onChange={event => changeStatus(event.target.value)}>{['planned','planted','unresolved','resolved'].map(status => <option key={status} value={status}>{t('foreshadow-' + status)}</option>)}</Select></label><Input className="sn-input" aria-label={t('foreshadowNote')} value={form.note} maxLength={8000} onChange={event => setForm({ ...form, note: event.target.value })} />{form.status !== 'planned' && <><h3>{t('plantedEvidence')}</h3>{form.planted && quote(form.planted)}<Button size="sm" disabled={!canQuote || busy} onClick={() => setForm({ ...form, planted: evidence() })}>{t('useSelectionForPlant')}</Button></>}{form.status === 'resolved' && <><h3>{t('resolvedEvidence')}</h3>{form.resolved && quote(form.resolved)}<Button size="sm" disabled={!canQuote || busy} onClick={() => setForm({ ...form, resolved: evidence() })}>{t('useSelectionForResolve')}</Button></>}</>}
      <div className="sn-row"><Button size="sm" disabled={!writable || busy || dirty || !state || !validForm || form.kind === 'event' && form.changes.some(change => !change.value.trim() || !change.characterId)} onClick={save}>{t('confirmStoryRecord')}</Button><Button size="sm" disabled={busy} onClick={() => setForm(null)}>{t('cancel')}</Button></div>
    </fieldset> : <>
      {tab === 'timeline' && <><div className="sn-row sn-recovery-actions"><Button size="sm" disabled={!writable || busy || !state || !canQuote} onClick={newEvent}>{t('selectionToEvent')}</Button><Button size="sm" aria-pressed={order === 'story'} onClick={() => setOrder(value => value === 'story' ? 'narrative' : 'story')}>{t(order === 'story' ? 'storyOrder' : 'narrativeOrder')}</Button></div><Select aria-label={t('filterCharacterChanges')} value={character} onChange={event => setCharacter(event.target.value)}><option value="">{t('allCharacters')}</option>{book.chapters.filter(item => item.kind === 'character').map(item => <option key={item.chapterId} value={item.chapterId}>{item.title}</option>)}</Select>{events.map(item => <article key={item.eventId} className="sn-review-issue"><h3>{item.title}</h3><p>{t(item.time.kind === 'unknown' ? 'unknownTime' : 'knownTime')}{item.time.kind === 'known' ? ` · ${item.time.label} (${item.time.order})` : ''} · {t('story-' + item.state)}</p>{item.changes.map((change,index) => <p key={index}>{book.chapters.find(character => character.chapterId === change.characterId)?.title} · {t('change-' + change.kind)}：{change.value}</p>)}{quote(item.evidence)}<Button size="sm" disabled={!writable || busy} onClick={() => { const { state, narrativeOrder, ...event } = item; setForm({ ...event, kind: 'event' }) }}>{t('editStoryRecord')}</Button></article>)}{!events.length && <p className="sn-notice">{t('noStoryEvents')}</p>}</>}
      {tab === 'foreshadows' && <><Button size="sm" disabled={!writable || busy || !state} onClick={newThread}>{t('planForeshadow')}</Button>{state?.foreshadows.map(item => <article key={item.foreshadowId} className="sn-review-issue"><h3>{item.title}</h3><p>{t('foreshadow-' + item.status)} · {t('story-' + item.state)}</p><p>{item.note}</p>{item.planted && quote(item.planted)}{item.resolved && quote(item.resolved)}<Button size="sm" disabled={!writable || busy} onClick={() => { const { state, ...value } = item; setForm({ ...value, kind: 'foreshadow' }) }}>{t('editStoryRecord')}</Button></article>)}</>}
      {tab === 'suggestions' && <><p className="sn-notice">{t('storySuggestionHint')}</p><Button size="sm" disabled={!writable || busy || dirty} onClick={suggest}>{t('suggestChapterState')}</Button>{suggestions.map(value => <details key={value.proposalId} open><summary>{t('storySuggestions')} · {t(value.state)} · {new Date(value.createdAt).toLocaleString()}</summary>{value.events.map(item => <article className="sn-review-issue" key={item.eventId}><h3>{item.title}</h3>{quote(item.evidence)}<Button size="sm" disabled={!writable || busy || value.state !== 'review' || state?.events.some(event => event.eventId === item.eventId)} onClick={() => setForm({ ...item, kind: 'event' })}>{t('reviewStorySuggestion')}</Button></article>)}{value.foreshadows.map(item => <article className="sn-review-issue" key={item.foreshadowId}><h3>{item.title}</h3>{quote(item.planted)}<Button size="sm" disabled={!writable || busy || value.state !== 'review' || state?.foreshadows.some(thread => thread.foreshadowId === item.foreshadowId)} onClick={() => setForm({ ...item, kind: 'foreshadow' })}>{t('reviewStorySuggestion')}</Button></article>)}<p className="sn-notice">{value.usage.state === 'reported' ? `${t('tokens')} ${value.usage.inputTokens + value.usage.outputTokens}` : t('usageUnknown')} · {value.elapsedMs} ms</p></details>)}</>}
      {tab === 'impacts' && <><p className="sn-notice">{t('impactHint')}</p>{!impacts?.complete && <p role="status">{t('impactIncomplete')}</p>}{impacts?.items.map((item, index) => <p key={index}>{t(item.kind)} · {item.title} · {t('story-' + (item.state === 'expired' ? 'expired' : 'valid'))}</p>)}{impacts?.complete && !impacts.items.length && <p className="sn-notice">{t('noImpacts')}</p>}</>}
    </>}
    {dirty && <p className="sn-notice">{t('saveBeforeAI')}</p>}{busy && <Button size="sm" onClick={() => pending.current?.abort()}>{t('stop')}</Button>}
  </section>
}
