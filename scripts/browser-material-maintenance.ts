import assert from 'node:assert/strict'
import { readFile, writeFile, readdir, mkdir, rmdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { BookStore } from '../lib/host/book-store.js'
import { hash } from '../lib/domain/books.js'
import { createNavigationFixture } from './browser-navigation.ts'
import { withWorkspace, selectBook, openManagement, openDirectory, showContent, resizeSidebar } from './browser-workspace.ts'

export const createMaintenanceFixture = createNavigationFixture
/** Author actions use the actual packed client. All documents are isolated synthetic fixtures. */
export async function checkMaterialMaintenance(page, output, identity, resize = size => page.setViewportSize(size)) {
  const root = join(output, 'workspace'), books = await BookStore.at(root), folder = join(root, 'novels', identity.bookId)
  const signal = () => new AbortController().signal, book = () => books.readBook(identity.bookId)
  const body = page.locator('.sn-editor'), library = page.locator('#sn-panel-library'), story = page.locator('#sn-panel-story-state')
  const calls = async () => JSON.parse(await readFile(join(output, 'generation-calls.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '[]'; throw error })).length
  const beforeCalls = await calls()
  const openLibrary = async () => { await openManagement(page); await page.getByRole('button', { name: 'Material library', exact: true }).click(); await library.waitFor() }
  const openStory = async () => { await openManagement(page); await page.getByRole('button', { name: 'Timeline, character state and foreshadows', exact: true }).click(); await story.waitFor() }
  const expand = async locator => { if (!await locator.evaluate(element => element.open)) await locator.locator(':scope > summary').click() }
  const openCharacter = async () => {
    if (!await library.locator('.sn-material-detail').isVisible()) await library.locator('.sn-reference-list button').filter({ hasText: '林舟·人物卡' }).click()
    await expand(library.locator('.sn-material-organize'))
  }
  const waitDraft = panel => panel.getByRole('status').filter({ hasText: 'Form draft saved to disk; not formally confirmed.' }).waitFor()
  const reloadWithoutCache = async () => {
    await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('super-novel.form:')) localStorage.removeItem(key) })
    await page.reload({ waitUntil: 'domcontentloaded' })
    const expand = page.getByRole('button', { name: 'Open right sidebar', exact: true }), guide = page.getByText('Novel workspace', { exact: true })
    await page.locator('.sn-books').or(expand).or(guide).first().waitFor()
    if (await expand.isVisible()) await expand.click()
    if (!await page.locator('.sn-books').isVisible()) await guide.click()
    await page.locator('.sn-books').waitFor()
  }
  const restore = async panel => {
    const recovery = panel.locator('.sn-form-recovery'); await expand(recovery)
    await recovery.getByRole('button', { name: 'Preview', exact: true }).first().click()
    await recovery.getByRole('button', { name: 'Restore form input', exact: true }).click()
  }
  await selectBook(page, identity.bookId)
  const original = await body.elementHandle(), originalText = await body.inputValue()
  await openLibrary(); await openCharacter()
  const tags = library.getByLabel('Tags (comma separated)', { exact: true })
  await tags.fill('未确认标签'); await waitDraft(library)
  await page.keyboard.press('Escape'); await showContent(page)
  assert(await body.evaluate((element, original) => element === original, original)); assert.equal(await body.inputValue(), originalText)
  await openLibrary(); assert.equal(await tags.inputValue(), '未确认标签', 'closing a tool retains form input')
  let release, prepared
  const held = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { prepared = resolve })
  const heldStore = await BookStore.at(root, { afterStage: async stage => { if (stage === 'prepared') { prepared(); await held } } })
  let stagedBook = await book(), stagedText = await books.readChapter(identity.bookId, identity.second)
  const stagedSave = heldStore.mutate({ operationId: randomUUID(), bookId: identity.bookId, chapterId: identity.second, expectedRevision: stagedBook.revision, expectedHash: stagedText.hash, action: 'save', title: '', beforeChapterId: '', content: stagedText.content + ' 并发保存。' }, signal())
  try {
    await ready
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.locator('.sn-pending-save').waitFor()
    assert(await body.evaluate((element, original) => element === original, original), 'a prepared save in another window must preserve the editor')
    assert.equal(await tags.inputValue(), '未确认标签', 'prepared save must preserve the open form')
    assert(await library.getByRole('button', { name: 'Save material details', exact: true }).isDisabled())
  } finally { release(); await stagedSave }
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.locator('.sn-pending-save').waitFor({ state: 'hidden' })
  assert.equal(await tags.inputValue(), '未确认标签')
  let current = await book(), second = await books.readChapter(identity.bookId, identity.second)
  await books.mutate({ operationId: randomUUID(), bookId: identity.bookId, chapterId: identity.second, expectedRevision: current.revision, expectedHash: second.hash, action: 'save', title: '', beforeChapterId: '', content: second.content + ' 无关更新。' }, signal())
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await library.getByText('Material version:', { exact: false }).waitFor(); assert.equal(await tags.inputValue(), '未确认标签')
  current = await book()
  const item = current.chapters.find(item => item.chapterId === identity.character)
  await books.metadata({ workspaceId: hash(root), bookId: identity.bookId, chapterId: identity.character, expectedRevision: current.revision, operationId: randomUUID(),
    tags: ['另一个窗口'], aliases: item.aliases ?? [], favorite: false, status: 'active', linkedChapterIds: item.linkedChapterIds ?? [], relatedMaterialIds: [] }, signal())
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await library.getByRole('alert').filter({ hasText: 'Saved details changed.' }).waitFor()
  assert.equal(await tags.inputValue(), '未确认标签'); assert(await library.getByRole('button', { name: 'Save material details', exact: true }).isDisabled())
  await library.getByRole('button', { name: 'Checked; keep input and continue', exact: true }).click()
  await tags.fill('刷新后恢复'); await waitDraft(library)
  await reloadWithoutCache(); await openLibrary(); await openCharacter()
  assert.equal(await tags.inputValue(), '另一个窗口', 'a new editor branch does not silently adopt another draft')
  await restore(library); assert.equal(await tags.inputValue(), '刷新后恢复')
  await waitDraft(library)
  const formFolder = join(folder, 'form-drafts/material', identity.character), checkpoints = []
  for (const branch of await readdir(formFolder)) {
    for (const name of (await readdir(join(formFolder, branch))).filter(name => /^\d{16}\.json$/.test(name))) checkpoints.push({ branch, ...JSON.parse(await readFile(join(formFolder, branch, name), 'utf8')) })
  }
  const active = checkpoints.sort((a, b) => b.savedAt - a.savedAt)[0], cleanupPath = join(formFolder, active.branch, 'settled.json')
  await mkdir(cleanupPath)
  await library.getByRole('button', { name: 'Save material details', exact: true }).click()
  await library.getByRole('status').filter({ hasText: 'Material details saved.' }).waitFor()
  await page.waitForFunction(() => !document.querySelector('.sn-material-form')?.disabled)
  assert.deepEqual((await book()).chapters.find(item => item.chapterId === identity.character).tags, ['刷新后恢复'])
  await library.getByRole('alert').filter({ hasText: 'Confirmed content was saved.' }).waitFor()
  await tags.fill('清理期间的新输入'); await waitDraft(library)
  await rmdir(cleanupPath)
  await library.getByRole('alert').getByRole('button', { name: 'Retry checkpoint', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.sn-material-form')?.disabled)
  assert.equal(await tags.inputValue(), '清理期间的新输入', 'retrying old cleanup must preserve newer input')
  await library.getByRole('button', { name: 'Save material details', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.sn-material-form')?.disabled)
  assert((await readdir(formFolder)).length >= 2, 'refresh and original input have independent disk branches')

  await page.keyboard.press('Escape'); await showContent(page); await body.click(); await body.evaluate(element => element.setSelectionRange(0, 17)); await openStory()
  await story.getByRole('button', { name: 'Record selection as event', exact: true }).click()
  await story.getByLabel('Record title', { exact: true }).fill('刷新待确认事件'); await waitDraft(story)
  await reloadWithoutCache(); await openStory(); await restore(story)
  assert.equal(await story.getByLabel('Record title', { exact: true }).inputValue(), '刷新待确认事件')
  assert.equal(await story.locator('.sn-story-form blockquote').innerText(), originalText.slice(0, 17))
  await story.getByRole('button', { name: 'Cancel', exact: true }).click(); await story.locator('.sn-story-form').waitFor({ state: 'hidden' })
  await story.getByRole('button', { name: 'Foreshadows', exact: true }).click(); await story.getByRole('button', { name: 'Plan foreshadow', exact: true }).click()
  await story.getByLabel('Record title', { exact: true }).fill('刷新待确认伏笔'); await story.getByLabel('Foreshadow note', { exact: true }).fill('下一章由作者核对'); await waitDraft(story)
  await reloadWithoutCache(); await openStory(); await restore(story)
  assert.equal(await story.getByLabel('Foreshadow note', { exact: true }).inputValue(), '下一章由作者核对')
  await story.getByRole('button', { name: 'Confirm story record', exact: true }).click(); await story.locator('.sn-story-form').waitFor({ state: 'hidden' })

  await page.keyboard.press('Escape'); await openLibrary()
  await library.getByLabel('Organization scope', { exact: true }).selectOption('untagged')
  await library.locator('.sn-reference-list button').filter({ hasText: '交还钥匙·灵感' }).waitFor()
  assert.equal(await library.locator('.sn-reference-list button').count(), 1)
  await expand(library.locator('.sn-saved-views')); await library.getByLabel('Filter name', { exact: true }).fill('未分类灵感')
  await library.getByRole('button', { name: 'Save filter', exact: true }).click()
  const viewId = await library.getByLabel('Saved filters', { exact: true }).locator('option').last().getAttribute('value')
  await page.evaluate(() => {
    window.snMaterialSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function(key, value) { if (key.startsWith('super-novel.material-views:')) throw new DOMException('quota', 'QuotaExceededError'); return window.snMaterialSetItem.call(this, key, value) }
  })
  await library.getByLabel('Filter name', { exact: true }).fill('失败时保留名称'); await library.getByRole('button', { name: 'Save filter', exact: true }).click()
  await library.getByRole('alert').filter({ hasText: 'Could not retain the filter.' }).waitFor()
  assert.equal(await library.getByLabel('Filter name', { exact: true }).inputValue(), '失败时保留名称')
  await page.evaluate(() => { Storage.prototype.setItem = window.snMaterialSetItem; delete window.snMaterialSetItem })
  await library.getByRole('button', { name: 'Save filter', exact: true }).click()
  await library.getByLabel('Organization scope', { exact: true }).selectOption('all'); await library.getByLabel('Saved filters', { exact: true }).selectOption(viewId)
  assert.equal(await library.getByLabel('Organization scope', { exact: true }).inputValue(), 'untagged')
  await reloadWithoutCache(); await openLibrary(); await expand(library.locator('.sn-saved-views'))
  await library.getByLabel('Saved filters', { exact: true }).selectOption(viewId)
  assert.equal(await library.getByLabel('Organization scope', { exact: true }).inputValue(), 'untagged')
  await library.getByLabel('Organization scope', { exact: true }).selectOption('all')
  await library.locator('.sn-reference-list button').filter({ hasText: '林舟·人物卡' }).click()
  await library.getByRole('button', { name: 'Edit this material', exact: true }).click()
  await page.locator(`textarea[data-chapter-id="${identity.character}"]`).waitFor()
  await openLibrary(); await library.getByRole('button', { name: 'References', exact: true }).click()
  const texts = await Promise.all((await book()).chapters.map(item => readFile(join(folder, 'chapters', `${item.chapterId}.md`))))
  await library.getByRole('button', { name: 'Batch organize', exact: true }).click()
  const select = async () => { for (const title of ['林舟·人物卡', '交还钥匙·灵感']) await library.getByLabel(`Select material ${title}`, { exact: true }).check() }
  await select(); await library.getByLabel('Tags to add', { exact: true }).fill('批量核对')
  await library.getByRole('button', { name: 'Preview batch changes', exact: true }).click()
  await library.getByRole('heading', { name: 'Review batch changes · 2', exact: true }).waitFor()
  assert(!await library.getByLabel('Select material 林舟·人物卡', { exact: true }).isVisible(), 'preview isolates the selected range')
  for (const width of [300, 420]) {
    await resizeSidebar(page, width)
    assert(await library.evaluate(element => element.scrollWidth <= element.clientWidth + 2), `maintenance fits ${width}px`)
    const panelBounds = await library.boundingBox(), confirmBounds = await library.getByRole('button', { name: 'Confirm batch changes', exact: true }).boundingBox()
    assert(confirmBounds.y >= panelBounds.y && confirmBounds.y + confirmBounds.height <= panelBounds.y + panelBounds.height + 1, 'confirmation stays visible during preview')
    await page.screenshot({ path: join(output, `material-maintenance-${width}.png`) })
  }
  current = await book(); second = await books.readChapter(identity.bookId, identity.second)
  await books.mutate({ operationId: randomUUID(), bookId: identity.bookId, chapterId: identity.second, expectedRevision: current.revision, expectedHash: second.hash, action: 'save', title: '', beforeChapterId: '', content: second.content + ' 预览后更新。' }, signal())
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await library.getByRole('alert').filter({ hasText: 'The book changed. Preview again;' }).waitFor()
  assert(await library.getByRole('button', { name: 'Confirm batch changes', exact: true }).isDisabled())
  await library.getByRole('button', { name: 'Back to selection', exact: true }).click(); await library.getByRole('button', { name: 'Preview batch changes', exact: true }).click()
  await library.getByRole('button', { name: 'Confirm batch changes', exact: true }).click(); await library.getByRole('status').filter({ hasText: 'Batch completed' }).waitFor()
  for (const id of [identity.character, identity.seed]) assert((await book()).chapters.find(item => item.chapterId === id).tags.includes('批量核对'))
  await library.getByRole('button', { name: 'Continue organizing', exact: true }).click(); await select()
  await library.getByLabel('Batch action', { exact: true }).selectOption('link-chapter'); await library.getByLabel('Chapter to link', { exact: true }).selectOption(identity.first)
  await library.getByRole('button', { name: 'Preview batch changes', exact: true }).click(); await library.getByRole('button', { name: 'Confirm batch changes', exact: true }).click()
  await library.getByRole('status').filter({ hasText: 'Batch completed' }).waitFor()
  await library.getByRole('button', { name: 'Continue organizing', exact: true }).click(); await select()
  await library.getByLabel('Batch action', { exact: true }).selectOption('archive'); await library.getByRole('button', { name: 'Preview batch changes', exact: true }).click()
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Fullscreen', exact: true }).click(); await resize({ width: 900, height: 800 }); await openLibrary()
  assert(await library.evaluate(element => element.scrollWidth <= element.clientWidth + 2)); await page.screenshot({ path: join(output, 'material-maintenance-900.png') })
  await library.getByRole('button', { name: 'Confirm batch changes', exact: true }).click(); await library.getByRole('status').filter({ hasText: 'Batch completed' }).waitFor()
  for (const id of [identity.character, identity.seed]) assert.equal((await book()).chapters.find(item => item.chapterId === id).status, 'archived')
  const afterTexts = await Promise.all((await book()).chapters.map(item => readFile(join(folder, 'chapters', `${item.chapterId}.md`))))
  // Only the explicitly simulated second-chapter edits above changed text.
  for (let at = 0; at < afterTexts.length; at++) if ((await book()).chapters[at].chapterId !== identity.second) assert.deepEqual(afterTexts[at], texts[at])
  await expand(library.locator('.sn-material-filters')); await library.getByLabel('Material status', { exact: true }).selectOption('archived')
  await library.locator('.sn-reference-list button').filter({ hasText: '林舟·人物卡' }).click(); await expand(library.locator('.sn-material-organize'))
  await library.getByRole('button', { name: 'Restore material', exact: true }).click(); await library.getByRole('button', { name: 'Restore material', exact: true }).waitFor({ state: 'hidden' })
  assert.equal((await book()).chapters.find(item => item.chapterId === identity.character).status, 'active', 'an archived active editor must not lock material management')
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click(); await resize({ width: 1440, height: 1000 }); await openDirectory(page)
  await page.getByRole('tab', { name: 'Chapters', exact: true }).click()
  await page.getByLabel('Chapter title', { exact: true }).fill('重试后创建')
  const barrier = join(root, 'novels', `.${identity.bookId}.snapshot.lock`)
  await mkdir(barrier)
  try {
    await page.getByRole('button', { name: 'New chapter', exact: true }).click()
    await page.locator('.sn-books > .sn-alert').filter({ hasText: 'Another operation is running' }).waitFor()
  } finally { await rmdir(barrier) }
  const manifestPath = join(folder, 'project.json'), refreshed = JSON.parse(await readFile(manifestPath, 'utf8'))
  refreshed.title += '·后台刷新'; refreshed.revision++; await writeFile(manifestPath, JSON.stringify(refreshed, null, 2) + '\n')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForFunction(() => document.querySelector('.sn-project-title')?.textContent.includes('后台刷新'))
  assert((await page.locator('.sn-books > .sn-alert').filter({ hasText: 'Another operation is running' }).innerText()).includes('Another operation is running'), 'background reading must not erase a failed write')
  await page.getByRole('button', { name: 'New chapter', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('input[aria-label="Rename"]')?.value === '重试后创建')
  assert.equal((await book()).chapters.filter(item => item.title === '重试后创建').length, 1)
  assert.equal(await calls(), beforeCalls)
  await writeFile(join(output, 'material-maintenance-validation.json'), JSON.stringify({ result: 'PASS', concurrentPreparedRetainsEditorAndForm: true, unrelatedRevisionRetainsInput: true, metadataConflictRetainsInput: true,
    independentBranches: true, diskRecoveryWithoutBrowserCache: ['material', 'event', 'foreshadow'], savedViews: true, filterFailureRetainsName: true, maintenance: true, previewFreezesSelection: true, confirmedSaveDistinctFromCleanupFailure: true, cleanupRetryPreservesNewerInput: true,
    stalePreviewRefused: true, backgroundRefreshRetainsWriteFailure: true, restoreActiveArchivedEditor: true, batchActions: ['add-tags', 'link-chapter', 'archive'], batchTextUnchanged: true, widths: [300, 420, 900], modelCalls: 0 }, null, 2))
  console.log('PASS material maintenance: input retention, disk form recovery, saved views, atomic batches and 300/420/900px.')
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = resolve(process.argv[2]), identity = await createMaintenanceFixture(output)
  await withWorkspace(output, page => checkMaterialMaintenance(page, output, identity))
}
