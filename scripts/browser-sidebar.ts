import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withWorkspace } from './browser-workspace.ts'

/** A mixed directory exercises pagination and links without calling a provider. */
export async function createSidebarFixture(output) {
  const bookId = randomUUID(), folder = join(output, 'workspace/novels', bookId), chapters = []
  await mkdir(join(folder, 'chapters'), { recursive: true })
  await mkdir(join(folder, 'transactions'))
  const add = async (title, content, kind = '', linkedChapterId = '', chapterId = randomUUID()) => {
    const item = { chapterId, title, revision: 1, hash: createHash('sha256').update(content).digest('hex'), ...(kind && { kind }), ...(linkedChapterId && { linkedChapterId }) }
    chapters.push(item); await writeFile(join(folder, 'chapters', `${item.chapterId}.md`), content)
    return item.chapterId
  }
  const proseId = await add('第一章', '渡口原文。'), secondId = await add('第二章', '船上原文。', 'chapter')
  await add('第三章', '下一章原文。', 'chapter')
  for (const kind of ['seed', 'book-card', 'character', 'world', 'outline', 'chapter-outline', 'scene']) {
    for (let i = 1; i <= 20; i++) await add(`资料 ${kind} ${String(i).padStart(2, '0')}`, `已保存 ${kind} ${i}。`, kind,
      ['scene', 'chapter-outline'].includes(kind) ? i % 3 === 1 ? proseId : i % 3 === 2 ? secondId : '' : '')
  }
  const sourceHash = chapters[0].hash
  await add('专用事实', JSON.stringify({ schemaVersion: 1, sourceChapterId: proseId, sourceRevision: 1, sourceHash, facts: [], coverage: 'selection' }), 'facts', proseId)
  const voiceId = randomUUID()
  await add('专用授权', JSON.stringify({ schemaVersion: 1, voiceId, sourceChapterId: proseId, sourceRevision: 1, sourceHash, channel: 'narration', characterId: '', sourceDescription: '固定响应测试样本', sample: '渡口原文。', start: 0, end: 5, authorized: false, authorizedAt: 0 }), 'voice', '', voiceId)
  await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, bookId, title: '侧栏素材管理 0.1.3', revision: 1, chapters }))
  const identity = { bookId, proseId, secondId }
  await writeFile(join(output, 'sidebar-book.json'), JSON.stringify(identity))
  return identity
}

