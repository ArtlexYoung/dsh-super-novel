/** Browser contribution uses the public sidebar slots and generated Remote codecs. */
import React, { useEffect, useState } from 'react'
import contribution from '../../lib/typert.remote-client.js'
const NS = 'superNovel'
const zh = {
  title: '小说生成工作台', intro: '启用专门生成小说的模式，保留其他模式和默认设置。',
  preview: '技术预览：当前提供小说生成模式与侧栏入口。章节管理、事实回填和独立审校正在开发。',
  available: '小说生成模式尚未启用', enabled: '小说生成模式已就绪',
  enabledHint: '请在宿主模式选择器中选择 Super Novel · 小说生成，开始对话。',
  enable: '启用小说生成模式', resume: '继续启用', refresh: '重新检查', working: '正在启用…',
  incomplete: '上次启用未完成，可以继续。', unavailable: '当前宿主无法提供可用的用户预设目录或发现该模式。',
  conflict: '已有同名内容或预设被修改。为保护你的设置，未进行覆盖。',
  busy: '另一次启用仍在进行，或上次进程退出后留下了锁。请查看安装恢复说明。',
  error: '读取或启用失败。请检查宿主日志和目录权限后重试。', loading: '正在检查小说生成模式…',
}
const en = {
  title: 'Novel generation workspace', intro: 'Enable a novel-generation mode while keeping your existing modes and default.',
  preview: 'Technical preview: novel-generation mode and sidebar entry only. Chapter management, fact updates, and independent review are in development.',
  available: 'Novel-generation mode is not enabled', enabled: 'Novel-generation mode is ready',
  enabledHint: 'Select Super Novel · 小说生成 in the host mode picker to begin.',
  enable: 'Enable novel-generation mode', resume: 'Resume setup', refresh: 'Check again', working: 'Enabling…',
  incomplete: 'Setup was interrupted and can be resumed.', unavailable: 'The host cannot provide a usable user preset root or discover this mode.',
  conflict: 'The name is occupied or the preset was modified. Your existing files were preserved.',
  busy: 'Another setup is running, or a previous process left a lock. See setup recovery instructions.',
  error: 'Could not read or enable the preset. Check host logs and directory permissions, then retry.', loading: 'Checking novel-generation mode…',
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
  return <section className="super-novel-setup" aria-label={t('title')}>
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
    style.textContent = `.super-novel-setup{padding:24px 20px;overflow:auto;height:100%;box-sizing:border-box;font-size:14px;line-height:1.7}.super-novel-setup h2{font-size:18px;margin:0 0 12px}.super-novel-setup p{overflow-wrap:anywhere}.super-novel-setup button{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l1,#999);border-radius:8px;min-height:36px;padding:5px 12px;margin:4px 8px 8px 0;cursor:pointer}.super-novel-setup button:focus-visible{outline:2px solid currentColor;outline-offset:3px}.super-novel-setup aside{margin-top:28px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1,#999);font-size:12px;opacity:.75}`
    document.head.appendChild(style)
    return () => style.remove()
  })
}
