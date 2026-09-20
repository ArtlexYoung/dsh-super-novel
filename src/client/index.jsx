/** Browser contribution uses the public sidebar slots and generated Remote codecs. */
import React, { useEffect, useState } from 'react'
import contribution from '../../lib/typert.remote-client.js'
const NS = 'superWrite'
const zh = {
  title: '小说工作台', intro: '启用专门写小说的模式，保留其他模式和默认设置。',
  preview: '技术预览：当前提供写作模式与侧栏入口。章节管理、事实回填和独立审校正在开发。',
  available: '写作模式尚未启用', enabled: '写作模式已就绪',
  enabledHint: '请在宿主模式选择器中选择 Super Write · 小说写作，开始对话。',
  enable: '启用写作模式', resume: '继续启用', refresh: '重新检查', working: '正在启用…',
  incomplete: '上次启用未完成，可以继续。', unavailable: '当前宿主无法提供可用的用户预设目录或发现该模式。',
  conflict: '已有同名内容或预设被修改。为保护你的设置，未进行覆盖。',
  busy: '另一次启用仍在进行，或上次进程退出后留下了锁。请查看安装恢复说明。',
  error: '读取或启用失败。请检查宿主日志和目录权限后重试。', loading: '正在检查写作模式…',
}
const en = {
  title: 'Novel workspace', intro: 'Enable a writing mode while keeping your existing modes and default.',
  preview: 'Technical preview: writing mode and sidebar entry only. Chapter management, fact updates, and independent review are in development.',
  available: 'Writing mode is not enabled', enabled: 'Writing mode is ready',
  enabledHint: 'Select Super Write · 小说写作 in the host mode picker to begin.',
  enable: 'Enable writing mode', resume: 'Resume setup', refresh: 'Check again', working: 'Enabling…',
  incomplete: 'Setup was interrupted and can be resumed.', unavailable: 'The host cannot provide a usable user preset root or discover this mode.',
  conflict: 'The name is occupied or the preset was modified. Your existing files were preserved.',
  busy: 'Another setup is running, or a previous process left a lock. See setup recovery instructions.',
  error: 'Could not read or enable the preset. Check host logs and directory permissions, then retry.', loading: 'Checking writing mode…',
}
function unwrap(result) {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
function Setup({ api, t }) {
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
  return <section className="super-write-setup" aria-label={t('title')}>
    <h2>{t('title')}</h2><p>{t('intro')}</p>
    <p role={status === 'error' || status === 'conflict' ? 'alert' : 'status'}>{t(status)}</p>
    {status === 'enabled' && <p>{t('enabledHint')}</p>}
    {(status === 'available' || status === 'incomplete') && <button onClick={enable}>{t(status === 'incomplete' ? 'resume' : 'enable')}</button>}
    {status !== 'working' && status !== 'loading' && <button onClick={() => setRefresh(value => value + 1)}>{t('refresh')}</button>}
    <aside>{t('preview')}</aside>
  </section>
}
function TabTitle({ t }) { return <span>{t('title')}</span> }
export const inject = ['remote', 'slots', 'sidebarRightTabs', 'locale']
export async function apply(ctx) {
  await ctx.remote.$mount(contribution)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  ctx.inject(['remote.superWrite'], (ctx) => {
    const t = ctx.locale.bind(NS)
    const disposeType = ctx.sidebarRightTabs.register({
      id: 'dsh-super-write', kind: 'super-write', title: () => t('title'),
      guide: [{ order: 45, title: () => t('title'), description: () => t('intro') }],
    })
    ctx.effect(() => disposeType)
    const api = ctx.get('remote.superWrite')
    ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: 'dsh-super-write', locale: NS,
      inject: () => ({ api }),
    }, Setup))
    ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.title', key: 'dsh-super-write', locale: NS,
    }, TabTitle))
  })
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = `.super-write-setup{padding:24px 20px;overflow:auto;height:100%;box-sizing:border-box;font-size:14px;line-height:1.7}.super-write-setup h2{font-size:18px;margin:0 0 12px}.super-write-setup p{overflow-wrap:anywhere}.super-write-setup button{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l1,#999);border-radius:8px;min-height:36px;padding:5px 12px;margin:4px 8px 8px 0;cursor:pointer}.super-write-setup button:focus-visible{outline:2px solid currentColor;outline-offset:3px}.super-write-setup aside{margin-top:28px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1,#999);font-size:12px;opacity:.75}`
    document.head.appendChild(style)
    return () => style.remove()
  })
}