/** The same controls run in Web and the native Electron custom-protocol page. */
export async function checkSidebar(page, output, identity, resize = size => page.setViewportSize(size), mode = 'workflow') {
  const directory = page.locator('.sn-directory'), content = page.locator('.sn-document'), materials = page.getByRole('textbox', { name: 'Material text', exact: true })
  const tab = name => page.getByRole('tablist', { name: 'Book documents', exact: true }).getByRole('tab', { name, exact: true }).click()
  const creator = page.locator('.sn-material-creator'), panel = page.locator('.sn-proposals')
  const calls = async () => JSON.parse(await readFile(join(output, 'generation-calls.json'), 'utf8').catch(() => '[]')).length
  const before = await calls()
  const titleIs = title => page.waitForFunction(value => document.querySelector('input[aria-label="Rename"]')?.value === value, title)
  const checkWidth = async (expected, columns) => {
    await page.waitForFunction(({ expected, columns }) => {
      const root = document.querySelector('.super-novel-setup'), layout = document.querySelector('.sn-book-workspace')
      return Math.abs(root.clientWidth - expected) < 3 && getComputedStyle(layout).gridTemplateColumns.split(' ').length === columns
    }, { expected, columns })
    assert(await page.locator('.super-novel-setup').evaluate(el => el.scrollWidth <= el.clientWidth + 1))
    assert(await content.evaluate(el => el.scrollWidth <= el.clientWidth + 1))
  }
  const narrow = async width => {
    const handle = page.locator('[data-side="rightbar"]')
    await handle.hover({ position: { x: 1, y: 20 } })
    const box = await handle.boundingBox()
    assert(box, 'Host right-sidebar resize handle must be available')
    const viewport = await page.evaluate(() => innerWidth)
    // The panel overlays the handle's right half. Grab its exposed left edge.
    const currentWidth = await page.locator('.super-novel-setup').evaluate(el => el.clientWidth)
    const startX = box.x + 1, offset = startX - (viewport - currentWidth)
    await page.mouse.move(startX, box.y + 20); await page.mouse.down()
    await page.mouse.move(viewport - width + offset, box.y + 20, { steps: 8 }); await page.mouse.up()
    await checkWidth(width, 1)
  }
  await page.getByRole('button', { name: 'Refresh', exact: true }).first().click()
  await page.getByLabel('Book', { exact: true }).selectOption(identity.bookId)
  await tab('Materials and plans')
  if (!await directory.evaluate(el => el.open)) await directory.locator(':scope > summary').click()
  await page.locator('.sn-chapters button').first().waitFor()
  assert.equal(await page.locator('.sn-chapters button').count(), 100)
  await page.getByRole('button', { name: 'Next page', exact: true }).click()
  assert.equal(await page.locator('.sn-chapters button').count(), mode === 'workflow' ? 40 : 41)
  await page.getByLabel('Filter material type', { exact: true }).selectOption('scene')
  assert.equal(await page.locator('.sn-chapters button').count(), 20)
  await page.getByLabel('Filter related chapter', { exact: true }).selectOption(identity.proseId)
  assert.equal(await page.locator('.sn-chapters button').count(), 7)
  await page.getByLabel('Search chapters or materials', { exact: true }).fill('scene 01')
  assert.equal(await page.locator('.sn-chapters button').count(), 1)
  await page.locator('.sn-chapters button').click(); await titleIs('资料 scene 01')
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Material text"]')?.value === '已保存 scene 1。')
  await materials.fill('缩放中保留的未保存素材草稿。')
  await page.getByLabel('Filter material type', { exact: true }).selectOption('world')
  await directory.getByText('No matching documents. Adjust or clear the filters.', { exact: true }).waitFor()
  assert.equal(await materials.inputValue(), '缩放中保留的未保存素材草稿。')
  await directory.getByText('The document being edited is outside the filters. Its content is retained.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await page.getByLabel('Filter related chapter', { exact: true }).selectOption('unlinked')
  assert.equal(await page.locator('.sn-chapters button').count(), 100)
  assert(!await page.locator('.sn-chapters').innerText().then(text => text.includes('专用事实') || text.includes('专用授权')))
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await resize({ width: 1440, height: 1000 })
  await narrow(300)
  await materials.scrollIntoViewIfNeeded(); assert.equal(await materials.inputValue(), '缩放中保留的未保存素材草稿。')
  await directory.locator(':scope > summary').click()
  assert(!await directory.evaluate(el => el.open))
  await materials.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, 'sidebar-300-en-light.png') })
  await directory.locator(':scope > summary').click(); await narrow(420)
  assert.equal(await materials.inputValue(), '缩放中保留的未保存素材草稿。')
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click(); await resize({ width: 900, height: 800 }); await checkWidth(900, 2)
  const directoryTop = await directory.evaluate(el => el.getBoundingClientRect().top)
  await content.evaluate(el => { el.scrollTop = el.scrollHeight })
  assert.equal(await directory.evaluate(el => el.getBoundingClientRect().top), directoryTop)
  assert.equal(await materials.inputValue(), '缩放中保留的未保存素材草稿。')
  await page.getByRole('button', { name: 'Read disk version', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Material text"]')?.value === '已保存 scene 1。')
  if (mode === 'workflow') {
    // Creation resets both filters; the generated target remains visible at 300px and fullscreen.
    await page.getByLabel('Filter material type', { exact: true }).selectOption('world')
    await page.getByLabel('Filter related chapter', { exact: true }).selectOption(identity.proseId)
    if (!await creator.evaluate(el => el.open)) await creator.locator(':scope > summary').click()
    await creator.getByLabel('Material type', { exact: true }).selectOption('character')
    await creator.getByLabel('Material name', { exact: true }).fill('侧栏新人物')
    await creator.getByRole('button', { name: 'Generate material with AI', exact: true }).click()
    await titleIs('侧栏新人物')
    await panel.locator('.sn-candidate-status [role=status]').filter({ hasText: /^Ready for review$/ }).waitFor()
    assert.equal(await page.getByLabel('Filter material type', { exact: true }).inputValue(), 'all')
    assert.equal(await page.getByLabel('Filter related chapter', { exact: true }).inputValue(), 'all')
    await page.getByLabel('Search chapters or materials', { exact: true }).fill('侧栏新人物')
    assert.equal(await page.locator('.sn-chapters button').count(), 1)
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click(); await resize({ width: 1440, height: 1000 }); await narrow(300)
    await panel.getByRole('button', { name: 'Changes', exact: true }).click()
    assert.equal(await page.locator('.sn-diff').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1)
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click(); await resize({ width: 900, height: 800 }); await checkWidth(900, 2)
    await panel.getByRole('button', { name: 'Accept', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="Material text"]')?.value.includes('候选前句'))
    assert.equal(await calls(), before + 1)
  } else {
    await page.getByLabel('Search chapters or materials', { exact: true }).fill('侧栏新人物')
    await page.locator('.sn-chapters button').click(); await titleIs('侧栏新人物')
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="Material text"]')?.value.includes('候选前句'))
    await panel.locator('.sn-candidate-status [role=status]').filter({ hasText: /^Accepted$/ }).waitFor()
    assert.equal(await calls(), before)
  }
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await page.getByLabel('Filter material type', { exact: true }).selectOption('scene')
  await page.getByLabel('Filter related chapter', { exact: true }).selectOption(identity.proseId)
  // The fullscreen pane covers the host rail; open host settings in docked mode.
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click()
  await resize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Dark', exact: true }).click(); await page.getByRole('button', { name: 'English', exact: true }).click(); await page.getByText('中文', { exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByLabel('筛选资料类型', { exact: true }).waitFor()
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await resize({ width: 900, height: 800 })
  await checkWidth(900, 2)
  await content.evaluate(el => { el.scrollTop = 0 })
  await directory.evaluate(el => { el.scrollTop = 0 })
  await page.screenshot({ path: join(output, 'sidebar-materials-zh-dark.png') })
  assert(await page.locator('.super-novel-setup').evaluate(el => el.scrollWidth <= el.clientWidth + 1))
  console.log(`PASS ${mode}: mixed materials, pagination, type/link/search filters, 300/420px pane, 900px fullscreen, draft and candidate retention, language/theme; ${mode === 'workflow' ? 'generation and adoption' : 'query-only reopen'}.`)
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = resolve(process.argv[2]), mode = process.argv[3] ?? 'workflow'
  const identity = mode === 'workflow' ? await createSidebarFixture(output) : JSON.parse(await readFile(join(output, 'sidebar-book.json'), 'utf8'))
  await withWorkspace(output, page => checkSidebar(page, output, identity, undefined, mode))
}
