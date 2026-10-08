import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

/** Shared setup for task-owned packed-plugin workflows. Never print the authenticated URL. */
export async function withWorkspace(output, run) {
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
    await page.goto(await readFile(join(output, 'preview-url'), 'utf8'))
    await page.getByRole('button', { name: /^(Settings|设置)$/ }).waitFor()
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
    catch (error) { await page.screenshot({ path: join(output, 'browser-failure.png') }); console.error(await page.locator('.sn-books').innerText()); throw error }
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
}
