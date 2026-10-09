import React, { useEffect, useState } from 'react'
import { Button, Input } from './primitives.js'
import { Select } from './controls.js'
import { unwrap } from './books.js'

export function StorageSettings({ api, sessionId, revision, writable, t, beforeSwitch, switched, switching }) {
  const [location, setLocation] = useState(null), [root, setRoot] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const editable = writable && location?.canChange
  useEffect(() => {
    const controller = new AbortController()
    api.storageLocation(sessionId, controller.signal).then(unwrap).then(value => { if (!controller.signal.aborted) { setLocation(value); setRoot(value.root); setError('') } }).catch(error => { if (!controller.signal.aborted) setError(error.reason ?? 'storage-failed') })
    return () => controller.abort()
  }, [api, sessionId, revision])
  const run = async fn => {
    if (busy) return
    setBusy(true); setError('')
    try { await fn(new AbortController().signal) } catch (error) { setError(error.reason ?? 'storage-failed') }
    finally { setBusy(false) }
  }
  return <details className="sn-storage"><summary>{t('saveLocation')}</summary>
    {error && <p role="alert">{t(error)}</p>}
    {location && <>
      <p className="sn-path">{location.path}</p>
      <Button size="sm" disabled={busy || !location.canOpen} onClick={() => run(async signal => unwrap(await api.openStorageLocation(sessionId, location.workspaceId, signal)))}>{t('openSaveFolder')}</Button>
      {!location.canOpen && <p className="sn-notice">{t('openOnHost')}</p>}
      <label className="sn-field">{t('storageRoot')}<Input className="sn-input" aria-label={t('storageRoot')} value={root} disabled={busy || !editable} onChange={event => setRoot(event.target.value)} /></label>
      {!!location.previousRoots.length && <Select aria-label={t('previousLocations')} value="" disabled={busy || !editable} onChange={event => { if (event.target.value) setRoot(event.target.value) }}><option value="">{t('previousLocations')}</option>{location.previousRoots.map(path => <option key={path} value={path}>{path}</option>)}</Select>}
      <p className="sn-notice">{t('switchLocationHint')}</p>
      <div className="sn-row sn-recovery-actions">
        {location.canPick && <Button size="sm" disabled={busy || !editable} onClick={() => run(async signal => { const value = unwrap(await api.pickStorageLocation(sessionId, signal)); if (value.selected) setRoot(value.root) })}>{t('chooseFolder')}</Button>}
        <Button size="sm" disabled={busy || !editable || root === location.root || !root.trim()} onClick={() => run(async signal => {
          switching(true)
          try {
            await beforeSwitch()
            const value = unwrap(await api.changeStorageLocation(sessionId, { root: root.trim(), expectedWorkspaceId: location.workspaceId }, signal))
            setLocation(value); setRoot(value.root); switched()
          } finally { switching(false) }
        })}>{t('switchLocation')}</Button>
        {root !== location.defaultRoot && <Button size="sm" disabled={busy || !editable} onClick={() => setRoot(location.defaultRoot)}>{t('defaultLocation')}</Button>}
      </div>
    </>}
  </details>
}
