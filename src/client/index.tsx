/** Browser contribution uses the public sidebar slots and generated Remote codecs. */
import { Button } from './primitives.js'
import React, { useEffect, useState } from 'react'
import contribution from '../../lib/typert.remote-client.js'
import { Books, unwrap } from './books.js'
import { zh, en } from './locales.js'
import { styles } from './styles.js'
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
    {(status === 'available' || status === 'incomplete') && <Button size="sm" onClick={enable}>{t(status === 'incomplete' ? 'resume' : 'enable')}</Button>}
    {status !== 'working' && status !== 'loading' && <Button size="sm" onClick={() => setRefresh(value => value + 1)}>{t('refresh')}</Button>}
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
    style.textContent = styles
    document.head.appendChild(style)
    return () => style.remove()
  })
}
