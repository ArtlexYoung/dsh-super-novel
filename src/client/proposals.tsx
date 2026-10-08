import React, { useEffect, useRef, useState } from 'react'
import { Select } from './controls.js'
import { Button, IconCheckOutline16, IconCloseOutline16, IconSparkle16 } from './primitives.js'
import { unwrap } from './books.js'
import { materialInstruction, materialSources } from './materials.js'

export function Proposals({ api, sessionId, book, chapterId, entry, writable, dirty, selection, t, revisionHint, preferredProposal, adopted }) {
  const target = book.chapters.find(item => item.chapterId === chapterId)
  const planning = target?.kind && target.kind !== 'chapter'
  const [items, setItems] = useState([])
  const [proposalId, setProposalId] = useState('')
  const [view, setView] = useState(null)
  const [mode, setMode] = useState('draft')
  const [instruction, setInstruction] = useState('')
  const [generationOpen, setGenerationOpen] = useState(true)
  const [materials, setMaterials] = useState('')
  const [materialIds, setMaterialIds] = useState([])
  const [voices, setVoices] = useState([]), [voiceIds, setVoiceIds] = useState([])
  const [useFacts, setUseFacts] = useState(false)
  const [knowledgeScope, setKnowledgeScope] = useState('reader')
  const [factState, setFactState] = useState(null)
  const [tab, setTab] = useState('candidate')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const pending = useRef(null)
  const requestId = useRef({ key: '', id: '' })
  const mounted = useRef(true)
  const seededProposal = useRef('')
  const generationTouched = useRef(false)
  const running = view?.state === 'generating' || items.some(item => item.state === 'generating')
  useEffect(() => { if (loaded && view && !generationTouched.current) setGenerationOpen(false) }, [loaded])
  useEffect(() => { if (preferredProposal) { setProposalId(preferredProposal); setView(null) } }, [preferredProposal])
  useEffect(() => {
    if (!view || seededProposal.current === view.proposalId || (preferredProposal ? view.proposalId !== preferredProposal : seededProposal.current)) return
    seededProposal.current = view.proposalId
    setMode(view.mode); setInstruction(authorInstruction(view.instruction)); setMaterials(view.materials)
    if (preferredProposal || !generationTouched.current) setGenerationOpen(false)
    setMaterialIds((view.context ?? []).map(item => item.chapterId))
  }, [preferredProposal, view])
  useEffect(() => {
    const controller = new AbortController()
    api.voiceSamples(sessionId, book.bookId, controller.signal).then(unwrap).then(value => { if (!controller.signal.aborted) setVoices(value) }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [api, sessionId, book.bookId, book.revision, revisionHint])
  useEffect(() => {
    if (!useFacts) { setFactState(null); return }
    const controller = new AbortController()
    api.factContext(sessionId, book.bookId, chapterId, knowledgeScope, 131072, controller.signal).then(unwrap).then(value => { if (!controller.signal.aborted) setFactState(value) }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [api, sessionId, book.bookId, book.revision, chapterId, useFacts, knowledgeScope, refresh, revisionHint])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; pending.current?.abort() }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      const list = unwrap(await api.proposals(sessionId, book.bookId, chapterId, controller.signal))
      if (controller.signal.aborted || pending.current) return
      setItems(list)
      const id = list.some(item => item.proposalId === proposalId) ? proposalId : list[0]?.proposalId ?? ''
      setProposalId(id)
      if (!id) { setView(null); setLoaded(true); return }
      const value = unwrap(await api.proposal(sessionId, book.bookId, id, controller.signal))
      if (!controller.signal.aborted && !pending.current) { setView(value); setLoaded(true) }
    }
    load().catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [api, sessionId, book.bookId, book.revision, chapterId, proposalId, refresh, revisionHint])

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setRefresh(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [running])

  const action = async fn => {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller; setBusy(true); setError('')
    try { await fn(controller.signal) }
    catch (error) { if (mounted.current && !controller.signal.aborted) setError(error.reason ?? 'storage-failed') }
    finally { pending.current = null; if (mounted.current) { setBusy(false); setRefresh(value => value + 1) } }
  }
  const generate = () => action(async signal => {
    const selected = mode === 'rewrite' || mode === 'polish'
    const request = { bookId: book.bookId, chapterId, expectedRevision: book.revision, expectedHash: entry.diskHash,
      mode, instruction: planning ? `${materialInstruction(target.kind, t('templateLanguage'))}${instruction.trim() ? `\n\n${instruction.trim()}` : ''}` : instruction, materials, start: selected ? selection.start : mode === 'continue' ? entry.diskContent.length : 0,
      end: selected ? selection.end : entry.diskContent.length, ...(materialIds.length ? { materialIds } : {}), ...(voiceIds.length ? { voiceIds } : {}), ...(useFacts ? { useFacts, knowledgeScope } : {}) }
    const key = JSON.stringify(request)
    if (requestId.current.key !== key) requestId.current = { key, id: crypto.randomUUID() }
    const value = unwrap(await api.generateChapter(sessionId, { ...request, proposalId: requestId.current.id }, signal))
    if (mounted.current) { setView(value); setProposalId(value.proposalId); setGenerationOpen(false); requestId.current = { key: '', id: '' } }
  })
  const decide = accept => action(async signal => {
    const value = unwrap(await api[accept ? 'acceptProposal' : 'rejectProposal'](sessionId,
      { bookId: book.bookId, proposalId: view.proposalId, expectedCandidateHash: view.candidateHash }, signal))
    if (mounted.current) { setView(value); if (accept) adopted() }
  })
  const needsSelection = mode === 'rewrite' || mode === 'polish'
  const authorInstruction = value => {
    if (!planning) return value
    for (const language of ['zh', 'en']) {
      const template = materialInstruction(target.kind, language)
      if (value.startsWith(template)) return value.slice(template.length).trimStart()
    }
    return value
  }
  const canGenerate = loaded && writable && !busy && !dirty && entry && !entry.externallyModified && entry.bookRevision === book.revision && (planning || instruction.trim()) &&
    (!needsSelection || selection.end > selection.start) && !running && (!useFacts || factState?.state === 'complete')
  const incomplete = view?.state === 'interrupted'
  return <section className="sn-proposals" data-loaded={loaded} aria-label={t(planning ? 'materialCandidates' : 'proposals')}>
    <h3>{t(planning ? 'materialCandidates' : 'proposals')}</h3>
    <p className="sn-notice">{t('candidateHint')}</p>
    {!loaded && <p role="status" className="sn-notice">{t('loading')}</p>}
    {view?.state === 'expired' && <Button size="sm" disabled={busy} onClick={() => { setMode(view.mode); setInstruction(authorInstruction(view.instruction)); setMaterials(view.materials); setMaterialIds((view.context ?? []).map(item => item.chapterId)); setGenerationOpen(true) }}>{t('reuseRequirements')}</Button>}
    {error && <p role="alert" className="sn-alert">{t(error)}</p>}
    <details className="sn-generation" open={generationOpen} onToggle={event => setGenerationOpen(event.currentTarget.open)}>
      <summary onClick={() => { generationTouched.current = true }}><IconSparkle16 />{t(view ? 'generateNew' : 'generateSettings')}</summary>
      <label className="sn-field">{t('generationMode')}<Select aria-label={t('generationMode')} value={mode} disabled={busy} onChange={event => setMode(event.target.value)}>
        {['draft', 'continue', 'rewrite', 'polish'].map(value => <option key={value} value={value}>{t(value)}</option>)}
      </Select></label>
      {needsSelection && <p role="status">{selection.end > selection.start ? `${t('selectedRange')} ${selection.end - selection.start}` : t('selectionHint')}</p>}
      <label className="sn-field">{t('instruction')}<textarea className="sn-instruction" aria-label={t('instruction')} placeholder={t(planning ? 'materialInstructionHint' : 'instructionHint')} value={instruction} maxLength={15000} disabled={busy} onChange={event => setInstruction(event.target.value)} /></label>
      <details><summary>{t('materials')}</summary><textarea className="sn-materials" aria-label={t('materials')} value={materials} maxLength={65536} disabled={busy} onChange={event => setMaterials(event.target.value)} /></details>
      <details><summary><span>{t('selectMaterials')}</span>{!!materialIds.length && <span className="sn-source-count">{materialIds.length}</span>}</summary><div className="sn-material-list">{materialSources(book, chapterId).map(item => <label key={item.chapterId}><input type="checkbox" checked={materialIds.includes(item.chapterId)} disabled={busy} onChange={event => setMaterialIds(previous => event.target.checked ? [...previous, item.chapterId] : previous.filter(id => id !== item.chapterId))} /><span>{item.title} · {t(item.kind)}</span></label>)}</div></details>
      {planning && <details><summary>{t('savedProseSources')}</summary><p className="sn-notice">{t('materialSourcesHint')}</p><div className="sn-material-list">{materialSources(book, chapterId, true).filter(item => !item.kind || item.kind === 'chapter').map(item => <label key={item.chapterId}><input type="checkbox" checked={materialIds.includes(item.chapterId)} disabled={busy} onChange={event => setMaterialIds(previous => event.target.checked ? [...previous, item.chapterId] : previous.filter(id => id !== item.chapterId))} /><span>{item.title} · {t('chapter')}</span></label>)}</div></details>}
      <details><summary>{t('selectVoices')}</summary><div className="sn-material-list">{voices.map(item => <label key={item.voiceId}><input type="checkbox" checked={voiceIds.includes(item.voiceId)} disabled={busy || item.state !== 'active'} onChange={event => setVoiceIds(previous => event.target.checked ? [...previous, item.voiceId] : previous.filter(id => id !== item.voiceId))} /><span>{item.sourceDescription} · {t(item.channel)} · {t(`voice-${item.state}`)}</span></label>)}</div></details>
      {(!target?.kind || target.kind === 'chapter') && <div className="sn-fact-settings"><label><input type="checkbox" checked={useFacts} onChange={event => setUseFacts(event.target.checked)} />{t('useFacts')}</label>{useFacts && <><label className="sn-field">{t('knowledgeScope')}<Select aria-label={t('contextScope')} value={knowledgeScope} onChange={event => setKnowledgeScope(event.target.value)}><option value="reader">{t('reader')}</option>{book.chapters.filter(item => item.kind === 'character').map(item => <option key={item.chapterId} value={item.chapterId}>{item.title}</option>)}</Select></label><p role="status">{t(`context-${factState?.state ?? 'loading'}`)}{factState ? ` · ${factState.bytes} B` : ''}</p></>}</div>}
      <div className="sn-row"><Button variant="primary" size="sm" disabled={!canGenerate} onClick={generate}>{t('generate')}</Button>{dirty && <span className="sn-notice">{t('saveFirst')}</span>}</div>
    </details>
    {!!items.length && <label className="sn-field">{t('candidateHistory')}<Select aria-label={t('candidateHistory')} value={proposalId} onChange={event => { setProposalId(event.target.value); setView(null) }}>
      {items.map(item => <option key={item.proposalId} value={item.proposalId}>{t(item.mode)} · {t(item.state)} · {new Date(item.createdAt).toLocaleString()}</option>)}
    </Select></label>}
    {view && <>
      <div className="sn-toolbar sn-candidate-status"><span role="status">{t(view.state)}{view.state === 'generating' ? ` · ${view.generatedCharacters}` : ''}</span>
        {(view.state === 'generating' || incomplete && view.reason === 'host-restarted') && <Button size="sm" disabled={!writable || busy} onClick={() => action(async signal => {
          const value = unwrap(await api.stopProposal(sessionId, book.bookId, view.proposalId, signal))
          if (mounted.current) setView(value)
        })}>{t('stop')}</Button>}
      </div>
      {view.reason && <p role="status" className="sn-notice">{t(view.reason)}</p>}
      <div className="sn-modes" role="group" aria-label={t('candidateView')}>
        <Button size="sm" aria-pressed={tab === 'candidate'} onClick={() => setTab('candidate')}>{t('candidate')}</Button><Button size="sm" aria-pressed={tab === 'diff'} onClick={() => setTab('diff')}>{t('diff')}</Button>
      </div>
      {tab === 'candidate' ? <pre className="sn-candidate" aria-label={t('candidate')}>{view.candidate}</pre> : <div className="sn-diff">
        <div><h4>{t('before')}</h4><pre aria-label={t('before')}>{view.baseline.slice(view.start, view.end)}</pre></div>
        <div><h4>{t('after')}</h4><pre aria-label={t('after')}>{view.replacement}</pre></div>
      </div>}
      <div className="sn-row"><Button variant="primary" size="sm" className="sn-decision" disabled={!writable || busy || dirty || view.state !== 'review' || view.recoveryRequired} onClick={() => decide(true)}><IconCheckOutline16 />{t('accept')}</Button>
        <Button size="sm" className="sn-decision" disabled={!writable || busy || !['review', 'interrupted', 'expired'].includes(view.state) || view.recoveryRequired} onClick={() => decide(false)}><IconCloseOutline16 />{t('reject')}</Button>
      </div>
    </>}
  </section>
}
