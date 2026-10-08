import React, { useEffect, useRef, useState } from 'react'
import { IconPlusOutline16, IconEditOutline16, IconRefreshOutline16, IconCheckOutline16, IconChevronUpOutline14, IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { Proposals } from './proposals.js'
import { ChapterRecovery, InterruptedRecovery } from './history.js'
import { MaterialCreator } from './material-creator.js'
import { Facts } from './facts.js'
import { Reviews } from './reviews.js'
import { Voices } from './voices.js'
import { Transfer } from './transfer.js'

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
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [documents, setDocuments] = useState('chapters')
  const [preferredProposal, setPreferredProposal] = useState('')
  const [workTab, setWorkTab] = useState(() => { try { const tab = localStorage.getItem('super-novel.workTab'); return ['writing', 'references', 'assessment', 'revisions'].includes(tab) ? tab : 'writing' } catch { return 'writing' } }), [search, setSearch] = useState(''), [directoryPage, setDirectoryPage] = useState(0)
  useEffect(() => { try { localStorage.setItem('super-novel.workTab', workTab) } catch {} }, [workTab])
  const pending = useRef(null)
  const mounted = useRef(true)
  const requestIds = useRef(new Map())
  const sequence = useRef(0)
  const editor = useRef(null)
  const entryIdentity = useRef('')
  const book = library?.books.find(item => item.bookId === bookId)
  const writable = library?.writable && !busy && !book?.recoveryRequired
  const currentChapter = book?.chapters.find(item => item.chapterId === chapterId)
  const planning = currentChapter?.kind && currentChapter.kind !== 'chapter'
  const visible = book?.chapters.filter(item => documents === 'chapters' ? !item.kind || item.kind === 'chapter' : item.kind && item.kind !== 'chapter' && item.kind !== 'facts' && item.kind !== 'voice') ?? []
  const filtered = visible.filter(item => item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  useEffect(() => setDirectoryPage(0), [search, bookId, documents])
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
      if (!library && saved.documents === 'materials') setDocuments('materials')
      setBookId(previous => value.books.some(item => item.bookId === previous) ? previous : value.books.some(item => item.bookId === saved.bookId) ? saved.bookId : value.books[0]?.bookId ?? '')
      setChapterId(previous => previous || saved.chapterId || '')
      setError('')
    }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [api, sessionId, refresh])

  useEffect(() => {
    const controller = new AbortController()
    const generation = ++sequence.current
    const identity = `${library?.workspaceId ?? ''}:${bookId}:${chapterId}`
    if (entryIdentity.current !== identity || !book || book.recoveryRequired) setEntry(null)
    entryIdentity.current = identity
    setSelection({ start: 0, end: 0 })
    if (!book) return () => controller.abort()
    try { localStorage.setItem(`super-novel.selection:${library.workspaceId}`, JSON.stringify({ bookId, chapterId, documents })) } catch {}
    if (book.recoveryRequired) return () => controller.abort()
    if (!book.chapters.some(item => item.chapterId === chapterId)) {
      setChapterId(visible[0]?.chapterId ?? '')
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
  }, [api, sessionId, bookId, chapterId, book?.revision, book?.recoveryRequired, refresh, documents])

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

  const proposals = entry && <Proposals key={`${bookId}:${chapterId}`} api={api} sessionId={sessionId} book={book} chapterId={chapterId} entry={entry} writable={writable} dirty={dirty} selection={selection} t={t} revisionHint={refresh} preferredProposal={preferredProposal} adopted={() => setRefresh(value => value + 1)} />

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
      <Transfer api={api} sessionId={sessionId} book={book} writable={library.writable && !busy} t={t} imported={value => { applyBook(value); setChapterId(value.chapters[0]?.chapterId ?? ''); setDocuments('chapters'); setWorkTab('writing') }} />
      {book?.recoveryRequired && <button disabled={busy || !library.writable} onClick={() => action(async signal => applyBook(unwrap(await api.recoverBook(sessionId, bookId, signal))))}>{t('recover')}</button>}
      {book?.recoveryRequired && <InterruptedRecovery key={bookId} api={api} sessionId={sessionId} bookId={bookId} writable={library.writable && !busy} t={t} saved={applyBook} />}
      {book && !book.recoveryRequired && <>
        <div className="sn-modes" role="tablist" aria-label={t('documentView')}>{['chapters', 'materialsView'].map((value, index) => <button role="tab" key={value} disabled={busy} aria-selected={documents === (index ? 'materials' : 'chapters')} onClick={() => { setDocuments(index ? 'materials' : 'chapters'); setChapterId(''); setWorkTab('writing') }}>{t(value)}</button>)}</div>
        <input type="search" aria-label={t('searchDocuments')} value={search} onChange={event => setSearch(event.target.value)} />
        <nav className="sn-chapters" aria-label={t('chapter')}>
          {!visible.length && <p>{t(documents === 'chapters' ? 'noChapters' : 'noMaterials')}</p>}
          {filtered.slice(directoryPage * 100, directoryPage * 100 + 100).map((item, index) => <button key={item.chapterId} disabled={busy} aria-current={chapterId === item.chapterId ? 'true' : undefined} onClick={() => { setChapterId(item.chapterId); setError(''); setWorkTab('writing') }}><span className="sn-number">{directoryPage * 100 + index + 1}</span><span>{item.title}{item.kind && item.kind !== 'chapter' ? ` · ${t(item.kind)}` : ''}</span></button>)}
        </nav>
        {filtered.length > 100 && <div className="sn-row"><button aria-label={t('previousPage')} disabled={!directoryPage} onClick={() => setDirectoryPage(value => value - 1)}>&lt;</button><span>{directoryPage + 1} / {Math.ceil(filtered.length / 100)}</span><button aria-label={t('nextPage')} disabled={(directoryPage + 1) * 100 >= filtered.length} onClick={() => setDirectoryPage(value => value + 1)}>&gt;</button></div>}
        <div hidden={documents !== 'materials'}><MaterialCreator key={bookId} api={api} sessionId={sessionId} book={book} workspaceId={library.workspaceId} writable={writable} t={t} onBusy={setBusy} created={(value, id, proposalId) => { applyBook(value); setChapterId(id); setPreferredProposal(proposalId); setWorkTab('writing'); setSearch('') }} /></div>
        {documents === 'chapters' && <form className="sn-row" onSubmit={event => { event.preventDefault(); const key = `chapter:${bookId}:${book.revision}:${chapterTitle.trim()}`; if (!requestIds.current.has(key)) requestIds.current.set(key, crypto.randomUUID()); change('create', { chapterId: requestIds.current.get(key), title: chapterTitle }) }}>
          <input aria-label={t('chapterTitle')} placeholder={t('chapterTitle')} value={chapterTitle} maxLength={200} disabled={!writable} onChange={event => setChapterTitle(event.target.value)} />
          <IconButton label={t('createChapter')} icon={IconPlusOutline16} type="submit" disabled={!writable || !chapterTitle.trim()} />
        </form>}
        {currentChapter && <>
          {!planning && <div className="sn-work-tabs" role="tablist" aria-label={t('workspaceViews')} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            const buttons = Array.from(event.currentTarget.querySelectorAll('button')), at = buttons.indexOf(document.activeElement)
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length
            event.preventDefault(); buttons[next].focus(); buttons[next].click()
          }}>{['writing', 'references', 'assessment', 'revisions'].map(tab => <button role="tab" key={tab} id={`sn-tab-${tab}`} aria-controls={`sn-panel-${tab}`} aria-selected={workTab === tab} tabIndex={workTab === tab ? 0 : -1} onClick={() => setWorkTab(tab)}>{t(`tab-${tab}`)}</button>)}</div>}
          <div id="sn-panel-writing" aria-labelledby={planning ? undefined : 'sn-tab-writing'} hidden={!planning && workTab !== 'writing'} role={planning ? undefined : 'tabpanel'}>
          {planning && <>{proposals}<h3 className="sn-material-heading">{t('savedMaterial')}</h3></>}
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
          {entry && (editing ? <textarea ref={editor} aria-label={t(planning ? 'materialText' : 'body')} spellCheck={false} value={entry.content} readOnly={!writable} onSelect={event => setSelection({ start: event.target.selectionStart, end: event.target.selectionEnd })} onChange={event => storeDraft({ ...entry, content: event.target.value, operationId: crypto.randomUUID() })} /> : <pre className="sn-preview" aria-label={t(planning ? 'materialText' : 'body')}>{entry.content}</pre>)}
          <div className="sn-row sn-recovery-actions"><button disabled={!entry || busy} onClick={readDisk}>{t('reloadDisk')}</button><button disabled={!entry} onClick={() => download(entry.content, currentChapter.title)}>{t('exportDraft')}</button></div>
          {entry && <ChapterRecovery key={`history:${bookId}:${chapterId}`} api={api} sessionId={sessionId} book={book} chapterId={chapterId} entry={entry} writable={writable} dirty={dirty} stale={stale} t={t} onBusy={setBusy} saved={() => {
            try { localStorage.removeItem(entryKey) } catch { setError('draftFailed'); return }
            setRefresh(value => value + 1)
          }} />}
          </div>
          <div id="sn-panel-revisions" aria-labelledby="sn-tab-revisions" hidden={planning || workTab !== 'revisions'} role="tabpanel">
          {!planning && proposals}
          </div>
          <div id="sn-panel-references" aria-labelledby="sn-tab-references" hidden={planning || workTab !== 'references'} role="tabpanel">
          {entry && (!currentChapter.kind || currentChapter.kind === 'chapter') && <><Facts key={`facts:${bookId}:${chapterId}`} api={api} sessionId={sessionId} book={book} chapterId={chapterId} entry={entry} selection={selection} writable={writable} dirty={dirty} t={t} revisionHint={refresh} adopted={() => setRefresh(value => value + 1)} locate={(start, end) => { setWorkTab('writing'); setEditing(true); setTimeout(() => { editor.current?.focus(); editor.current?.setSelectionRange(start, end) }, 0) }} /><Voices key={`voices:${bookId}:${chapterId}`} api={api} sessionId={sessionId} book={book} chapterId={chapterId} entry={entry} selection={selection} writable={writable} dirty={dirty} t={t} changed={applyBook} /></>}
          </div>
          <div id="sn-panel-assessment" aria-labelledby="sn-tab-assessment" hidden={planning || workTab !== 'assessment'} role="tabpanel">
          {entry && (!currentChapter.kind || currentChapter.kind === 'chapter') && <Reviews key={`reviews:${bookId}:${chapterId}`} api={api} sessionId={sessionId} book={book} chapterId={chapterId} entry={entry} writable={writable} dirty={dirty} t={t} revisionHint={`${refresh}:${workTab === 'assessment'}`} revised={id => { setPreferredProposal(id); setRefresh(value => value + 1); setWorkTab('revisions') }} locate={(start, end) => { setWorkTab('writing'); setEditing(true); setTimeout(() => { editor.current?.focus(); editor.current?.setSelectionRange(start, end) }, 0) }} />}
          </div>
        </>}
      </>}
    </>}
  </section>
}
