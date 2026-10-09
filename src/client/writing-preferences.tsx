import React, { useState } from 'react'
import { Button } from './primitives.js'
import { Select } from './controls.js'

export function useWritingPreferences() {
  const [value, setValue] = useState(() => {
    try { const value = JSON.parse(localStorage.getItem('super-novel.writing-preferences') || '{}'); return { font: [16, 18, 20].includes(value.font) ? value.font : 18, spacing: [1.6, 1.9, 2.2].includes(value.spacing) ? value.spacing : 1.9, width: ['normal', 'wide'].includes(value.width) ? value.width : 'normal' } }
    catch { return { font: 18, spacing: 1.9, width: 'normal' } }
  })
  const update = next => { setValue(next); try { localStorage.setItem('super-novel.writing-preferences', JSON.stringify(next)) } catch { /* Cosmetic preferences do not affect manuscript storage. */ } }
  return { value, update }
}
export function WritingPreferences({ preferences, t }) {
  const { value, update } = preferences
  return <details><summary>{t('writingAppearance')}</summary>
    <label className="sn-field">{t('writingFont')}<Select aria-label={t('writingFont')} value={value.font} onChange={event => update({ ...value, font: Number(event.target.value) })}>{[16, 18, 20].map(size => <option key={size} value={size}>{size}px</option>)}</Select></label>
    <label className="sn-field">{t('writingSpacing')}<Select aria-label={t('writingSpacing')} value={value.spacing} onChange={event => update({ ...value, spacing: Number(event.target.value) })}>{[1.6, 1.9, 2.2].map(size => <option key={size} value={size}>{size}</option>)}</Select></label>
    <Button size="sm" aria-pressed={value.width === 'wide'} onClick={() => update({ ...value, width: value.width === 'wide' ? 'normal' : 'wide' })}>{t('wideWriting')}</Button>
  </details>
}
