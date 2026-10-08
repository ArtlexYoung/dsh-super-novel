import React, { useEffect, useRef, useState } from 'react'
import { Select } from './controls.js'
import { Button, Input, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { unwrap } from './books.js'
import { materialInstruction, materialKinds, materialSources, materialTemplate } from './materials.js'

function retainedDraft(key, bookId) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}')
    if (value.schemaVersion === 1 && materialKinds.includes(value.kind) && typeof value.title === 'string' && value.title.length <= 200 &&
      typeof value.instruction === 'string' && value.instruction.length <= 15000 && Array.isArray(value.sourceIds) && value.sourceIds.every(id => typeof id === 'string') && typeof value.linkedChapterId === 'string') {
      const tx = value.transaction
      if (tx && (typeof tx.key !== 'string' || typeof tx.generate !== 'boolean' || tx.createRequest?.bookId !== bookId ||
        typeof tx.createRequest?.chapterId !== 'string' || typeof tx.createRequest?.operationId !== 'string' ||
        tx.createdBook && (tx.createdBook.bookId !== bookId || !Array.isArray(tx.createdBook.chapters) || !Number.isSafeInteger(tx.createdBook.revision)))) value.transaction = null
      return value
    }
  } catch {}
  return { kind: 'seed', title: '', instruction: '', sourceIds: [], linkedChapterId: '' }
}

