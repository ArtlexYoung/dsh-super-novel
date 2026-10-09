import React, { useEffect, useRef, useState } from 'react'
import { Button, Input } from './primitives.js'
import { unwrap } from './books.js'

const fields = ['goal', 'obstacle', 'choice', 'cost', 'outcome', 'viewpoint', 'hardConstraints']
export function ChapterIntent({ api, sessionId, workspaceId, book, chapterId, entry, open, writable, dirty, t, changed }) {
  const key = `super-novel.intent-draft:${workspaceId}:${book.bookId}:${chapterId}`
  const [card, setCard] = useState(null), [intent, setIntent] = useState(null), [baseVersion, setBaseVersion] = useState(0)
  const [suggestions, setSuggestions] = useState([]), [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const pending = useRef(null), live = useRef(true), operation = useRef({ key: '', id: '' })
  useEffect(() => { live.current = true; return () => { live.current = false; pending.current?.abort() } }, [])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    Promise.all([api.chapterIntent(sessionId, book.bookId, chapterId, controller.signal).then(unwrap), api.intentSuggestions(sessionId, book.bookId, chapterId, controller.signal).then(unwrap)]).then(([value, directions]) => {
      if (controller.signal.aborted || pending.current) return
      setCard(value); setSuggestions(directions)
      if (intent) return
      let draft
      try { draft = JSON.parse(localStorage.getItem(key) || 'null') } catch { draft = null }
      const validDraft = draft && Number.isInteger(draft.version) && fields.every(field => typeof draft.intent?.[field] === 'string')
      setIntent(validDraft ? draft.intent : value.intent); setBaseVersion(validDraft ? draft.version : value.version)
      if (validDraft) setNotice(draft.version === value.version ? 'intentDraftRestored' : 'intentDraftConflict')
    }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [api, sessionId, book.bookId, chapterId, book.revision, open])
  const update = next => {
    setIntent(next); setNotice('intentUnsaved')
    try { localStorage.setItem(key, JSON.stringify({ version: baseVersion, intent: next })) } catch { setError('localDraftFailed') }
  }
  const action = async fn => {
    if (pending.current) return
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError('')
    try { await fn(controller.signal) } catch (error) { if (live.current && !controller.signal.aborted) setError(error.reason ?? 'storage-failed') }
    finally { pending.current = null; if (live.current) setBusy(false) }
  }
  const request = { workspaceId, bookId: book.bookId, chapterId, expectedVersion: baseVersion, expectedRevision: book.revision, expectedHash: entry.diskHash }
  const identity = data => { const key = JSON.stringify(data); if (operation.current.key !== key) operation.current = { key, id: crypto.randomUUID() }; return operation.current.id }
  const save = () => action(async signal => {
    const input = { ...request, intent }, value = unwrap(await api.saveChapterIntent(sessionId, { ...input, operationId: identity(input) }, signal))
    if (!live.current) return
    setCard(value); setIntent(value.intent); setBaseVersion(value.version); setNotice('intentSaved'); changed()
    try { localStorage.removeItem(key) } catch { /* The authoritative immutable version is already on disk. */ }
  })
  const suggest = () => action(async signal => {
    const input = { ...request, instruction }, value = unwrap(await api.suggestChapterIntent(sessionId, { ...input, proposalId: identity(input) }, signal))
    if (live.current) { setSuggestions(previous => [value, ...previous.filter(item => item.proposalId !== value.proposalId)]); setNotice('intentDirectionsReady') }
  })
  const unsaved = !!card && JSON.stringify(intent) !== JSON.stringify(card.intent)
  const input = field => <label className="sn-field" key={field}>{t('intent-' + field)}{field === 'hardConstraints' ? <textarea className="sn-instruction" aria-label={t('intent-' + field)} maxLength={16384} disabled={busy || !writable} value={intent[field]} onChange={event => update({ ...intent, [field]: event.target.value })} /> : <Input className="sn-input" aria-label={t('intent-' + field)} maxLength={4000} disabled={busy || !writable} value={intent[field]} onChange={event => update({ ...intent, [field]: event.target.value })} />}</label>
  return <section className="sn-intent">
    <p className="sn-notice">{t('intentHint')}</p>{error && <p role="alert">{t(error)}</p>}{notice && <p role="status">{t(notice)}</p>}
    {intent && <>{input('goal')}{input('viewpoint')}<details><summary>{t('intentOptionalFields')}</summary>{['obstacle', 'choice', 'cost', 'outcome', 'hardConstraints'].map(input)}</details>
      <div className="sn-row sn-recovery-actions"><Button size="sm" disabled={!writable || busy || dirty || !unsaved} onClick={save}>{t('saveIntent')}</Button><Button size="sm" disabled={busy || !card} onClick={() => { setIntent(card.intent); setBaseVersion(card.version); setNotice(''); try { localStorage.removeItem(key) } catch {} }}>{t('useSavedIntent')}</Button></div>
      {dirty && <p className="sn-notice">{t('saveBeforeAI')}</p>}
      <details><summary>{t('suggestIntent')}</summary><Input className="sn-input" aria-label={t('intentDirectionInstruction')} value={instruction} maxLength={16384} onChange={event => setInstruction(event.target.value)} /><div className="sn-row"><Button size="sm" disabled={!writable || busy || dirty || unsaved || !instruction.trim()} onClick={suggest}>{t('suggestIntentOnce')}</Button>{busy && <Button size="sm" onClick={() => pending.current?.abort()}>{t('stop')}</Button>}</div><p className="sn-notice">{t('intentCallHint')}</p></details>
      {suggestions.map(value => <details key={value.proposalId} open={value === suggestions[0]}><summary>{t('intentDirections')} · {t(value.state)} · {new Date(value.createdAt).toLocaleString()}</summary>{value.directions.map((direction, index) => <article key={index} className="sn-review-issue"><h3>{t('intentDirection')} {index + 1}</h3>{fields.filter(field => direction[field]).map(field => <p key={field}><strong>{t('intent-' + field)}</strong>：{direction[field]}</p>)}<Button size="sm" disabled={!writable || busy || value.state !== 'review' || value.intentVersion !== baseVersion} onClick={() => update(direction)}>{t('editDirection')}</Button></article>)}<p className="sn-notice">{value.usage.state === 'reported' ? `${t('tokens')} ${value.usage.inputTokens + value.usage.outputTokens}` : t('usageUnknown')} · {value.elapsedMs} ms</p></details>)}
    </>}
  </section>
}
