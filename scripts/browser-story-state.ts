import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withWorkspace, openBookCreator, createChapter, openManagement, openMaterialCreator, openGeneration, showContent, resizeSidebar } from './browser-workspace.ts'

/** Visible author actions against the actual packed plugin and fixed Host adapter. */
export async function checkStoryState(page, output) {
  await openBookCreator(page)
  const previousBook = await page.getByLabel('Book', { exact: true }).inputValue()
  await page.getByLabel('Book title', { exact: true }).fill('跨章状态验收')
  await page.getByRole('button', { name: 'New book', exact: true }).click()
  await page.waitForFunction(previous => document.querySelector('select[aria-label=Book]')?.value !== previous, previousBook)
  await openMaterialCreator(page)
  const creator = page.locator('#sn-panel-create-material')
  await creator.getByLabel('Material type', { exact: true }).selectOption('character')
  await creator.getByLabel('Material name', { exact: true }).fill('林舟')
  await creator.getByRole('button', { name: 'Create template', exact: true }).click()
  await page.locator('textarea[aria-label="Material text"]').waitFor()
  await createChapter(page, '埋设章')
  const body = page.locator('textarea.sn-editor'), first = '林舟左腕受伤，站在渡口。船头刻着一朵白花。'
  const save = async text => {
    await body.fill(text); await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.locator('.sn-editor-toolbar [role=status]').filter({ hasText: /^Saved$/ }).waitFor()
  }
  await save(first)
  const original = await body.elementHandle(), bookId = await body.getAttribute('data-book-id'), firstId = await body.getAttribute('data-chapter-id')
  const path = join(output, 'workspace/novels', bookId)
  const ledger = async () => {
    const versions = (await readdir(join(path, 'story-state'))).filter(name => /^\d{8}\.json$/.test(name)).sort()
    return JSON.parse(await readFile(join(path, 'story-state', versions.at(-1)), 'utf8'))
  }
  const calls = async () => JSON.parse(await readFile(join(output, 'generation-calls.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '[]'; throw error }))
  const selectAll = async () => { await showContent(page); await body.click(); await body.press('Meta+A') }
  const openState = async () => {
    await openManagement(page)
    await page.getByRole('button', { name: 'Timeline, character state and foreshadows', exact: true }).click()
    await page.locator('#sn-panel-story-state').waitFor()
  }
  const panel = page.locator('#sn-panel-story-state')
  const confirm = async () => {
    await panel.getByRole('button', { name: 'Confirm story record', exact: true }).click()
    await panel.locator('.sn-story-form').waitFor({ state: 'hidden' })
  }
  const card = title => panel.locator('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
  const before = (await calls()).length
  await showContent(page); await body.click(); await body.press('ArrowRight')
  // A DOM/accessibility selection may arrive without React's select event.
  await body.evaluate(element => element.setSelectionRange(0, element.value.length))
  await openState()
  await resizeSidebar(page,300)
  assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'state drawer fits 300px')
  await panel.getByRole('button', { name: 'Record selection as event', exact: true }).click()
  assert.equal(await panel.locator('.sn-story-form blockquote').first().innerText(), first, 'opening a tool reads the actual editor selection')
  await panel.getByLabel('Record title', { exact: true }).fill('左腕受伤')
  await panel.getByText('Character changes', { exact: true }).click()
  await panel.getByRole('button', { name: 'Add character change', exact: true }).click()
  await panel.getByLabel('Change kind 1', { exact: true }).selectOption('injury')
  await panel.getByLabel('Change value 1', { exact: true }).fill('左腕不能用力')
  await page.keyboard.press('Escape'); await showContent(page)
  assert(await body.evaluate((element, original) => element === original, original))
  assert.equal(await body.inputValue(), first)
  await openState(); assert.equal(await panel.getByLabel('Record title', { exact: true }).inputValue(), '左腕受伤')
  await confirm(); assert.equal((await ledger()).events[0].time.kind, 'unknown')
  assert.equal((await calls()).length, before, 'manual ledger actions never call a model')

  await panel.getByRole('button', { name: 'AI suggestions', exact: true }).click()
  await panel.getByRole('button', { name: 'Suggest chapter changes (one call)', exact: true }).click()
  await panel.getByRole('button', { name: 'Check and edit suggestion', exact: true }).first().waitFor()
  assert.equal((await calls()).length, before + 1)
  assert.equal((await ledger()).events.length, 1, 'suggestions have not changed the ledger')
  await panel.getByRole('button', { name: 'Check and edit suggestion', exact: true }).first().click()
  await panel.getByLabel('Record title', { exact: true }).fill('核对后的变化')
  await confirm(); assert.equal((await ledger()).events.length, 2)

  await panel.getByRole('button', { name: 'Foreshadows', exact: true }).click()
  await panel.getByRole('button', { name: 'Plan foreshadow', exact: true }).click()
  await panel.getByLabel('Record title', { exact: true }).fill('白花暗号')
  await panel.getByLabel('Foreshadow note', { exact: true }).fill('在下一章解释')
  await confirm(); assert.equal((await ledger()).foreshadows[0].status, 'planned')
  await card('白花暗号').getByRole('button', { name: 'Edit and check', exact: true }).click()
  await panel.getByLabel('Foreshadow status', { exact: true }).selectOption('planted')
  await confirm(); assert.equal((await ledger()).foreshadows[0].planted.chapterId, firstId)
  await page.screenshot({path:join(output,'story-state-300.png')})
  await page.keyboard.press('Escape')
  await createChapter(page, '回收章'); const secondId = await body.getAttribute('data-chapter-id')
  await save('船夫解释，船头白花是渡口暗号。林舟用右手接过信。')
  await selectAll(); await openState()
  await panel.getByRole('button', { name: 'Foreshadows', exact: true }).click()
  await card('白花暗号').getByRole('button', { name: 'Edit and check', exact: true }).click()
  await panel.getByLabel('Foreshadow status', { exact: true }).selectOption('resolved')
  await confirm()
  const thread = (await ledger()).foreshadows[0]
  assert.equal(thread.status, 'resolved'); assert.equal(thread.planted.chapterId, firstId); assert.equal(thread.resolved.chapterId, secondId)
  await page.keyboard.press('Escape'); await createChapter(page, '衔接章')
  await openGeneration(page)
  await page.getByLabel('Writing instructions', { exact: true }).fill('保持伤势和已确认线索')
  await page.getByLabel('Include confirmed preceding state and foreshadows', { exact: true }).check()
  await page.getByRole('button', { name: 'Preview generation context', exact: true }).click()
  await page.locator('.sn-context-preview').waitFor()
  assert((await page.locator('.sn-context-preview').innerText()).includes('Confirmed story changes'))
  assert.equal((await calls()).length, before + 1, 'context preview is pure')

  await showContent(page)
  await page.getByRole('button', { name: 'Previous chapter', exact: true }).click()
  await page.locator(`textarea[data-chapter-id="${secondId}"]`).waitFor()
  await page.getByRole('button', { name: 'Previous chapter', exact: true }).click()
  await page.locator(`textarea[data-chapter-id="${firstId}"]`).waitFor()
  await save('林舟的左腕已经愈合，白花线索已改。')
  await openState()
  await panel.getByRole('button', { name: 'Timeline', exact: true }).click()
  await panel.getByText('Source changed; check again', { exact: false }).first().waitFor()
  await panel.getByRole('button', { name: 'Chapter change impacts', exact: true }).click()
  await panel.getByText('Event · 左腕受伤 · Source changed; check again', { exact: true }).waitFor()
  assert((await panel.innerText()).includes('Foreshadow · 白花暗号 · Source changed; check again'))
  assert.equal((await calls()).length, before + 1)
  await page.keyboard.press('Escape'); await showContent(page)
  assert.equal(await body.inputValue(), '林舟的左腕已经愈合，白花线索已改。')
  await writeFile(join(output, 'story-state-validation.json'), JSON.stringify({result:'PASS', stateDrawer300:true, manualEvents:true, sameEditor:true, formRetained:true, editableSuggestions:true, explicitConfirmation:true, twoChapterThread:true, purePreview:true, expiredSources:true, pureImpacts:true},null,2))
  console.log('PASS story state: saved evidence, editable suggestions, two-chapter foreshadow and pure impact report.')
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await withWorkspace(resolve(process.argv[2]), page => checkStoryState(page, resolve(process.argv[2])))
