import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'

/** Refuse to run UI generation before the isolated fixed-response route is ready. */
export async function waitForFixture(output: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const failure = await readFile(join(output, 'fixture-error.json'), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error
      return ''
    })
    if (failure) throw new Error(`Preview fixture failed: ${JSON.parse(failure).message}`)
    const ready = await readFile(join(output, 'sessions-check.json'), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error
      return ''
    })
    if (ready) {
      const sessions = JSON.parse(ready).items.map(item => item.sessionId)
      for (const id of ['super-novel-preview-a', 'super-novel-preview-b', 'super-novel-preview-readonly']) assert(sessions.includes(id))
      return
    }
    await setTimeout(100)
  }
  throw new Error('Preview fixture did not become ready; no generation checks were run')
}

/** Navigation failures must not print the preview's temporary credential. */
export async function visitPreview(page, output) {
  try { await page.goto(await readFile(join(output, 'preview-url'), 'utf8')) }
  catch (error) { throw new Error(error.message.replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]')) }
}

/** Follow the visible navigation used by authors; do not fill collapsed forms. */
export async function openBookCreator(page) {
  if (!await page.getByLabel('Book title', { exact: true }).isVisible()) await page.locator('.sn-book-picker button').click()
}

export async function showContent(page) {
  if (!await page.locator('#sn-tab-writing').getAttribute('aria-selected').then(value => value === 'true')) await page.locator('#sn-tab-writing').click()
}

export async function openGeneration(page) {
  if (!await page.locator('#sn-tab-revisions').getAttribute('aria-selected').then(value => value === 'true')) await page.locator('#sn-tab-revisions').click()
  await page.locator('.sn-proposals[data-loaded=true]').waitFor()
  const settings = page.locator('.sn-generation')
  if (!await settings.evaluate(element => element.open)) await settings.locator(':scope > summary').click()
}

export async function openDocumentOptions(page) {
  await showContent(page)
  const options = page.locator('.sn-document-options')
  if (!await options.evaluate(element => element.open)) await options.locator(':scope > summary').click()
}

export async function openHostSettings(page): Promise<void> {
  const settings = page.getByRole('button', { name: /^(Settings|设置)$/ })
  if (await settings.isVisible()) { await settings.click(); return }
  await page.getByRole('button', { name: /^(Account menu|账户菜单)$/ }).click()
  await page.getByText(/^(Settings|设置)$/, { exact: true }).click()
}

/** Shared setup for task-owned packed-plugin workflows. Never print the authenticated URL. */
export async function withWorkspace(output, run) {
  await waitForFixture(output)
  const modulePath = process.env.PLAYWRIGHT_MODULE
  if (!modulePath) throw new Error('Provide the installed Playwright module path')
  const { chromium } = await import(pathToFileURL(resolve(modulePath)).href)
  const browser = await chromium.launch({ headless: true })
  const errors = []
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(20_000)
    page.on('pageerror', error => errors.push(error.message))
    page.on('dialog', dialog => dialog.accept())
    await page.addInitScript(() => localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 'super-novel-preview-a' })))
    for (const name of ['Continue', 'Configure later']) await page.addLocatorHandler(page.getByRole('button', { name, exact: true }), button => button.click())
    await visitPreview(page, output)
    await page.getByRole('button', { name: /^(Settings|设置|Account menu|账户菜单)$/ }).first().waitFor()
    if (await page.getByRole('button', { name: '设置', exact: true }).isVisible()) {
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.getByRole('button', { name: '中文', exact: true }).click()
      await page.getByText('English', { exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
    }
    const expand = page.getByRole('button', { name: 'Open right sidebar', exact: true })
    const books = page.locator('.sn-books')
    const guide = page.getByText('Novel workspace', { exact: true })
    await books.or(guide).or(expand).first().waitFor()
    if (await expand.isVisible()) await expand.click()
    await books.or(guide).first().waitFor()
    if (!await books.isVisible()) await guide.click()
    await books.waitFor()
    try { await run(page) }
    catch (error) { await page.screenshot({ path: join(output, 'browser-failure.png') }).catch(() => {}); console.error(await page.locator('.sn-books').innerText({ timeout: 1000 }).catch(() => 'Novel panel unavailable')); throw error }
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
}
