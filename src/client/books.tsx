import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Select } from './controls.js'
import { Button, Input, Tag, IconPlusOutline16, IconEditOutline16, IconRefreshOutline16, IconCheckOutline16, IconChevronUpOutline14, IconChevronDownOutline14, IconSparkle16, IconCloseOutline16 } from './primitives.js'
import { Proposals } from './proposals.js'
import { ChapterRecovery, InterruptedRecovery } from './history.js'
import { MaterialCreator } from './material-creator.js'
import { Facts } from './facts.js'
import { Reviews } from './reviews.js'
import { Voices } from './voices.js'
import { Transfer } from './transfer.js'
import { DocumentDirectory } from './document-directory.js'

export function unwrap(result) {
  if (!result.ok) {
    const error = new Error(result.error.message)
    error.reason = result.error.details?.reason ?? 'storage-failed'
    throw error
  }
  return result.value
}

function IconButton({ label, icon: Icon, ...props }) {
  return <Button size="sm" type="button" className="sn-icon" title={label} aria-label={label} {...props}><Icon /></Button>
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
  const [newBookOpen, setNewBookOpen] = useState(false)
  const [documentOptionsOpen, setDocumentOptionsOpen] = useState(false)
  const [chapterTitle, setChapterTitle] = useState('')
  const [renameTitle, setRenameTitle] = useState('')
  const [editing, setEditing] = useState(true)
  const [busy, setBusy] = useState(false)
  const [readingDisk, setReadingDisk] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [documents, setDocuments] = useState('chapters')
  const [materialKind, setMaterialKind] = useState('all')
  const [linkedChapter, setLinkedChapter] = useState('all')
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
  const writable = library?.writable && !busy && !readingDisk && !book?.recoveryRequired
  const currentChapter = book?.chapters.find(item => item.chapterId === chapterId)
  const planning = currentChapter?.kind && currentChapter.kind !== 'chapter'
  const activeTab = planning && !['writing', 'revisions'].includes(workTab) ? 'writing' : workTab
  const visible = book?.chapters.filter(item => documents === 'chapters' ? !item.kind || item.kind === 'chapter' : item.kind && item.kind !== 'chapter' && item.kind !== 'facts' && item.kind !== 'voice') ?? []
  const clearFilters = () => { setSearch(''); setMaterialKind('all'); setLinkedChapter('all'); setDirectoryPage(0) }
  useEffect(() => setDirectoryPage(0), [search, materialKind, linkedChapter, bookId, documents])
  useEffect(clearFilters, [bookId, documents])
  const dirty = entry && (entry.content !== entry.diskContent || entry.externallyModified)
  const stale = entry && (entry.bookRevision !== book?.revision || entry.baseHash !== entry.diskHash)
  const entryKey = entry && draftKey(library.workspaceId, bookId, chapterId)
  const characterCount = useMemo(() => (entry?.content ?? '').replace(/\s/gu, '').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '_').length, [entry?.content])
  useEffect(() => setDocumentOptionsOpen(false), [bookId, chapterId])
  useEffect(() => { if (stale && (entry?.externallyModified || entry?.baseHash !== entry?.diskHash)) setDocumentOptionsOpen(true) }, [stale, entry?.externallyModified, entry?.baseHash, entry?.diskHash])

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
    if (!book) { setReadingDisk(false); return () => controller.abort() }
    try { localStorage.setItem(`super-novel.selection:${library.workspaceId}`, JSON.stringify({ bookId, chapterId, documents })) } catch {}
    if (book.recoveryRequired) { setReadingDisk(false); return () => controller.abort() }
    if (!book.chapters.some(item => item.chapterId === chapterId)) {
      setChapterId(visible[0]?.chapterId ?? '')
      setReadingDisk(false)
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
      setReadingDisk(false)
    }).catch(error => { if (!controller.signal.aborted) { setError(error.reason ?? 'storage-failed'); setReadingDisk(false) } })
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
    if (actionName === 'create') { setChapterId(request.chapterId); setChapterTitle(''); setPreferredProposal(''); setWorkTab('writing'); setEditing(true); clearFilters() }
  })

  const readDisk = () => {
    if (dirty && !window.confirm(t('discardConfirm'))) return
    try { if (entryKey) localStorage.removeItem(entryKey) } catch { setError('draftFailed'); return }
    setReadingDisk(true); setError(''); setNotice('')
    setRefresh(value => value + 1)
  }

  const move = direction => {
    const index = book.chapters.findIndex(item => item.chapterId === chapterId)
    const beforeChapterId = direction < 0 ? book.chapters[index - 1].chapterId : book.chapters[index + 2]?.chapterId ?? ''
    change('move', { beforeChapterId })
  }

  const save = () => {
    if (!writable || !entry || !dirty || stale) return
    change('save', { content: entry.content, expectedHash: entry.baseHash, expectedRevision: entry.bookRevision, operationId: entry.operationId })
  }

  const proposals = entry && <Proposals key={`${bookId}:${chapterId}`} api={api} sessionId={sessionId} book={book} chapterId={chapterId} entry={entry} writable={writable} dirty={dirty} selection={selection} t={t} revisionHint={refresh} preferredProposal={preferredProposal} adopted={() => setRefresh(value => value + 1)} />

  return <section className="sn-books" aria-label={t('intro')} onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save() }
  }}>
    <div className="sn-library">
    <header className="sn-toolbar sn-library-heading"><h2>{t('title')}</h2>{library && <span className="sn-workspace" title={library.workspace}>{library.workspace}</span>}<IconButton label={t('refresh')} icon={IconRefreshOutline16} disabled={busy} onClick={() => setRefresh(value => value + 1)} /></header>
    {error && <p role="alert" className="sn-alert">{t(error)}</p>}
    {!library && !error && <p role="status">{t('loading')}</p>}
    {library && <>
      {!library.writable && <p role="status">{t('readOnly')}</p>}
      <div className="sn-book-picker"><Select aria-label={t('book')} value={bookId} disabled={busy} onChange={event => { setBookId(event.target.value); setChapterId(''); setError(''); setPreferredProposal('') }}>
        {!library.books.length && <option value="">{t('noBooks')}</option>}
        {library.books.map(item => <option key={item.bookId} value={item.bookId}>{item.title}</option>)}
      </Select><IconButton label={t('newBookForm')} icon={IconPlusOutline16} aria-expanded={newBookOpen || !library.books.length} disabled={busy || !library.writable} onClick={() => setNewBookOpen(value => !value)} /></div>
      <form className="sn-row sn-new-book" hidden={!newBookOpen && !!library.books.length} onSubmit={event => { event.preventDefault(); action(async signal => {
        const key = `create:${bookTitle.trim()}`
        if (!requestIds.current.has(key)) requestIds.current.set(key, crypto.randomUUID())
        const value = unwrap(await api.createBook(sessionId, { title: bookTitle, operationId: requestIds.current.get(key) }, signal))
        applyBook(value); setChapterId(''); setBookTitle(''); setNewBookOpen(false); setWorkTab('writing'); requestIds.current.delete(key)
      }) }}>
        <Input className="sn-input" aria-label={t('bookTitle')} placeholder={t('bookTitle')} maxLength={200} value={bookTitle} disabled={busy || !library.writable} onChange={event => setBookTitle(event.target.value)} />
        <Button variant="primary" size="sm" type="submit" disabled={busy || !library.writable || !bookTitle.trim()}>{t('createBook')}</Button>
        {!!library.books.length && <IconButton label={t('cancel')} icon={IconCloseOutline16} disabled={busy} onClick={() => setNewBookOpen(false)} />}
      </form>
      <Transfer api={api} sessionId={sessionId} book={book} writable={library.writable && !busy} t={t} imported={value => { applyBook(value); setChapterId(value.chapters[0]?.chapterId ?? ''); setDocuments('chapters'); setWorkTab('writing'); setNewBookOpen(false); clearFilters() }} />
      {book?.recoveryRequired && <Button size="sm" disabled={busy || !library.writable} onClick={() => action(async signal => applyBook(unwrap(await api.recoverBook(sessionId, bookId, signal))))}>{t('recover')}</Button>}
      {book?.recoveryRequired && <InterruptedRecovery key={bookId} api={api} sessionId={sessionId} bookId={bookId} writable={library.writable && !busy} t={t} saved={applyBook} />}
    </>}
    </div>
    {library && !library.books.length && <div className="sn-empty-state"><IconEditOutline16 /><h3>{t('emptyLibraryTitle')}</h3><p>{t('emptyLibraryHint')}</p></div>}
    {book && !book.recoveryRequired && <div className="sn-book-workspace">
      <DocumentDirectory book={book} chapterId={chapterId} documents={documents} busy={busy} search={search} setSearch={setSearch} kind={materialKind} setKind={setMaterialKind} linked={linkedChapter} setLinked={setLinkedChapter} page={directoryPage} setPage={setDirectoryPage} clear={clearFilters} t={t} select={id => { setChapterId(id); setError(''); setPreferredProposal(''); setWorkTab('writing') }} switchDocuments={value => { setDocuments(value); setChapterId(''); setPreferredProposal(''); setWorkTab('writing') }}>
        {documents === 'chapters' && <form className="sn-row" onSubmit={event => { event.preventDefault(); const key = `chapter:${bookId}:${book.revision}:${chapterTitle.trim()}`; if (!requestIds.current.has(key)) requestIds.current.set(key, crypto.randomUUID()); change('create', { chapterId: requestIds.current.get(key), title: chapterTitle }) }}>
          <Input className="sn-input" aria-label={t('chapterTitle')} placeholder={t('chapterTitle')} value={chapterTitle} maxLength={200} disabled={!writable} onChange={event => setChapterTitle(event.target.value)} />
          <IconButton label={t('createChapter')} icon={IconPlusOutline16} type="submit" disabled={!writable || !chapterTitle.trim()} />
        </form>}
      </DocumentDirectory>
      <main className="sn-document" aria-label={t('documentContent')}>
        <div hidden={documents !== 'materials'}><MaterialCreator key={bookId} api={api} sessionId={sessionId} book={book} workspaceId={library.workspaceId} writable={writable} t={t} onBusy={setBusy} created={(value, id, proposalId, generated) => { applyBook(value); setChapterId(id); setPreferredProposal(proposalId); setWorkTab(generated ? 'revisions' : 'writing'); clearFilters() }} /></div>
        {!currentChapter && <div className="sn-empty-state"><IconEditOutline16 /><h3>{t(documents === 'materials' ? 'chooseMaterial' : 'emptyBookTitle')}</h3><p>{t(documents === 'materials' ? 'materialCreationHint' : 'emptyBookHint')}</p></div>}
        {currentChapter && <>
          <div className="sn-document-header">
            <div className="sn-document-meta"><Tag tone="neutral">{t(currentChapter.kind ?? 'chapter')}</Tag>{currentChapter.linkedChapterId && <span>{book.chapters.find(item => item.chapterId === currentChapter.linkedChapterId)?.title ?? t('missingLinkedChapter')}</span>}</div>
            <div className="sn-title-row"><Input className="sn-title-input" aria-label={t('rename')} value={renameTitle} maxLength={200} disabled={!writable} onChange={event => setRenameTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && writable && renameTitle.trim() && renameTitle !== currentChapter.title) change('rename', { title: renameTitle }) }} />
              {renameTitle !== currentChapter.title && <IconButton label={t('rename')} icon={IconCheckOutline16} disabled={!writable || !renameTitle.trim()} onClick={() => change('rename', { title: renameTitle })} />}
            </div>
          </div>
          <div className={`sn-work-tabs${planning ? ' sn-material-tabs' : ''}`} role="tablist" aria-label={t('workspaceViews')} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            const buttons = Array.from(event.currentTarget.querySelectorAll('button')), at = buttons.indexOf(document.activeElement)
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length
            event.preventDefault(); buttons[next].focus(); buttons[next].click()
          }}>{(planning ? ['writing', 'revisions'] : ['writing', 'revisions', 'references', 'assessment']).map(tab => <Button size="sm" role="tab" key={tab} id={`sn-tab-${tab}`} aria-controls={`sn-panel-${tab}`} aria-selected={activeTab === tab} tabIndex={activeTab === tab ? 0 : -1} onClick={() => setWorkTab(tab)}>{tab === 'revisions' && <IconSparkle16 />}{t(planning ? tab === 'writing' ? 'contentTab' : 'assistantTab' : `tab-${tab}`)}</Button>)}</div>
          <div id="sn-panel-writing" aria-labelledby="sn-tab-writing" hidden={activeTab !== 'writing'} role="tabpanel">
          <div className="sn-toolbar sn-editor-toolbar">
            <div className="sn-modes" role="group" aria-label={t('body')}><Button size="sm" aria-pressed={editing} onClick={() => setEditing(true)}>{t('edit')}</Button><Button size="sm" aria-pressed={!editing} onClick={() => setEditing(false)}>{t('preview')}</Button></div>
            <span role="status" data-dirty={dirty ? 'true' : undefined}>{readingDisk ? t('loading') : busy ? t('saving') : dirty ? t('unsaved') : entry ? t('saved') : t('loading')}</span>
            <Button variant={dirty ? 'primary' : 'outline'} size="sm" aria-label={t('save')} title={t('saveShortcut')} disabled={!writable || !entry || !dirty || stale} onClick={save}><IconCheckOutline16 />{t('save')}</Button>
          </div>
          {stale && <p role="alert">{t('stale')}</p>}
          {notice && notice !== 'saved' && <p className="sn-notice" role="status">{t(notice)}</p>}
          {entry && (editing ? <textarea className="sn-editor" ref={editor} aria-label={t(planning ? 'materialText' : 'body')} placeholder={t('documentPlaceholder')} spellCheck={false} value={entry.content} readOnly={!writable} onSelect={event => setSelection({ start: event.target.selectionStart, end: event.target.selectionEnd })} onChange={event => storeDraft({ ...entry, content: event.target.value, operationId: crypto.randomUUID() })} /> : <pre className="sn-preview" aria-label={t(planning ? 'materialText' : 'body')}>{entry.content}</pre>)}
          {entry && <div className="sn-editor-footer"><span>{characterCount} {t('characters')}</span><span>{t('saveShortcut')}</span></div>}
          <details className="sn-document-options" open={documentOptionsOpen} onToggle={event => setDocumentOptionsOpen(event.currentTarget.open)}><summary>{t('documentOptions')}</summary><div className="sn-row sn-recovery-actions"><Button size="sm" disabled={!entry || busy || readingDisk} onClick={readDisk}>{t('reloadDisk')}</Button><Button size="sm" disabled={!entry} onClick={() => download(entry.content, currentChapter.title)}>{t('exportDraft')}</Button>
            <Button size="sm" disabled={!writable || book.chapters[0].chapterId === chapterId} onClick={() => move(-1)}><IconChevronUpOutline14 />{t('moveUp')}</Button>
            <Button size="sm" disabled={!writable || book.chapters.at(-1).chapterId === chapterId} onClick={() => move(1)}><IconChevronDownOutline14 />{t('moveDown')}</Button>
          </div></details>
          {entry && <ChapterRecovery key={`history:${bookId}:${chapterId}`} api={api} sessionId={sessionId} book={book} chapterId={chapterId} entry={entry} writable={writable} dirty={dirty} stale={stale} t={t} onBusy={setBusy} saved={() => {
            try { localStorage.removeItem(entryKey) } catch { setError('draftFailed'); return }
            setRefresh(value => value + 1)
          }} />}
          </div>
          <div id="sn-panel-revisions" aria-labelledby="sn-tab-revisions" hidden={activeTab !== 'revisions'} role="tabpanel">
          {proposals}
          {planning && <Button className="sn-return-content" size="sm" onClick={() => setWorkTab('writing')}>{t('contentTab')} →</Button>}
          </div>
          <div id="sn-panel-references" aria-labelledby="sn-tab-references" hidden={planning || workTab !== 'references'} role="tabpanel">
          {entry && (!currentChapter.kind || currentChapter.kind === 'chapter') && <><Facts key={`facts:${bookId}:${chapterId}`} api={api} sessionId={sessionId} book={book} chapterId={chapterId} entry={entry} selection={selection} writable={writable} dirty={dirty} t={t} revisionHint={refresh} adopted={() => setRefresh(value => value + 1)} locate={(start, end) => { setWorkTab('writing'); setEditing(true); setTimeout(() => { editor.current?.focus(); editor.current?.setSelectionRange(start, end) }, 0) }} /><Voices key={`voices:${bookId}:${chapterId}`} api={api} sessionId={sessionId} book={book} chapterId={chapterId} entry={entry} selection={selection} writable={writable} dirty={dirty} t={t} changed={applyBook} /></>}
          </div>
          <div id="sn-panel-assessment" aria-labelledby="sn-tab-assessment" hidden={planning || workTab !== 'assessment'} role="tabpanel">
          {entry && (!currentChapter.kind || currentChapter.kind === 'chapter') && <Reviews key={`reviews:${bookId}:${chapterId}`} api={api} sessionId={sessionId} book={book} chapterId={chapterId} entry={entry} writable={writable} dirty={dirty} t={t} revisionHint={`${refresh}:${workTab === 'assessment'}`} revised={id => { setPreferredProposal(id); setRefresh(value => value + 1); setWorkTab('revisions') }} locate={(start, end) => { setWorkTab('writing'); setEditing(true); setTimeout(() => { editor.current?.focus(); editor.current?.setSelectionRange(start, end) }, 0) }} />}
          </div>
        </>}
      </main>
    </div>}
  </section>
}
