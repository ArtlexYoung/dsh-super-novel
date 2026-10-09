import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withWorkspace, openBookCreator, createChapter, openManagement, openGeneration, openWritingTool, showContent } from './browser-workspace.ts'

export async function checkWritingMethods(page, output) {
  await openBookCreator(page); await page.getByLabel('Book title', { exact: true }).fill('写作方法验收'); await page.getByRole('button', { name: 'New book', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('select[aria-label=Book]')?.selectedOptions[0]?.textContent === '写作方法验收')
  await createChapter(page, '渡口')
  const body = page.locator('textarea.sn-editor'), text = '前文逐字保留。\n\n[TODO]\n\n后文逐字保留。'
  await body.fill(text); await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.locator('.sn-editor-toolbar [role=status]').filter({ hasText: /^Saved$/ }).waitFor()
  const original = await body.elementHandle()
  await openManagement(page); await page.getByRole('button', { name: 'Chapter intent', exact: true }).click()
  const panel = page.locator('#sn-panel-intent')
  await panel.getByLabel('Who wants what', { exact: true }).fill('在天亮前交信'); await panel.getByLabel('Viewpoint', { exact: true }).fill('林舟')
  await panel.getByText('Obstacle, choice and change (optional)', { exact: true }).click()
  await panel.getByLabel('Hard constraints', { exact: true }).fill('左腕不可用力。')
  await page.keyboard.press('Escape'); await panel.waitFor({ state: 'hidden' })
  assert(await body.evaluate((element, original) => element === original, original)); assert.equal(await body.inputValue(), text)
  await openManagement(page); await page.getByRole('button', { name: 'Chapter intent', exact: true }).click()
  assert.equal(await panel.getByLabel('Who wants what', { exact: true }).inputValue(), '在天亮前交信')
  await panel.getByRole('button', { name: 'Save intent', exact: true }).click(); await panel.getByText('Intent saved to disk', { exact: true }).waitFor()
  const chapterId = await body.getAttribute('data-chapter-id'), bookId = await body.getAttribute('data-book-id')
  assert.equal(JSON.parse(await readFile(join(output, 'workspace/novels', bookId, 'intents', chapterId, '00000001.json'), 'utf8')).request.intent.hardConstraints, '左腕不可用力。')
  await panel.getByText('AI scene directions', { exact: true }).click(); await panel.getByLabel('Direction instructions', { exact: true }).fill('给两种衔接方向')
  await panel.getByRole('button', { name: 'Suggest directions (one call)', exact: true }).click(); await panel.getByText('Directions ready; edit before saving', { exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Choose and edit', exact: true }).first().click(); assert.equal(await panel.getByLabel('Who wants what', { exact: true }).inputValue(), '在天亮前把信交给船夫。')
  await panel.getByRole('button', { name: 'Save intent', exact: true }).click(); await panel.getByText('Intent saved to disk', { exact: true }).waitFor()
  await page.keyboard.press('Escape'); await showContent(page); assert.equal(await body.inputValue(), text)
  await openGeneration(page); await page.getByLabel('Writing instructions', { exact: true }).fill('起草本章')
  await page.locator('.sn-generation').getByText('Chapter intent', { exact: true }).click(); await page.locator('.sn-generation').getByLabel('Include saved chapter intent', { exact: true }).check()
  const before = JSON.parse(await readFile(join(output, 'generation-calls.json'), 'utf8')).length
  await page.getByRole('button', { name: 'Preview generation context', exact: true }).click(); await page.locator('.sn-context-preview').waitFor()
  assert((await page.locator('.sn-context-preview').innerText()).includes('Scene intent'))
  assert.equal(JSON.parse(await readFile(join(output, 'generation-calls.json'), 'utf8')).length, before)
  await showContent(page); await body.click(); await body.evaluate(element => { const start = element.value.indexOf('[TODO]'); element.focus(); element.setSelectionRange(start, start) })
  for (let index = 0; index < 6; index++) await body.press('Shift+ArrowRight')
  await page.getByRole('button', { name: 'Selection AI', exact: true }).waitFor()
  await openWritingTool(page, 'assessment'); await page.getByLabel('Review selected passage only', { exact: true }).check()
  await page.getByRole('button', { name: 'Run review', exact: true }).click(); await page.locator('.sn-review-status').waitFor()
  assert.equal(await page.locator('.sn-review-issue blockquote').first().textContent(), '[TODO]')
  await page.getByRole('button', { name: 'Generate local revision', exact: true }).first().click(); await page.locator('.sn-candidate').waitFor()
  assert((await page.locator('.sn-candidate').textContent()).startsWith('前文逐字保留。\n\n')); assert((await page.locator('.sn-candidate').textContent()).endsWith('\n\n后文逐字保留。'))
  assert.equal(await body.inputValue(), text)
  await writeFile(join(output, 'writing-methods-validation.json'), JSON.stringify({ result: 'PASS', optionalIntent: true, diskVersions: true, editableDirections: true, previewReadOnly: true, localReview: true, proseUntouched: true, sameEditor: true }, null, 2))
  console.log('PASS writing methods: intent, editable directions, pure context preview and range-limited review candidate.')
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await withWorkspace(resolve(process.argv[2]), page => checkWritingMethods(page, resolve(process.argv[2])))
