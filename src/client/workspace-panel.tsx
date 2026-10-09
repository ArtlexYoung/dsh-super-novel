import React, { useEffect, useRef, useState } from 'react'
import { Button, IconCloseOutline16 } from './primitives.js'

/** Measure the plugin pane, including native host resizing and fullscreen. */
export function useCompactPane(ref) {
  const [compact, setCompact] = useState(true)
  useEffect(() => {
    const element = ref.current
    const measure = () => setCompact(element.clientWidth < 760)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return compact
}

/** Panels stay mounted so opening a tool does not replace the editor or its undo history. */
export function WorkspacePanel({ id, title, open, inline = false, inactive = false, close, t, children }) {
  const panel = useRef(null), heading = useRef(null), latestClose = useRef(close)
  latestClose.current = close
  useEffect(() => {
    if (!open || inline) return
    const previous = document.activeElement
    heading.current.focus({ preventScroll: true })
    const trap = event => {
      // A tool may replace the focused list button with a preview. Keep Escape usable
      // when the browser moves focus to body, without capturing other host controls.
      if (event.target !== document.body && !panel.current.closest('.sn-books').contains(event.target)) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); latestClose.current(); return }
      if (event.key !== 'Tab') return
      const controls = [...panel.current.querySelectorAll('button,input,select,textarea,[tabindex]')].filter(element =>
        !element.disabled && element.tabIndex >= 0 && element.getClientRects().length)
      if (!controls.length) { event.preventDefault(); heading.current.focus(); return }
      const at = controls.indexOf(document.activeElement)
      if (event.shiftKey && at <= 0) { event.preventDefault(); controls.at(-1).focus() }
      else if (!event.shiftKey && (at < 0 || at === controls.length - 1)) { event.preventDefault(); controls[0].focus() }
    }
    document.addEventListener('keydown', trap)
    return () => { document.removeEventListener('keydown', trap); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [open, inline])
  return <section id={id} ref={panel} hidden={!open} inert={inactive} aria-hidden={inactive ? 'true' : undefined} className={`sn-workspace-panel${inline ? ' sn-inline-panel' : ''}`} role={inline ? 'region' : 'dialog'} aria-modal={!inline && open ? 'true' : undefined} aria-labelledby={`${id}-title`}>
    <header className="sn-panel-heading"><h3 id={`${id}-title`} ref={heading} tabIndex={-1}>{title}</h3>{!inline && <Button size="sm" className="sn-icon" aria-label={t('backToWriting')} title={t('backToWriting')} onClick={close}><IconCloseOutline16 /></Button>}</header>
    <div className="sn-panel-body">{children}</div>
  </section>
}
