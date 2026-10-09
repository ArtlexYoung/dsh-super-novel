import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withWorkspace, openBookCreator, createChapter, openManagement, showContent, openDirectory } from './browser-workspace.ts'
export async function checkWritingActions(page, output) {
  await openBookCreator(page); await page.getByLabel('Book title', { exact: true }).fill('顺手写作验收'); await page.getByRole('button', { name: 'New book', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('select[aria-label=Book]')?.selectedOptions[0]?.textContent === '顺手写作验收')
  await createChapter(page, '第一章')
  const body = page.getByRole('textbox', { name: 'Chapter text', exact: true })
  await body.fill('灯还亮着。林舟走向渡口。'); await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.locator('.sn-editor-toolbar [role=status]').filter({ hasText: /^Saved$/ }).waitFor()
  const id = await body.getAttribute('data-chapter-id')
  await createChapter(page, '第二章'); await page.getByRole('button', { name: 'Previous chapter', exact: true }).click()
  await page.locator(`textarea[data-chapter-id="${id}"]`).waitFor()
  await body.click(); await page.keyboard.press('Meta+A'); await page.getByRole('button', { name: 'Selection AI', exact: true }).click()
  const selection = page.locator('#sn-panel-selection-ai'); assert((await selection.innerText()).includes('灯还亮着。'))
  await selection.getByRole('button', { name: 'Rewrite selection', exact: true }).click()
  await page.getByLabel('Writing task', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('Writing task', { exact: true }).inputValue(), 'rewrite')
  assert((await page.getByLabel('Writing instructions', { exact: true }).inputValue()).includes('selected passage'))
  await page.locator('#sn-tab-writing').click(); await openManagement(page)
  const preferences = page.getByText('Writing appearance', { exact: true }); await preferences.click()
  await page.getByLabel('Font size', { exact: true }).selectOption('20'); await page.getByLabel('Line spacing', { exact: true }).selectOption('2.2')
  await showContent(page)
  assert.equal(await body.evaluate(element => getComputedStyle(element).fontSize), '20px')
  assert.equal(await body.evaluate(element => getComputedStyle(element).lineHeight), '44px')
  await writeFile(join(output, 'writing-actions-validation.json'), JSON.stringify({ result: 'PASS', previousChapter: true, selectionRange: true, modePreselected: true, writingAppearance: true }, null, 2))
  console.log('PASS writing actions: previous chapter, selection AI range and appearance preferences.')
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await withWorkspace(resolve(process.argv[2]), page => checkWritingActions(page, resolve(process.argv[2])))
