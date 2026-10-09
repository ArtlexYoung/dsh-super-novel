import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Select } from './controls.js'
import { Button, Input, Tag, IconPlusOutline16, IconEditOutline16, IconRefreshOutline16, IconCheckOutline16, IconChevronUpOutline14, IconChevronDownOutline14, IconCloseOutline16 } from './primitives.js'
import { Proposals } from './proposals.js'
import { ChapterRecovery, InterruptedRecovery } from './history.js'
import { MaterialCreator } from './material-creator.js'
import { Facts } from './facts.js'
import { Reviews } from './reviews.js'
import { Voices } from './voices.js'
import { Transfer } from './transfer.js'
import { DocumentDirectory } from './document-directory.js'
import { Backups } from './backups.js'
import { StorageSettings } from './storage-location.js'
import { DraftRecovery } from './draft-recovery.js'
import { draftKey, editorBranch, readCachedDrafts, writeCachedDraft, forgetCachedDraft } from './draft-cache.js'
import { DraftWriter } from './draft-writer.js'
import { useCompactPane, WorkspacePanel } from './workspace-panel.js'
import { ReferencePanel } from './reference-panel.js'

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

function download(text, title) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = `${title.replace(/[\\/:*?"<>|]/g, '_')}.md`; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Draft identity and save baselines survive sidebar closure and session switches. */
export function Books({ api, sessionId, t, setup }) {
  const root = useRef(null), compact = useCompactPane(root)
  const [pane, setPane] = useState('')
  const positions = useRef(new Map()), returnPosition = useRef(false)
  const [library, setLibrary] = useState(null)
  const [bookId, setBookId] = useState('')
  const [chapterId, setChapterId] = useState('')
  const [storedEntry, setEntryState] = useState(null)
  const entryRef = useRef(null)
  const setEntry = value => { entryRef.current = value; setEntryState(value) }
  const branch = useRef('')
  if (!branch.current) branch.current = editorBranch()
  const writers = useRef(new Map())
  const [draftState, setDraftState] = useState({ kind: 'formal', savedAt: 0 })
  const documentIdentity = `${library?.workspaceId ?? ''}:${bookId}:${chapterId}`
  // Hide the previous document in the same render as a selection change.
  const entry = storedEntry?.identity === documentIdentity ? storedEntry : null
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
  const editorWritable = library?.writable && !readingDisk && !book?.recoveryRequired
  const writable = editorWritable && !busy
  const currentChapter = book?.chapters.find(item => item.chapterId === chapterId)
  const planning = currentChapter?.kind && currentChapter.kind !== 'chapter'
  const activeTab = planning && !['writing', 'revisions'].includes(workTab) ? 'writing' : workTab
  const managementOpen = pane === 'management'
  const overlayOpen = managementOpen || ['materials', 'create-material'].includes(pane) || compact && pane === 'directory'
  const capturePosition = () => {
    if (!editor.current || !entry) return
    positions.current.set(documentIdentity, { start: editor.current.selectionStart, end: editor.current.selectionEnd, direction: editor.current.selectionDirection, scroll: editor.current.scrollTop })
  }
  const restorePosition = focus => {
    const position = positions.current.get(documentIdentity), element = editor.current
    if (!element || !position) return
    if (focus) element.focus({ preventScroll: true })
    element.setSelectionRange(Math.min(position.start, element.value.length), Math.min(position.end, element.value.length), position.direction)
    element.scrollTop = position.scroll
  }
  const openPane = next => { capturePosition(); setPane(next) }
  const closePane = () => { returnPosition.current = true; setPane('') }
  const showWriting = () => { closePane(); setWorkTab('writing') }
  const showTool = tab => { capturePosition(); setPane(''); setWorkTab(tab) }
  useLayoutEffect(() => {
    if (!pane && activeTab === 'writing') {
      const focus = returnPosition.current
      returnPosition.current = false
      const frame = requestAnimationFrame(() => restorePosition(focus))
      return () => cancelAnimationFrame(frame)
    }
  }, [pane, compact, activeTab, documentIdentity, !!entry, editing])
  useLayoutEffect(() => { setPane(book?.recoveryRequired ? 'management' : '') }, [library?.workspaceId, bookId, book?.recoveryRequired])
  useEffect(() => { if (library && !library.books.length) setPane('management') }, [library?.workspaceId, library?.books.length])
  const visible = book?.chapters.filter(item => documents === 'chapters' ? !item.kind || item.kind === 'chapter' : item.kind && item.kind !== 'chapter' && item.kind !== 'facts' && item.kind !== 'voice') ?? []
  const clearFilters = () => { setSearch(''); setMaterialKind('all'); setLinkedChapter('all'); setDirectoryPage(0) }
  useEffect(() => setDirectoryPage(0), [search, materialKind, linkedChapter, bookId, documents])
  useEffect(clearFilters, [bookId, documents])
  const dirty = entry && (entry.content !== entry.diskContent || entry.externallyModified)
  const stale = entry && (entry.bookRevision !== book?.revision || entry.baseHash !== entry.diskHash)
  const writerFor = (workspaceId, bookId, chapterId) => {
    const key = draftKey(workspaceId, bookId, chapterId)
    if (!writers.current.has(key)) writers.current.set(key, new DraftWriter({ workspaceId, bookId, chapterId, branchId: branch.current }, {
      cache: writeCachedDraft, forget: forgetCachedDraft,
      checkpoint: request => api.checkpointDraft(sessionId, request, new AbortController().signal).then(unwrap),
      settle: request => api.settleDraft(sessionId, request, new AbortController().signal).then(unwrap),
      changed: state => { if (mounted.current && entryIdentity.current === `${workspaceId}:${bookId}:${chapterId}`) { setDraftState(state) } },
    }))
    return writers.current.get(key)
  }
  const flushDraft = async () => {
    for (const writer of writers.current.values()) await writer.flush()
  }
  const characterCount = useMemo(() => (entry?.content ?? '').replace(/\s/gu, '').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '_').length, [entry?.content])
  useEffect(() => setDocumentOptionsOpen(false), [bookId, chapterId])
  useEffect(() => { if (stale && (entry?.externallyModified || entry?.baseHash !== entry?.diskHash)) setDocumentOptionsOpen(true) }, [stale, entry?.externallyModified, entry?.baseHash, entry?.diskHash])

  useEffect(() => {
    mounted.current = true
    const checkpoint = () => { for (const writer of writers.current.values()) writer.attempt() }
    const hidden = () => { if (document.visibilityState === 'hidden') checkpoint() }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', checkpoint)
    return () => { mounted.current = false; checkpoint(); pending.current?.abort(); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', checkpoint) }
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
    if (entryIdentity.current !== identity || !book || book.recoveryRequired) { setEntry(null); setSelection({ start: 0, end: 0 }); setDraftState({ kind: 'formal', savedAt: 0 }) }
    entryIdentity.current = identity
    if (!book) { setReadingDisk(false); return () => controller.abort() }
    if (book.recoveryRequired) { setReadingDisk(false); return () => controller.abort() }
    if (!book.chapters.some(item => item.chapterId === chapterId)) {
      setChapterId(visible[0]?.chapterId ?? '')
      setReadingDisk(false)
      return () => controller.abort()
    }
    setRenameTitle(book.chapters.find(item => item.chapterId === chapterId).title)
    Promise.all([api.chapter(sessionId, bookId, chapterId, controller.signal).then(unwrap), readCachedDrafts(library.workspaceId, bookId, chapterId)]).then(async ([value, cache]) => {
      if (controller.signal.aborted || sequence.current !== generation) return
      const current = entryRef.current?.identity === identity ? entryRef.current : null
      const own = cache.drafts.filter(item => item.branchId === branch.current).sort((a, b) => b.sequence - a.sequence)[0]
      let legacy
      try { legacy = JSON.parse(localStorage.getItem(draftKey(library.workspaceId, bookId, chapterId)) || 'null') } catch {}
      const validLegacy = legacy?.schemaVersion === 1 && typeof legacy.content === 'string' && typeof legacy.baseHash === 'string' && Number.isSafeInteger(legacy.bookRevision) && typeof legacy.operationId === 'string'
      const activeWriter = writers.current.get(draftKey(library.workspaceId, bookId, chapterId))
      const draft = current && (current.content !== current.diskContent || activeWriter?.latest?.operationId === current.operationId) ? current : own ?? (validLegacy ? legacy : undefined)
      const sameAsDisk = !draft || draft.content === value.content
      const next = { identity, content: draft ? draft.content : value.content, diskContent: value.content, diskHash: value.hash,
        baseHash: sameAsDisk ? value.hash : draft.baseHash, bookRevision: !sameAsDisk && draft.baseHash !== value.hash ? draft.bookRevision : value.book.revision,
        operationId: draft ? draft.operationId : crypto.randomUUID(), externallyModified: value.externallyModified }
      setEntry(next)
      if (library.writable && next.content !== next.diskContent) {
        const writer = writerFor(library.workspaceId, bookId, chapterId)
        writer.sequence = Math.max(writer.sequence, own?.sequence ?? 0)
        writer.update(next)
        setDraftState(writer.state)
        if (validLegacy && draft === legacy) {
          // Only retire the old copy after the async browser store accepts it.
          try {
            await writeCachedDraft(writer.latest)
            const stored = JSON.parse(localStorage.getItem(draftKey(library.workspaceId, bookId, chapterId)) || 'null')
            if (stored?.operationId === legacy.operationId) localStorage.removeItem(draftKey(library.workspaceId, bookId, chapterId))
          } catch { if (!controller.signal.aborted) setError('draftFailed') }
        }
      }
      if (controller.signal.aborted || sequence.current !== generation) return
      setNotice(draft && draft !== current ? 'localDraft' : value.externallyModified ? 'external' : '')
      setReadingDisk(false)
    }).catch(error => { if (!controller.signal.aborted) { setError(error.reason ?? 'storage-failed'); setReadingDisk(false) } })
    return () => { controller.abort(); writers.current.get(draftKey(library.workspaceId, bookId, chapterId))?.attempt() }
  }, [api, sessionId, library?.workspaceId, bookId, chapterId, book?.revision, book?.recoveryRequired, refresh])

  useEffect(() => {
    if (!library) return
    try { localStorage.setItem(`super-novel.selection:${library.workspaceId}`, JSON.stringify({ bookId, chapterId, documents })) } catch {}
  }, [library?.workspaceId, bookId, chapterId, documents])

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
    if (library?.writable) writerFor(library.workspaceId, bookId, chapterId).update(next)
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
      title: '', beforeChapterId: '', content: '', expectedHash: '', workspaceId: library.workspaceId, ...extra }
    const key = JSON.stringify(input)
    if (!requestIds.current.has(key)) requestIds.current.set(key, crypto.randomUUID())
    const operationId = extra.operationId || requestIds.current.get(key)
    const request = { ...input, operationId }
    const submitted = entryRef.current
    const writer = writerFor(library.workspaceId, bookId, chapterId)
    // A draft-only failure must not block the journalled formal save.
    if (actionName === 'save') await writer.flush().catch(() => {})
    const value = unwrap(await api.changeChapter(sessionId, request, signal))
    if (actionName === 'save') {
      try { await writer.settle(submitted, 'saved') } catch (error) { setError(error.reason ?? 'draftFailed') }
      const current = entryRef.current
      if (entryIdentity.current === `${library.workspaceId}:${bookId}:${chapterId}` && current) {
        const hash = value.chapters.find(item => item.chapterId === chapterId).hash
        const next = { ...current, diskContent: request.content, diskHash: hash, baseHash: hash, bookRevision: value.revision, externallyModified: false }
        if (current.operationId === submitted.operationId) setEntry(next)
        else storeDraft(next)
      }
      setNotice('saved')
    }
    applyBook(value)
    if (actionName === 'create') { setChapterId(request.chapterId); setChapterTitle(''); setPreferredProposal(''); setWorkTab('writing'); setEditing(true); setPane(''); clearFilters() }
  })

  const readDisk = () => {
    if (dirty && !window.confirm(t('discardConfirm'))) return
    const submitted = entryRef.current
    action(async () => {
      setReadingDisk(true)
      try {
        const writer = writerFor(library.workspaceId, bookId, chapterId)
        await writer.flush()
        await writer.settle(submitted, 'dismissed')
        setEntry(null); setNotice(''); setRefresh(value => value + 1)
      } catch (error) { setReadingDisk(false); throw error }
    })
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
  const editReference = id => action(async () => { await flushDraft(); capturePosition(); setDocuments('materials'); setChapterId(id); setWorkTab('writing'); setPane(''); clearFilters() })
  const manageMaterials = () => { capturePosition(); setDocuments('materials'); setPane('directory'); clearFilters() }
  const materialCreated = (value, id, proposalId, generated) => {
    applyBook(value); setChapterId(id); setPreferredProposal(proposalId); clearFilters()
    // Creation is acknowledged before generation. Keep its form visible until
    // the generation request succeeds so a failed request retains its retry controls.
    if (!generated || proposalId) { setPane(''); setWorkTab(generated ? 'revisions' : 'writing') }
  }

  return <section ref={root} className="sn-books" data-compact={compact} aria-label={t('intro')} onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save() }
  }}>
    <header className="sn-project-heading"><Button size="sm" className="sn-project-title" aria-label={t('bookManager')} aria-expanded={managementOpen} disabled={busy} onClick={() => openPane('management')}><span>{book?.title ?? t('title')}</span><IconChevronDownOutline14 /></Button>{entry && (overlayOpen || activeTab !== 'writing') && <span className="sn-project-save" role="status" title={dirty ? t(`draft-${draftState.kind}`) : t('saved')}>{dirty ? t(`draft-${draftState.kind}`) : t('saved')}</span>}{library && !library.writable && <Tag tone="neutral">{t('readOnlyShort')}</Tag>}</header>
    {error && <p role="alert" className="sn-alert">{t(error)}</p>}
    {dirty && ['failed', 'browser-failed'].includes(draftState.kind) && <p role="alert" className="sn-alert sn-draft-alert">{t(draftState.kind === 'failed' ? draftState.reason : 'draftFailed')} <Button size="sm" onClick={() => writerFor(library.workspaceId, bookId, chapterId).attempt()}>{t('retryDraft')}</Button><Button size="sm" onClick={() => download(entry.content, currentChapter.title)}>{t('exportDraft')}</Button></p>}
    {stale && <p role="alert" className="sn-alert">{t('stale')} <Button size="sm" onClick={() => openPane('management')}>{t('openRecovery')}</Button></p>}
    {!library && !error && <p role="status">{t('loading')}</p>}
    <div className="sn-workspace-body">
    <WorkspacePanel id="sn-panel-management" title={t('workspaceOptions')} open={managementOpen} close={closePane} t={t}>
    <div className="sn-library">
    <header className="sn-toolbar sn-library-heading"><h2>{t('bookManager')}</h2>{library && <span className="sn-workspace" title={library.workspace}>{library.workspace}</span>}<IconButton label={t('refresh')} icon={IconRefreshOutline16} disabled={busy} onClick={() => setRefresh(value => value + 1)} /></header>
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
      <Transfer api={api} sessionId={sessionId} book={book} writable={library.writable && !busy} t={t} imported={value => { applyBook(value); setChapterId(value.chapters[0]?.chapterId ?? ''); setDocuments('chapters'); setWorkTab('writing'); setPane(''); setNewBookOpen(false); clearFilters() }} />
      {book?.recoveryRequired && <Button size="sm" disabled={busy || !library.writable} onClick={() => action(async signal => applyBook(unwrap(await api.recoverBook(sessionId, bookId, signal))))}>{t('recover')}</Button>}
      {book?.recoveryRequired && <InterruptedRecovery key={bookId} api={api} sessionId={sessionId} bookId={bookId} writable={library.writable && !busy} t={t} saved={applyBook} />}
    </>}
    <StorageSettings api={api} sessionId={sessionId} revision={refresh} writable={!busy} t={t} beforeSwitch={flushDraft} switching={setReadingDisk} switched={() => { setEntry(null); setLibrary(null); setBookId(''); setChapterId(''); setRefresh(value => value + 1) }} />
    {library && <Backups key={`backup:${library.workspaceId}:${bookId}`} api={api} sessionId={sessionId} workspaceId={library.workspaceId} book={book} writable={library.writable && !busy} t={t} beforeBackup={flushDraft} restored={() => setRefresh(value => value + 1)} />}
    {currentChapter && !planning && <div className="sn-more-tools"><Button size="sm" id="sn-tab-references" onClick={() => showTool('references')}>{t('tab-references')}</Button><Button size="sm" id="sn-tab-assessment" onClick={() => showTool('assessment')}>{t('tab-assessment')}</Button></div>}
    {currentChapter && <section className="sn-document-management"><h3>{currentChapter.title}</h3>
          <details className="sn-document-options" open={documentOptionsOpen} onToggle={event => setDocumentOptionsOpen(event.currentTarget.open)}><summary>{t('documentOptions')}</summary><div className="sn-row sn-recovery-actions"><Button size="sm" disabled={!entry || busy || readingDisk} onClick={readDisk}>{t('reloadDisk')}</Button><Button size="sm" disabled={!entry} onClick={() => download(entry.content, currentChapter.title)}>{t('exportDraft')}</Button>
            <Button size="sm" disabled={!writable || book.chapters[0].chapterId === chapterId} onClick={() => move(-1)}><IconChevronUpOutline14 />{t('moveUp')}</Button>
            <Button size="sm" disabled={!writable || book.chapters.at(-1).chapterId === chapterId} onClick={() => move(1)}><IconChevronDownOutline14 />{t('moveDown')}</Button>
          </div></details>
          {entry && <DraftRecovery key={`drafts:${library.workspaceId}:${bookId}:${chapterId}`} api={api} sessionId={sessionId} workspaceId={library.workspaceId} bookId={bookId} chapterId={chapterId} entry={entry} writable={writable && !busy} t={t} beforeRestore={flushDraft} restore={draft => { storeDraft({ ...entryRef.current, content: draft.content, baseHash: draft.baseHash, bookRevision: draft.baseHash === entryRef.current.diskHash ? book.revision : draft.bookRevision, operationId: crypto.randomUUID() }); setNotice('localDraft'); setEditing(true); showWriting() }} />}
          {entry && <ChapterRecovery key={`history:${bookId}:${chapterId}`} api={api} sessionId={sessionId} book={book} chapterId={chapterId} entry={entry} writable={writable} dirty={dirty} stale={stale} t={t} onBusy={setBusy} beforeChange={flushDraft} saved={async () => {
            const writer = writerFor(library.workspaceId, bookId, chapterId)
            try { await writer.settle(entry, 'dismissed') } catch { setError('draftFailed') }
            if (entryRef.current?.operationId === entry.operationId) setEntry(null)
            setRefresh(value => value + 1)
          }} />}
    </section>}
    {setup}
    </div>
    </WorkspacePanel>
    {library && !library.books.length && <div className="sn-empty-state" inert={overlayOpen} aria-hidden={overlayOpen ? 'true' : undefined}><IconEditOutline16 /><h3>{t('emptyLibraryTitle')}</h3><p>{t('emptyLibraryHint')}</p><Button size="sm" onClick={() => openPane('management')}>{t('createBook')}</Button></div>}
    {book?.recoveryRequired && <div className="sn-empty-state" inert={overlayOpen} aria-hidden={overlayOpen ? 'true' : undefined}><h3>{t('recover')}</h3><p>{t('recovery-required')}</p><Button size="sm" onClick={() => openPane('management')}>{t('openRecovery')}</Button></div>}
    {book && !book.recoveryRequired && <div className="sn-book-workspace">
      <WorkspacePanel id="sn-panel-directory" title={t('documentDirectory')} open={!compact || pane === 'directory'} inline={!compact} inactive={!compact && overlayOpen} close={closePane} t={t}>
      <DocumentDirectory book={book} chapterId={chapterId} documents={documents} busy={busy} search={search} setSearch={setSearch} kind={materialKind} setKind={setMaterialKind} linked={linkedChapter} setLinked={setLinkedChapter} page={directoryPage} setPage={setDirectoryPage} clear={clearFilters} t={t} select={id => { capturePosition(); setChapterId(id); setError(''); setPreferredProposal(''); setWorkTab('writing'); setPane('') }} switchDocuments={value => { capturePosition(); setDocuments(value) }}>
        {documents === 'chapters' && <form className="sn-row" onSubmit={event => { event.preventDefault(); const key = `chapter:${bookId}:${book.revision}:${chapterTitle.trim()}`; if (!requestIds.current.has(key)) requestIds.current.set(key, crypto.randomUUID()); change('create', { chapterId: requestIds.current.get(key), title: chapterTitle }) }}>
          <Input className="sn-input" aria-label={t('chapterTitle')} placeholder={t('chapterTitle')} value={chapterTitle} maxLength={200} disabled={!writable} onChange={event => setChapterTitle(event.target.value)} />
          <IconButton label={t('createChapter')} icon={IconPlusOutline16} type="submit" disabled={!writable || !chapterTitle.trim()} />
        </form>}
        {documents === 'materials' && <Button size="sm" disabled={!writable} onClick={() => openPane('create-material')}><IconPlusOutline16 />{t('newMaterialWithAI')}</Button>}
      </DocumentDirectory>
      </WorkspacePanel>
      <main className="sn-document" data-view={activeTab} inert={overlayOpen} aria-hidden={overlayOpen ? 'true' : undefined} aria-label={t('documentContent')}>
        {!currentChapter && <div className="sn-empty-state"><IconEditOutline16 /><h3>{t(documents === 'materials' ? 'chooseMaterial' : 'emptyBookTitle')}</h3><p>{t(documents === 'materials' ? 'materialCreationHint' : 'emptyBookHint')}</p><Button size="sm" onClick={() => openPane('directory')}>{t('directoryShort')}</Button></div>}
        {currentChapter && <>
          <div className="sn-document-header">
            <div className="sn-document-meta" hidden={!planning}><Tag tone="neutral">{t(currentChapter.kind ?? 'chapter')}</Tag>{currentChapter.linkedChapterId && <span>{book.chapters.find(item => item.chapterId === currentChapter.linkedChapterId)?.title ?? t('missingLinkedChapter')}</span>}</div>
            <div className="sn-title-row"><Input className="sn-title-input" aria-label={t('rename')} value={renameTitle} maxLength={200} disabled={!writable} onChange={event => setRenameTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && writable && renameTitle.trim() && renameTitle !== currentChapter.title) change('rename', { title: renameTitle }) }} />
              {renameTitle !== currentChapter.title && <IconButton label={t('rename')} icon={IconCheckOutline16} disabled={!writable || !renameTitle.trim()} onClick={() => change('rename', { title: renameTitle })} />}
            </div>
          </div>
          {activeTab !== 'writing' && <div className="sn-tool-heading"><Button size="sm" onClick={showWriting}>{t('backToWriting')}</Button><span>{t(`tab-${activeTab}`)}</span></div>}
          <div id="sn-panel-writing" className="sn-writing-panel" aria-labelledby="sn-tab-writing" hidden={activeTab !== 'writing'} role="tabpanel">
          <div className="sn-toolbar sn-editor-toolbar">
            <Button size="sm" aria-pressed={!editing} onClick={() => { capturePosition(); setEditing(value => !value) }}>{t(editing ? 'preview' : 'edit')}</Button>
            <span role="status" data-dirty={dirty ? 'true' : undefined} title={draftState.savedAt ? new Date(draftState.savedAt).toLocaleString() : ''}>{readingDisk ? t('loading') : dirty ? t(`draft-${draftState.kind}`) : entry ? t('saved') : t('loading')}</span>
            <Button variant={dirty ? 'primary' : 'outline'} size="sm" aria-label={t('save')} title={t('saveShortcut')} disabled={!writable || busy || !entry || !dirty || stale} onClick={save}><IconCheckOutline16 />{t('save')}</Button>
          </div>
          {notice && notice !== 'saved' && <p className="sn-notice" role="status">{t(notice)}</p>}
          {entry && <><textarea className="sn-editor" hidden={!editing} data-book-id={bookId} data-chapter-id={chapterId} ref={editor} aria-label={t(planning ? 'materialText' : 'body')} placeholder={t('documentPlaceholder')} spellCheck={false} value={entry.content} readOnly={!editorWritable} onCompositionStart={() => { writerFor(library.workspaceId, bookId, chapterId).composing = true }} onCompositionEnd={() => { const writer = writerFor(library.workspaceId, bookId, chapterId); writer.composing = false; writer.attempt() }} onScroll={capturePosition} onBlur={capturePosition} onSelect={event => { setSelection({ start: event.target.selectionStart, end: event.target.selectionEnd }); capturePosition() }} onChange={event => storeDraft({ ...entryRef.current, content: event.target.value, operationId: crypto.randomUUID() })} /><pre className="sn-preview" hidden={editing} aria-label={t(planning ? 'materialText' : 'body')}>{entry.content}</pre></>}
          {entry && <div className="sn-editor-footer"><span>{characterCount} {t('characters')}</span><span>{t('saveShortcut')}</span></div>}
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
    {book && <WorkspacePanel id="sn-panel-create-material" title={t('newMaterialWithAI')} open={pane === 'create-material'} close={closePane} t={t}><MaterialCreator key={`${library.workspaceId}:${bookId}`} active={pane === 'create-material'} api={api} sessionId={sessionId} book={book} workspaceId={library.workspaceId} writable={writable} t={t} onBusy={setBusy} created={materialCreated} /></WorkspacePanel>}
    {book && <WorkspacePanel id="sn-panel-materials" title={t('referenceList')} open={pane === 'materials'} close={closePane} t={t}><ReferencePanel key={`${library.workspaceId}:${bookId}`} api={api} sessionId={sessionId} book={book} chapterId={chapterId} open={pane === 'materials'} writable={writable} t={t} edit={editReference} manage={manageMaterials} /></WorkspacePanel>}
    </div>
    <nav className="sn-work-tabs" role="tablist" aria-label={t('workspaceViews')} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      const buttons = [...event.currentTarget.querySelectorAll('button')].filter(button => !button.disabled), at = buttons.indexOf(document.activeElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length
      event.preventDefault(); buttons[next].focus(); buttons[next].click()
    }}>
      {[['writing', 'writingShort'], ['directory', 'directoryShort'], ['materials', 'materialsShort'], ['revisions', 'assistantShort'], ['management', 'moreShort']].map(([tab, label]) => {
        const selected = pane ? pane === tab || pane === 'create-material' && tab === 'materials' : activeTab === tab || tab === 'management' && ['references', 'assessment'].includes(activeTab)
        return <Button size="sm" role="tab" key={tab} id={`sn-tab-${tab}`} aria-controls={`sn-panel-${tab}`} aria-selected={selected} tabIndex={selected ? 0 : -1} disabled={busy || tab !== 'management' && (!book || book.recoveryRequired) || tab === 'revisions' && !entry} onClick={() => tab === 'writing' ? showWriting() : tab === 'revisions' ? showTool('revisions') : pane === tab ? closePane() : openPane(tab)}>{t(label)}</Button>
      })}
    </nav>
  </section>
}
