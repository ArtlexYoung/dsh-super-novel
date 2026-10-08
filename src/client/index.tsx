/** Browser contribution uses the public sidebar slots and generated Remote codecs. */
import React, { useEffect, useState } from 'react'
import contribution from '../../lib/typert.remote-client.js'
import { Books, unwrap } from './books.js'
import { zh, en } from './locales.js'
const NS = 'superNovel'
function Setup({ api, sessionId, t }) {
  const [state, setState] = useState({ kind: 'loading' })
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let live = true
    const controller = new AbortController()
    setState({ kind: 'loading' })
    api.status(controller.signal).then(unwrap).then(value => { if (live) setState({ kind: 'ready', value }) }, () => { if (live) setState({ kind: 'error' }) })
    return () => { live = false; controller.abort() }
  }, [api, refresh])
  const pending = React.useRef(null)
  useEffect(() => () => { pending.current?.abort() }, [])
  const enable = async () => {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setState({ kind: 'working' })
    try {
      const value = unwrap(await api.enable(controller.signal))
      if (!controller.signal.aborted) setState({ kind: 'ready', value })
    } catch { if (!controller.signal.aborted) setState({ kind: 'error' }) }
    finally { pending.current = null }
  }
  const status = state.kind === 'ready' ? state.value.state : state.kind
  return <div className="super-novel-setup">
    <Books key={sessionId} api={api} sessionId={sessionId} t={t} />
    <details className="sn-setup"><summary>{t('setup')}</summary>
    <p role={status === 'error' || status === 'conflict' ? 'alert' : 'status'}>{t(status)}</p>
    {(status === 'available' || status === 'incomplete') && <button onClick={enable}>{t(status === 'incomplete' ? 'resume' : 'enable')}</button>}
    {status !== 'working' && status !== 'loading' && <button onClick={() => setRefresh(value => value + 1)}>{t('refresh')}</button>}
    </details>
  </div>
}
function TabTitle({ t }) { return <span>{t('title')}</span> }
export const inject = ['remote', 'slots', 'sidebarRightTabs', 'locale']
export async function apply(ctx) {
  await ctx.remote.$mount(contribution)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  ctx.inject(['remote.superNovel'], (ctx) => {
    const t = ctx.locale.bind(NS)
    const disposeType = ctx.sidebarRightTabs.register({
      id: 'dsh-super-novel', kind: 'super-novel', title: () => t('title'),
      guide: [{ order: 45, title: () => t('title'), description: () => t('intro') }],
    })
    ctx.effect(() => disposeType)
    const api = ctx.get('remote.superNovel')
    ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: 'dsh-super-novel', locale: NS,
      inject: () => ({ api }),
    }, Setup))
    ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.title', key: 'dsh-super-novel', locale: NS,
    }, TabTitle))
  })
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = `.super-novel-setup{padding:16px;overflow:auto;height:100%;box-sizing:border-box;font-size:14px;line-height:1.6;letter-spacing:0}.super-novel-setup *{box-sizing:border-box}.super-novel-setup h2{font-size:16px;margin:0;font-weight:600}.super-novel-setup p{overflow-wrap:anywhere;margin:8px 0}.super-novel-setup button,.super-novel-setup input,.super-novel-setup select{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l1,#aaa);border-radius:4px;min-height:32px;background:transparent;min-width:0}.super-novel-setup button{padding:4px 8px;cursor:pointer}.super-novel-setup button:disabled{opacity:.4;cursor:default}.super-novel-setup :focus-visible{outline:2px solid var(--dsw-alias-brand,#3478d4);outline-offset:2px}.super-novel-setup input,.super-novel-setup select{padding:5px 8px;width:100%}.sn-toolbar{display:flex;align-items:center;gap:8px;min-height:36px}.sn-toolbar h2{flex:1}.sn-icon{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;flex:0 0 32px;padding:0!important}.sn-workspace{font-size:12px;opacity:.65;margin:4px 0 12px;overflow-wrap:anywhere}.sn-field{display:grid;gap:4px;margin:8px 0}.sn-row{display:flex;gap:6px;align-items:center;margin:8px 0}.sn-row input{flex:1}.sn-chapters{max-height:180px;overflow:auto;border-top:1px solid var(--dsw-alias-border-l1,#aaa);border-bottom:1px solid var(--dsw-alias-border-l1,#aaa);margin-top:16px;padding:4px 0}.sn-chapters button{display:flex;gap:8px;text-align:left;width:100%;border:0;border-radius:0;align-items:baseline;overflow-wrap:anywhere}.sn-chapters button[aria-current=true]{background:var(--dsw-alias-bg-l2,rgba(120,120,120,.12));font-weight:600}.sn-number{min-width:24px;font-size:12px;opacity:.6}.sn-editor-toolbar{justify-content:space-between;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l1,#aaa);padding-top:8px;margin-top:12px}.sn-editor-toolbar [role=status]{font-size:12px;opacity:.7}.sn-modes{display:flex}.sn-modes button{border:0}.sn-modes button[aria-pressed=true]{background:var(--dsw-alias-bg-l2,rgba(120,120,120,.12))}.sn-books textarea,.sn-preview{width:100%;height:360px;min-height:200px;max-height:70vh;overflow:auto;resize:vertical;font:inherit;line-height:1.8;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l1,#aaa);border-radius:4px;padding:12px;margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}.sn-preview{margin-top:8px}.sn-alert{color:var(--dsw-alias-warning,#b85c00)}.sn-notice{font-size:12px;opacity:.75}.sn-recovery-actions{flex-wrap:wrap}.sn-recovery-actions button{font-size:12px}.sn-setup{margin-top:20px;border-top:1px solid var(--dsw-alias-border-l1,#aaa);padding-top:12px}.sn-setup summary{cursor:pointer;font-size:12px}.sn-setup p{font-size:12px}.sn-setup button{margin:4px 6px 4px 0}@media(min-width:900px){.sn-books textarea,.sn-preview{height:460px}}`
    document.head.appendChild(style)
    style.textContent += `.sn-reviews{border-top:1px solid var(--dsw-alias-border-l1,#aaa);margin-top:20px;padding-top:12px}.sn-reviews h3{font-size:14px;margin:0}.sn-reviews .sn-row{flex-wrap:wrap}.sn-review-dimensions{display:flex;gap:10px;flex-wrap:wrap;font-size:12px}.sn-review-issue{padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#aaa)}.sn-review-issue blockquote{margin:8px 0;padding-left:10px;border-left:3px solid #a34b4b;overflow-wrap:anywhere}.sn-limits{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}`
    style.textContent += `.sn-work-tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;margin:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#aaa)}.sn-work-tabs button{border:0;border-radius:0;font-size:12px;min-height:36px;padding:4px}.sn-work-tabs button[aria-selected=true]{border-bottom:2px solid var(--dsw-alias-brand,#3478d4);font-weight:600}.sn-books [hidden]{display:none!important}.sn-voices,.sn-transfer{border-top:1px solid var(--dsw-alias-border-l1,#aaa);margin-top:12px;padding-top:8px}.sn-voices h3{font-size:14px}.sn-voices input[type=checkbox]{width:auto}.sn-voice{padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#aaa)}.sn-voice blockquote{margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}.sn-import-preview{max-height:180px;overflow:auto;padding-left:24px}.sn-import-preview li{overflow-wrap:anywhere}`
    style.textContent += `.sn-facts{border-top:1px solid var(--dsw-alias-border-l1,#aaa);margin-top:20px;padding-top:12px}.sn-facts h3{font-size:14px;margin:0}.sn-fact{border-bottom:1px solid var(--dsw-alias-border-l1,#aaa);padding:8px 0}.sn-facts blockquote{margin:8px 0;padding-left:10px;border-left:3px solid #39815b;overflow-wrap:anywhere}.sn-fact-settings label{display:flex;gap:8px;align-items:center}.sn-fact-settings input{width:16px;min-height:16px;flex:0 0 16px}.sn-facts .sn-row{flex-wrap:wrap}`
    style.textContent += `.sn-material-list{max-height:220px;overflow:auto}.sn-material-list label{display:flex;align-items:baseline;gap:8px;margin:6px 0;overflow-wrap:anywhere}.sn-material-list input{width:16px;min-height:16px;flex:0 0 16px}.sn-modes [aria-selected=true]{background:var(--dsw-alias-bg-l2,rgba(120,120,120,.12))}`
    style.textContent += `.sn-material-creator{margin:12px 0;padding:10px;border:1px solid var(--dsw-alias-border-l1,#aaa);border-radius:4px}.sn-material-creator summary{cursor:pointer}.sn-material-creator .sn-instruction{height:100px;min-height:72px;margin:0}.sn-material-creator .sn-row{flex-wrap:wrap}.sn-material-creator .sn-row button{white-space:normal;text-align:left}.sn-material-heading{font-size:14px;margin:20px 0 8px}`
    style.textContent += `.sn-history{border-top:1px solid var(--dsw-alias-border-l1,#aaa);padding-top:10px;margin-top:12px}.sn-history summary{cursor:pointer}.sn-history details+details{margin-top:12px}.sn-history .sn-row{flex-wrap:wrap}.sn-history select{max-width:100%}`
    style.textContent += `.sn-proposals{border-top:1px solid var(--dsw-alias-border-l1,#aaa);margin-top:20px;padding-top:12px}.sn-proposals h3{font-size:14px;margin:0 0 8px}.sn-proposals summary{cursor:pointer}.sn-proposals .sn-instruction,.sn-proposals .sn-materials{height:110px;min-height:72px;margin:0}.sn-proposals .sn-materials{height:160px}.sn-generation{margin-bottom:12px}.sn-candidate-status{justify-content:space-between;flex-wrap:wrap}.sn-candidate-status [role=status]{font-size:12px}.sn-candidate,.sn-diff pre{white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;max-height:380px;min-height:64px;font:inherit;line-height:1.8;padding:10px;margin:6px 0;border:1px solid var(--dsw-alias-border-l1,#aaa);border-radius:4px}.sn-diff{display:grid;gap:8px;grid-template-columns:minmax(0,1fr)}.sn-diff h4{font-size:12px;font-weight:500;margin:8px 0 0}.sn-diff>div:first-child pre{border-left:3px solid #a34b4b}.sn-diff>div:last-child pre{border-left:3px solid #39815b}.sn-decision{display:inline-flex;align-items:center;gap:5px}.sn-proposals .sn-row{flex-wrap:wrap}.sn-proposals .sn-row span{overflow-wrap:anywhere}@media(min-width:900px){.sn-diff{grid-template-columns:repeat(2,minmax(0,1fr))}}`
    return () => style.remove()
  })
}
