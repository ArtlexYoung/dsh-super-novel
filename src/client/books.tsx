import React, { useEffect, useRef, useState } from 'react'
import { IconPlusOutline16, IconEditOutline16, IconRefreshOutline16, IconCheckOutline16, IconChevronUpOutline14, IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'

export function unwrap(result) {
  if (!result.ok) {
    const error = new Error(result.error.message)
    error.reason = result.error.details?.reason ?? 'storage-failed'
    throw error
  }
  return result.value
}

function IconButton({ label, icon: Icon, ...props }) {
  return <button type="button" className="sn-icon" title={label} aria-label={label} {...props}><Icon /></button>
}

function draftKey(workspace, bookId, chapterId) { return `super-novel.draft:${workspace}:${bookId}:${chapterId}` }

function download(text, title) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = `${title.replace(/[\\/:*?"<>|]/g, '_')}.md`; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Draft identity and save baselines survive sidebar closure and session switches. */
export function Books({ api, sessionId, t }) {
  const [library, setLibrary] = useState(null)
  const [bookId, setBookId] = useState('')
  const [chapterId, setChapterId] = useState('')
  const [entry, setEntry] = useState(null)
  const [bookTitle, setBookTitle] = useState('')
  const [chapterTitle, setChapterTitle] = useState('')
  const [renameTitle, setRenameTitle] = useState('')
  const [editing, setEditing] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const pending = useRef(null)
  const mounted = useRef(true)
  const requestIds = useRef(new Map())
  const sequence = useRef(0)
  const book = library?.books.find(item => item.bookId === bookId)
  const writable = library?.writable && !busy && !book?.recoveryRequired
  const currentChapter = book?.chapters.find(item => item.chapterId === chapterId)
  const dirty = entry && (entry.content !== entry.diskContent || entry.externallyModified)
  const stale = entry && (entry.bookRevision !== book?.revision || entry.baseHash !== entry.diskHash)
  const entryKey = entry && draftKey(library.workspaceId, bookId, chapterId)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; pending.current?.abort() }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    api.library(sessionId, controller.signal).then(unwrap).then(value => {
      if (controller.signal.aborted) return
      setLibrary(value)
      let saved = {}
      try { saved = JSON.parse(localStorage.getItem(`super-novel.selection:${value.workspaceId}`) || '{}') } catch {}
      setBookId(previous => value.books.some(item => item.bookId === previous) ? previous : value.books.some(item => item.bookId === saved.bookId) ? saved.bookId : value.books[0]?.bookId ?? '')
      setChapterId(previous => previous || saved.chapterId || '')
      setError('')
    }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [api, sessionId, refresh])

  useEffect(() => {
    const controller = new AbortController()
    const generation = ++sequence.current
    setEntry(null)
    if (!book) return () => controller.abort()
    try { localStorage.setItem(`super-novel.selection:${library.workspaceId}`, JSON.stringify({ bookId, chapterId })) } catch {}
    if (book.recoveryRequired) return () => controller.abort()
    if (!book.chapters.some(item => item.chapterId === chapterId)) {
      setChapterId(book.chapters[0]?.chapterId ?? '')
      return () => controller.abort()
    }
    setRenameTitle(book.chapters.find(item => item.chapterId === chapterId).title)
    api.chapter(sessionId, bookId, chapterId, controller.signal).then(unwrap).then(value => {
      if (controller.signal.aborted || sequence.current !== generation) return
      let draft = null
      try { draft = JSON.parse(localStorage.getItem(draftKey(library.workspaceId, bookId, chapterId)) || 'null') } catch {}
      const validDraft = draft?.schemaVersion === 1 && typeof draft.content === 'string' && typeof draft.baseHash === 'string' && Number.isSafeInteger(draft.bookRevision) && typeof draft.operationId === 'string'
      setEntry({ content: validDraft ? draft.content : value.content, diskContent: value.content, diskHash: value.hash,
        baseHash: validDraft ? draft.baseHash : value.hash, bookRevision: validDraft && draft.baseHash !== value.hash ? draft.bookRevision : value.book.revision,
        operationId: validDraft ? draft.operationId : crypto.randomUUID(), externallyModified: value.externallyModified })
      setNotice(validDraft ? 'localDraft' : value.externallyModified ? 'external' : '')
    }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [api, sessionId, bookId, chapterId, book?.revision, book?.recoveryRequired, refresh])

  useEffect(() => {
    const handle = event => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', handle)
    return () => window.removeEventListener('beforeunload', handle)
  }, [dirty])

  useEffect(() => {
    const check = () => { if (!pending.current) setRefresh(value => value + 1) }
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])

  const storeDraft = next => {
    setEntry(next)
    try { localStorage.setItem(entryKey, JSON.stringify({ schemaVersion: 1, content: next.content, baseHash: next.baseHash, bookRevision: next.bookRevision, operationId: next.operationId })) }
    catch { setError('draftFailed') }
  }

  const action = async fn => {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller; setBusy(true); setError(''); setNotice('')
    try { await fn(controller.signal) }
    catch (error) { if (mounted.current && !controller.signal.aborted) setError(error.reason ?? 'storage-failed') }
    finally { pending.current = null; if (mounted.current) setBusy(false) }
  }

  const applyBook = value => {
    if (!mounted.current) return
    setLibrary(previous => ({ ...previous, books: previous.books.some(book => book.bookId === value.bookId) ? previous.books.map(book => book.bookId === value.bookId ? value : book) : [...previous.books, value] }))
    setBookId(value.bookId)
    setRefresh(previous => previous + 1)
  }

  const change = (actionName, extra = {}) => action(async signal => {
    const input = { bookId, expectedRevision: book.revision, action: actionName, chapterId,
      title: '', beforeChapterId: '', content: '', expectedHash: '', ...extra }
    const key = JSON.stringify(input)
    if (!requestIds.current.has(key)) requestIds.current.set(key, crypto.randomUUID())
    const operationId = extra.operationId || requestIds.current.get(key)
    const request = { ...input, operationId }
    const value = unwrap(await api.changeChapter(sessionId, request, signal))
    if (actionName === 'save') {
      try { localStorage.removeItem(entryKey) } catch { setError('draftFailed') }
      setNotice('saved')
    }
    applyBook(value)
    if (actionName === 'create') { setChapterId(request.chapterId); setChapterTitle('') }
  })

  const readDisk = () => {
    if (dirty && !window.confirm(t('discardConfirm'))) return
    try { if (entryKey) localStorage.removeItem(entryKey) } catch { setError('draftFailed'); return }
    setRefresh(value => value + 1)
  }

  const move = direction => {
    const index = book.chapters.findIndex(item => item.chapterId === chapterId)
    const beforeChapterId = direction < 0 ? book.chapters[index - 1].chapterId : book.chapters[index + 2]?.chapterId ?? ''
    change('move', { beforeChapterId })
  }

  return <section className="sn-books" aria-label={t('intro')}>
    <header className="sn-toolbar"><h2>{t('title')}</h2><IconButton label={t('refresh')} icon={IconRefreshOutline16} disabled={busy} onClick={() => setRefresh(value => value + 1)} /></header>
    {error && <p role="alert" className="sn-alert">{t(error)}</p>}
    {!library && !error && <p role="status">{t('loading')}</p>}
    {library && <>
      <div className="sn-workspace">{library.workspace}</div>
      {!library.writable && <p role="status">{t('readOnly')}</p>}
      <label className="sn-field">{t('book')}<select aria-label={t('book')} value={bookId} disabled={busy} onChange={event => { setBookId(event.target.value); setChapterId(''); setError('') }}>
        {!library.books.length && <option value="">{t('noBooks')}</option>}
        {library.books.map(item => <option key={item.bookId} value={item.bookId}>{item.title}</option>)}
      </select></label>
      <form className="sn-row" onSubmit={event => { event.preventDefault(); action(async signal => {
        const key = `create:${bookTitle.trim()}`
        if (!requestIds.current.has(key)) requestIds.current.set(key, crypto.randomUUID())
        const value = unwrap(await api.createBook(sessionId, { title: bookTitle, operationId: requestIds.current.get(key) }, signal))
        applyBook(value); setChapterId(''); setBookTitle(''); requestIds.current.delete(key)
      }) }}>
        <input aria-label={t('bookTitle')} placeholder={t('bookTitle')} maxLength={200} value={bookTitle} disabled={busy || !library.writable} onChange={event => setBookTitle(event.target.value)} />
        <IconButton label={t('createBook')} icon={IconPlusOutline16} type="submit" disabled={busy || !library.writable || !bookTitle.trim()} />
      </form>
      {book?.recoveryRequired && <button disabled={busy || !library.writable} onClick={() => action(async signal => applyBook(unwrap(await api.recoverBook(sessionId, bookId, signal))))}>{t('recover')}</button>}
      {book && !book.recoveryRequired && <>
        <nav className="sn-chapters" aria-label={t('chapter')}>
          {!book.chapters.length && <p>{t('noChapters')}</p>}
          {book.chapters.map((item, index) => <button key={item.chapterId} disabled={busy} aria-current={chapterId === item.chapterId ? 'true' : undefined} onClick={() => { setChapterId(item.chapterId); setError('') }}><span className="sn-number">{index + 1}</span><span>{item.title}</span></button>)}
        </nav>
        <form className="sn-row" onSubmit={event => { event.preventDefault(); const key = `chapter:${bookId}:${book.revision}:${chapterTitle.trim()}`; if (!requestIds.current.has(key)) requestIds.current.set(key, crypto.randomUUID()); change('create', { chapterId: requestIds.current.get(key), title: chapterTitle }) }}>
          <input aria-label={t('chapterTitle')} placeholder={t('chapterTitle')} value={chapterTitle} maxLength={200} disabled={!writable} onChange={event => setChapterTitle(event.target.value)} />
          <IconButton label={t('createChapter')} icon={IconPlusOutline16} type="submit" disabled={!writable || !chapterTitle.trim()} />
        </form>
        {currentChapter && <>
          <div className="sn-row">
            <input aria-label={t('rename')} value={renameTitle} maxLength={200} disabled={!writable} onChange={event => setRenameTitle(event.target.value)} />
            <IconButton label={t('rename')} icon={IconEditOutline16} disabled={!writable || !renameTitle.trim() || renameTitle === currentChapter.title} onClick={() => change('rename', { title: renameTitle })} />
            <IconButton label={t('moveUp')} icon={IconChevronUpOutline14} disabled={!writable || book.chapters[0].chapterId === chapterId} onClick={() => move(-1)} />
            <IconButton label={t('moveDown')} icon={IconChevronDownOutline14} disabled={!writable || book.chapters.at(-1).chapterId === chapterId} onClick={() => move(1)} />
          </div>
          <div className="sn-toolbar sn-editor-toolbar">
            <div className="sn-modes" role="group" aria-label={t('body')}><button aria-pressed={editing} onClick={() => setEditing(true)}>{t('edit')}</button><button aria-pressed={!editing} onClick={() => setEditing(false)}>{t('preview')}</button></div>
            <span role="status">{busy ? t('saving') : dirty ? t('unsaved') : entry ? t('saved') : t('loading')}</span>
            <IconButton label={t('save')} icon={IconCheckOutline16} disabled={!writable || !entry || !dirty || stale} onClick={() => change('save', { content: entry.content, expectedHash: entry.baseHash, expectedRevision: entry.bookRevision, operationId: entry.operationId })} />
          </div>
          {stale && <p role="alert">{t('stale')}</p>}
          {notice && <p className="sn-notice" role="status">{t(notice)}</p>}
          {entry && (editing ? <textarea aria-label={t('body')} spellCheck={false} value={entry.content} readOnly={!writable} onChange={event => storeDraft({ ...entry, content: event.target.value, operationId: crypto.randomUUID() })} /> : <pre className="sn-preview" aria-label={t('body')}>{entry.content}</pre>)}
          <div className="sn-row sn-recovery-actions"><button disabled={!entry || busy} onClick={readDisk}>{t('reloadDisk')}</button><button disabled={!entry} onClick={() => download(entry.content, currentChapter.title)}>{t('exportDraft')}</button></div>
        </>}
      </>}
    </>}
  </section>
}
