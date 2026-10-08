import React, { useEffect, useRef, useState } from 'react'
import { Select } from './controls.js'
import { Button, Input } from './primitives.js'
import { unwrap } from './books.js'
export function Voices({ api, sessionId, book, chapterId, entry, selection, writable, dirty, t, changed }) {
  const [items, setItems] = useState([]), [channel, setChannel] = useState('narration'), [characterId, setCharacterId] = useState('')
  const [description, setDescription] = useState(''), [authorized, setAuthorized] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const pending = useRef(null), ids = useRef(new Map())
  useEffect(() => {
    const controller = new AbortController()
    api.voiceSamples(sessionId, book.bookId, controller.signal).then(unwrap).then(value => { if (!controller.signal.aborted) setItems(value) }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [api, sessionId, book.bookId, book.revision])
  useEffect(() => () => pending.current?.abort(), [])
  const action = async fn => {
    if (pending.current) return
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError('')
    try { const value = unwrap(await fn(controller.signal)); if (!controller.signal.aborted) { changed(value); setAuthorized(false) } }
    catch (error) { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') }
    finally { pending.current = null; if (!controller.signal.aborted) setBusy(false) }
  }
  const id = value => { const key = JSON.stringify(value); if (!ids.current.has(key)) ids.current.set(key, crypto.randomUUID()); return ids.current.get(key) }
  return <section className="sn-voices" aria-label={t('voices')}><h3>{t('voices')}</h3>{error && <p role="alert">{t(error)}</p>}
    <label className="sn-field">{t('voiceChannel')}<Select aria-label={t('voiceChannel')} value={channel} onChange={event => { setChannel(event.target.value); setCharacterId('') }}><option value="narration">{t('narration')}</option><option value="dialogue">{t('dialogue')}</option></Select></label>
    {channel === 'dialogue' && <label className="sn-field">{t('character')}<Select aria-label={t('voiceCharacter')} value={characterId} onChange={event => setCharacterId(event.target.value)}><option value="">{t('none')}</option>{book.chapters.filter(item => item.kind === 'character').map(item => <option key={item.chapterId} value={item.chapterId}>{item.title}</option>)}</Select></label>}
    <label className="sn-field">{t('sampleSource')}<Input className="sn-input" aria-label={t('sampleSource')} maxLength={200} value={description} onChange={event => setDescription(event.target.value)} /></label>
    <label><input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} />{t('sampleAuthorized')}</label>
    <div className="sn-row"><Button size="sm" disabled={!writable || busy || dirty || !entry || !authorized || !description.trim() || selection.end <= selection.start || channel === 'dialogue' && !characterId} onClick={() => action(signal => {
      const request = { bookId: book.bookId, expectedRevision: book.revision, sourceChapterId: chapterId, expectedHash: entry.diskHash, start: selection.start, end: selection.end, channel, characterId, sourceDescription: description, authorized: true }
      return api.authorizeVoice(sessionId, { ...request, operationId: id(request) }, signal)
    })}>{t('authorizeSelection')}</Button></div>
    {items.map(item => <div className="sn-voice" key={item.voiceId}><strong>{item.sourceDescription}</strong><p>{t(item.channel)} · {t(`voice-${item.state}`)}</p><blockquote>{item.sample}</blockquote><Button size="sm" disabled={!writable || busy || !item.authorized} onClick={() => action(signal => api.revokeVoice(sessionId, book.bookId, item.voiceId, book.revision, item.hash, id({ voiceId: item.voiceId, revision: book.revision }), signal))}>{t('revokeVoice')}</Button></div>)}
  </section>
}