/** Creation and generation have separate receipts. Retain both identities for a lost response or reload. */
export function MaterialCreator({ api, sessionId, book, workspaceId, writable, t, onBusy, created }) {
  const storageKey = `super-novel.materialDraft:${workspaceId}:${book.bookId}`
  const [draft] = useState(() => retainedDraft(storageKey, book.bookId))
  const [kind, setKind] = useState(draft.kind), [title, setTitle] = useState(draft.title)
  const [instruction, setInstruction] = useState(draft.instruction)
  const [sourceIds, setSourceIds] = useState(draft.sourceIds), [linkedChapterId, setLinkedChapterId] = useState(draft.linkedChapterId)
  const [open, setOpen] = useState(!materialSources(book).length || !!draft.transaction)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const pending = useRef(null), mounted = useRef(true), transaction = useRef(draft.transaction ?? null)
  const language = t('templateLanguage')
  const sources = materialSources(book)
  const chapters = book.chapters.filter(item => !item.kind || item.kind === 'chapter')
  const retained = !!transaction.current
  const persist = () => {
    try { localStorage.setItem(storageKey, JSON.stringify({ schemaVersion: 1, kind, title, instruction, sourceIds, linkedChapterId, transaction: transaction.current })) }
    catch { setError('draftFailed') }
  }
  useEffect(persist, [kind, title, instruction, sourceIds, linkedChapterId])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; pending.current?.abort(); onBusy(false) }
  }, [])

  const create = async generate => {
    if (pending.current || !writable) return
    const controller = new AbortController()
    pending.current = controller; setBusy(true); onBusy(true); setError('')
    const key = JSON.stringify({ kind, title, instruction, sourceIds, linkedChapterId, generate, language })
    if (!transaction.current) {
      let name = title.trim()
      if (!name) {
        name = t(kind)
        let number = 2
        while (book.chapters.some(item => item.title === name)) name = `${t(kind)} ${number++}`
      }
      transaction.current = { key, generate, createRequest: { bookId: book.bookId, expectedRevision: book.revision,
        action: 'create', chapterId: crypto.randomUUID(), operationId: crypto.randomUUID(), title: name, kind,
        content: generate ? '' : materialTemplate(kind, language), expectedHash: '', beforeChapterId: '',
        ...((kind === 'chapter-outline' || kind === 'scene') && linkedChapterId ? { linkedChapterId } : {}) } }
    }
    const tx = transaction.current
    persist()
    try {
      if (!tx.createdBook) {
        tx.createdBook = unwrap(await api.changeChapter(sessionId, tx.createRequest, controller.signal))
        persist()
      }
      if (mounted.current) created(tx.createdBook, tx.createRequest.chapterId, '', generate)
      if (generate) {
        if (!tx.generateRequest) {
          const target = unwrap(await api.chapter(sessionId, book.bookId, tx.createRequest.chapterId, controller.signal))
          if (target.content !== '' || target.externallyModified || target.book.revision !== tx.createdBook.revision) {
            const conflict = new Error('Creation baseline changed'); conflict.reason = 'revision-conflict'; throw conflict
          }
          tx.generateRequest = { proposalId: crypto.randomUUID(), bookId: book.bookId, chapterId: tx.createRequest.chapterId,
            expectedRevision: target.book.revision, expectedHash: target.hash, mode: 'draft', start: 0, end: 0,
            instruction: `${materialInstruction(kind, language)}${instruction.trim() ? `\n\n${instruction.trim()}` : ''}`,
            materials: '', ...(sourceIds.length ? { materialIds: sourceIds } : {}) }
          persist()
        }
        const proposal = unwrap(await api.generateChapter(sessionId, tx.generateRequest, controller.signal))
        if (mounted.current) created(tx.createdBook, tx.createRequest.chapterId, proposal.proposalId, true)
      }
      if (mounted.current) {
        transaction.current = null; setTitle(''); setInstruction(''); setSourceIds([]); setLinkedChapterId(''); setOpen(false)
        persist()
      }
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setError(error.reason ?? 'storage-failed')
    } finally {
      pending.current = null
      if (mounted.current) { setBusy(false); onBusy(false) }
    }
  }
  const reset = () => { transaction.current = null; setTitle(''); setInstruction(''); setSourceIds([]); setError(''); persist() }
  const select = (id, checked) => setSourceIds(previous => checked ? [...previous, id] : previous.filter(value => value !== id))
  return <details className="sn-material-creator" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><IconPlusOutline16 />{t('newMaterialWithAI')}</summary>
    <p className="sn-notice">{t('materialCreationHint')}</p>
    {error && <p role="alert" className="sn-alert">{t(error)}</p>}
    {retained && <p role="status" className="sn-notice">{t(transaction.current.createdBook ? 'materialCreatedRetry' : 'materialRequestRetry')}</p>}
    <div className="sn-material-basics"><label className="sn-field">{t('materialType')}<Select aria-label={t('materialType')} value={kind} disabled={busy || retained} onChange={event => { setKind(event.target.value); setLinkedChapterId('') }}>{materialKinds.map(value => <option key={value} value={value}>{t(value)}</option>)}</Select></label>
    <label className="sn-field">{t('materialName')}<Input className="sn-input" aria-label={t('materialName')} placeholder={t(kind)} maxLength={200} value={title} disabled={busy || retained} onChange={event => setTitle(event.target.value)} /></label></div>
    {(kind === 'chapter-outline' || kind === 'scene') && <label className="sn-field">{t('relatedChapter')}<Select aria-label={t('relatedChapter')} value={linkedChapterId} disabled={busy || retained} onChange={event => setLinkedChapterId(event.target.value)}><option value="">{t('none')}</option>{chapters.map(item => <option key={item.chapterId} value={item.chapterId}>{item.title}</option>)}</Select></label>}
    <label className="sn-field">{t('materialIdea')}<textarea className="sn-instruction" aria-label={t('materialIdea')} placeholder={t('materialIdeaHint')} maxLength={15000} value={instruction} disabled={busy || retained} onChange={event => setInstruction(event.target.value)} /></label>
    <details><summary>{t('materialSourceSelection')} ({sourceIds.length})</summary>
      {!sources.length && !chapters.length && <p className="sn-notice">{t('noMaterialSources')}</p>}
      {!!sources.length && <div className="sn-material-list"><p>{t('materialsView')}</p>{sources.map(item => <label key={item.chapterId}><input type="checkbox" checked={sourceIds.includes(item.chapterId)} disabled={busy || retained} onChange={event => select(item.chapterId, event.target.checked)} /><span>{item.title} · {t(item.kind)}</span></label>)}</div>}
      {!!chapters.length && <div className="sn-material-list"><p>{t('savedProseSources')}</p>{chapters.map(item => <label key={item.chapterId}><input type="checkbox" checked={sourceIds.includes(item.chapterId)} disabled={busy || retained} onChange={event => select(item.chapterId, event.target.checked)} /><span>{item.title} · {t('chapter')}</span></label>)}</div>}
      <p className="sn-notice">{t('materialSourcesHint')}</p>
    </details>
    <div className="sn-row">
      <Button variant="primary" size="sm" disabled={!writable || busy} onClick={() => create(retained ? transaction.current.generate : true)}>{t(retained ? 'retryMaterialGeneration' : 'createAndGenerate')}</Button>
      {!retained && <Button variant="outline" size="sm" disabled={!writable || busy} onClick={() => create(false)}>{t('createTemplate')}</Button>}
      {retained && <Button size="sm" disabled={busy} onClick={reset}>{t('startAnotherMaterial')}</Button>}
    </div>
  </details>
}
