/** Real Web + packed plugin smoke. Requires the isolated preview, never calls a model. */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
const output = resolve(process.argv[2] ?? '.test-output/preview-v003')
const playwrightPath = process.env.PLAYWRIGHT_MODULE
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_MODULE to the existing Playwright index.ts path')
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)).href)
const browser = await chromium.launch({ headless: true })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(10_000)
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 'super-novel-preview-a' })))
  // Host onboarding may appear only when a blank session becomes active.
  for (const name of ['Continue', 'Configure later']) {
    await page.addLocatorHandler(page.getByRole('button', { name, exact: true }), button => button.click())
  }
  await page.goto(await readFile(resolve(output, 'preview-url'), 'utf8'))
  await page.getByRole('button', { name: /^(Settings|设置)$/ }).waitFor()
  if (await page.getByRole('button', { name: '设置', exact: true }).isVisible()) {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '中文', exact: true }).click()
    await page.getByText('English', { exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  }
  await page.getByRole('button', { name: 'Open right sidebar', exact: true }).waitFor()
  const openPanel = async () => {
    const expand = page.getByRole('button', { name: 'Open right sidebar', exact: true })
    if (await expand.isVisible()) await expand.click()
    const body = page.locator('.super-novel-setup')
    const guide = page.getByText('Novel workspace', { exact: true })
    await body.or(guide).first().waitFor()
    if (!await body.isVisible()) await guide.click()
    await body.waitFor()
    assert.equal(await body.count(), 1)
    if (!await body.locator('details').evaluate(element => element.open)) await body.locator('summary').click()
  }
  await openPanel()
  const enable = page.getByRole('button', { name: 'Enable novel-generation mode', exact: true })
  await page.locator('.super-novel-setup [role="status"]').filter({ hasText: /Novel-generation mode/ }).waitFor()
  if (await enable.isVisible()) await enable.click()
  await page.getByText('Novel-generation mode is ready', { exact: true }).waitFor()
  await page.locator('.sn-setup').getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.getByText('Novel-generation mode is ready', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await openPanel()
  await page.getByText('Novel-generation mode is ready', { exact: true }).waitFor()
  await page.getByText('super-novel-preview-b', { exact: true }).first().click()
  await openPanel()
  await page.getByText('Novel-generation mode is ready', { exact: true }).waitFor()
  await mkdir('.test-output/screenshots', { recursive: true })
  await page.screenshot({ path: '.test-output/screenshots/en-light.png' })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Dark', exact: true }).click()
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await page.getByText('中文', { exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByText('小说生成模式已就绪', { exact: true }).waitFor()
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await page.setViewportSize({ width: 900, height: 800 })
  await page.screenshot({ path: '.test-output/screenshots/zh-dark-narrow.png' })
  const body = page.locator('.super-novel-setup')
  assert(await body.evaluate(element => element.scrollWidth <= element.clientWidth))
  const bounds = await body.boundingBox()
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 901)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: '退出全屏', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '中文', exact: true }).click()
  await page.getByText('English', { exact: true }).click()
  await page.getByRole('button', { name: 'Light', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: 'New session', exact: true }).last().click()
  await page.getByTitle('Agent preset for the session you are about to start', { exact: true }).waitFor()
  await page.getByTitle('Agent preset for the session you are about to start', { exact: true }).click()
  await page.getByRole('menuitem', { name: /^Super Novel · 小说生成/ }).click()
  await page.getByRole('button', { name: 'Super Novel · 小说生成', exact: true }).waitFor()
  assert.deepEqual(errors, [])
  console.log('PASS: packed sidebar RPC, enable/status, tab reopen, session switch, zh/en, dark/light, 900px fullscreen, native preset selection; no page errors.')
} finally {
  await browser.close()
}
