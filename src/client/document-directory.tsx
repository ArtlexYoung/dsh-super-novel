import React from 'react'
import { Select } from './controls.js'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { materialKinds } from './materials.js'

/** Filters affect navigation only; the selected draft remains mounted. */
export function DocumentDirectory({ book, chapterId, documents, busy, search, setSearch, kind, setKind, linked, setLinked, page, setPage, select, switchDocuments, clear, children, t }) {
  const chapters = book.chapters.filter(item => !item.kind || item.kind === 'chapter')
  const materials = book.chapters.filter(item => materialKinds.includes(item.kind))
  const visible = documents === 'chapters' ? chapters : materials
  const filtered = visible.filter(item => item.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) &&
    (documents === 'chapters' || (kind === 'all' || item.kind === kind) &&
      (linked === 'all' || (linked === 'unlinked' ? !item.linkedChapterId : item.linkedChapterId === linked))))
  const lastPage = Math.max(0, Math.ceil(filtered.length / 100) - 1)
  const currentPage = Math.min(page, lastPage)
  const active = book.chapters.find(item => item.chapterId === chapterId)
  const filteredOut = active && visible.some(item => item.chapterId === chapterId) && !filtered.some(item => item.chapterId === chapterId)
  const hasFilter = search || kind !== 'all' || linked !== 'all'
  return <details className="sn-directory" open>
    <summary><span>{t('documentDirectory')}</span><span className="sn-directory-selection">{active?.title ?? book.title}</span></summary>
    <div className="sn-directory-body">
      <div className="sn-modes" role="tablist" aria-label={t('documentView')}>{[['chapters', chapters.length], ['materialsView', materials.length]].map(([label, count], index) => <Button size="sm" role="tab" key={label} disabled={busy} aria-selected={documents === (index ? 'materials' : 'chapters')} onClick={() => switchDocuments(index ? 'materials' : 'chapters')}>{t(label)} <span aria-hidden="true">({count})</span></Button>)}</div>
      <label className="sn-field">{t('searchDocuments')}<Input className="sn-input" type="search" aria-label={t('searchDocuments')} value={search} onChange={event => setSearch(event.target.value)} /></label>
      {documents === 'materials' && <div className="sn-directory-filters">
        <label className="sn-field">{t('filterMaterialType')}<Select aria-label={t('filterMaterialType')} value={kind} onChange={event => setKind(event.target.value)}>
          <option value="all">{t('allMaterialTypes')} ({materials.length})</option>
          {materialKinds.map(value => <option key={value} value={value}>{t(value)} ({materials.filter(item => item.kind === value).length})</option>)}
        </Select></label>
        <label className="sn-field">{t('filterLinkedChapter')}<Select aria-label={t('filterLinkedChapter')} value={linked} onChange={event => setLinked(event.target.value)}>
          <option value="all">{t('allRelatedChapters')}</option><option value="unlinked">{t('none')}</option>
          {chapters.map(item => <option key={item.chapterId} value={item.chapterId}>{item.title}</option>)}
        </Select></label>
      </div>}
      <div className="sn-directory-status"><span role="status">{t('matchingDocuments')}: {filtered.length} / {visible.length}</span>{hasFilter && <Button size="sm" onClick={clear}>{t('clearFilters')}</Button>}</div>
      {filteredOut && <p className="sn-notice">{t('selectedOutsideFilter')}</p>}
      <nav className="sn-chapters" aria-label={t(documents === 'chapters' ? 'chapter' : 'materialsView')}>
        {!filtered.length && <p>{t(visible.length ? 'noMatchingDocuments' : documents === 'chapters' ? 'noChapters' : 'noMaterials')}</p>}
        {filtered.slice(currentPage * 100, currentPage * 100 + 100).map((item, index) => <Button size="sm" key={item.chapterId} disabled={busy} aria-current={chapterId === item.chapterId ? 'true' : undefined} onClick={() => select(item.chapterId)}><span className="sn-number">{currentPage * 100 + index + 1}</span><span>{item.title}{item.kind && item.kind !== 'chapter' ? ` · ${t(item.kind)}` : ''}{item.linkedChapterId && <small className="sn-document-link">{t('relatedChapter')}: {chapters.find(chapter => chapter.chapterId === item.linkedChapterId)?.title ?? t('missingLinkedChapter')}</small>}</span></Button>)}
      </nav>
      {filtered.length > 100 && <div className="sn-row"><Button size="sm" aria-label={t('previousPage')} disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>&lt;</Button><span>{currentPage + 1} / {lastPage + 1}</span><Button size="sm" aria-label={t('nextPage')} disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>&gt;</Button></div>}
      {children}
    </div>
  </details>
}
