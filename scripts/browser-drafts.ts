import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rmdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openBookCreator, openManagement, createChapter, selectBook, showContent, visitPreview, withWorkspace } from './browser-workspace.ts'

/** Task-owned fixtures only: two windows, cleared browser data and library switching. */
export async function checkDraftWorkflow(page, output, visit = tab => visitPreview(tab, output), newWindow = () => page.context().newPage()) {
  const openPanel = async tab => {
    const books = tab.locator('.sn-books'), expand = tab.getByRole('button', { name: 'Open right sidebar', exact: true }), guide = tab.getByText('Novel workspace', { exact: true })
    await books.or(expand).or(guide).first().waitFor()
    if (await expand.isVisible()) await expand.click()
    await books.or(guide).first().waitFor()
    if (!await books.isVisible()) await guide.click()
    await books.waitFor()
  }
  const body = page.getByRole('textbox', { name: 'Chapter text', exact: true })
  const status = tab => tab.locator('.sn-editor-toolbar [role=status]')
  const confirmed = tab => status(tab).filter({ hasText: /^Draft saved to disk$/ }).waitFor()
  const location = page.locator('.sn-storage')
  await openManagement(page)
  if (!await location.evaluate(element => element.open)) await location.locator(':scope > summary').click()
  const locationInput = location.getByLabel('Library root directory', { exact: true })
  await locationInput.waitFor()
  if (await locationInput.inputValue() !== join(output, 'workspace')) {
    await locationInput.fill(join(output, 'workspace'))
    await location.getByRole('button', { name: 'Switch library', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.sn-workspace')?.textContent === 'workspace')
  }
  await openBookCreator(page)
  const title = `磁盘草稿验证 ${Date.now()}`
  await page.getByLabel('Book title', { exact: true }).fill(title)
  await page.getByRole('button', { name: 'New book', exact: true }).click()
  await page.waitForFunction(title => document.querySelector('select[aria-label=Book]')?.selectedOptions[0]?.textContent === title, title)
  await createChapter(page, '草稿章')
  await page.waitForFunction(() => document.querySelector('input[aria-label=Rename]')?.value === '草稿章' && document.querySelector('textarea[aria-label="Chapter text"]'))
  const bookId = await page.getByLabel('Book', { exact: true }).inputValue()
  const folder = join(output, 'workspace', 'novels', bookId)
  const book = JSON.parse(await readFile(join(folder, 'project.json'), 'utf8')), chapterId = book.chapters[0].chapterId
  const formal = join(folder, 'chapters', `${chapterId}.md`), drafts = join(folder, 'drafts', chapterId)
  await body.fill('第一窗口未保存的稿件。')
  await confirmed(page)
  assert.equal(await readFile(formal, 'utf8'), '')
  const firstBranch = (await readdir(drafts)).find(name => /^[a-f\d-]{36}$/.test(name))
  const second = newWindow ? await newWindow() : false
  if (second) try {
    await visit(second)
    await openPanel(second)
    await selectBook(second, bookId)
    const secondBody = second.getByRole('textbox', { name: 'Chapter text', exact: true })
    await second.locator(`textarea[data-book-id="${bookId}"][data-chapter-id="${chapterId}"]`).waitFor()
    assert.equal(await secondBody.inputValue(), '')
    await secondBody.fill('第二窗口的独立稿件。')
    await confirmed(second)
    assert.equal(await body.inputValue(), '第一窗口未保存的稿件。')
    assert.equal((await readdir(drafts)).filter(name => /^[a-f\d-]{36}$/.test(name)).length, 2)
  } finally { await second.close() }
  await page.evaluate(async () => {
    for (const key of Object.keys(localStorage)) if (key.startsWith('super-novel.draft:')) localStorage.removeItem(key)
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('super-novel-drafts')
      request.onsuccess = () => resolve(true); request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('draft database still open'))
    })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openPanel(page)
  await body.waitFor()
  assert.equal(await body.inputValue(), '')
  const recovery = page.locator('.sn-draft-recovery')
  await openManagement(page)
  await recovery.locator(':scope > summary').click()
  await recovery.locator('.sn-draft-item').filter({ hasText: firstBranch.slice(0, 8) }).getByRole('button', { name: 'Preview', exact: true }).first().click()
  assert((await recovery.locator('.sn-draft-preview').innerText()).includes('第一窗口未保存的稿件。'))
  await recovery.getByRole('button', { name: 'Restore to editor', exact: true }).click()
  assert.equal(await body.inputValue(), '第一窗口未保存的稿件。')
  await confirmed(page)
  const branchRecords = []
  for (const branch of await readdir(drafts)) for (const file of await readdir(join(drafts, branch))) {
    if (/^[0-9]{16}\.json$/.test(file)) branchRecords.push(JSON.parse(await readFile(join(drafts, branch, file), 'utf8')))
  }
  const current = branchRecords.sort((a, b) => b.savedAt - a.savedAt)[0]
  const lock = join(drafts, current.branchId, '.write.lock')
  await mkdir(lock)
  try {
    await body.fill('磁盘失败时仍保留的输入。')
    await status(page).filter({ hasText: /^Disk draft failed$/ }).waitFor()
    assert.equal(await body.inputValue(), '磁盘失败时仍保留的输入。')
    assert.equal(await readFile(formal, 'utf8'), '')
    await openManagement(page)
    await page.locator('.sn-books > .sn-draft-alert').waitFor()
    assert.equal(await page.locator('.sn-project-save').textContent(), 'Disk draft failed')
    await page.keyboard.press('Escape')
  } finally { await rmdir(lock) }
  await page.getByRole('button', { name: 'Retry checkpoint', exact: true }).click()
  await confirmed(page)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await status(page).filter({ hasText: /^Saved$/ }).waitFor()
  assert.equal(await readFile(formal, 'utf8'), '磁盘失败时仍保留的输入。')
  const settings = page.locator('.sn-storage')
  await openManagement(page)
  if (!await settings.evaluate(element => element.open)) await settings.locator(':scope > summary').click()
  const alternate = join(output, 'workspace', 'alternate-books')
  await mkdir(alternate, { recursive: true })
  await settings.getByLabel('Library root directory', { exact: true }).fill(alternate)
  await settings.getByRole('button', { name: 'Switch library', exact: true }).click()
  await page.getByText('Start your story', { exact: true }).waitFor()
  assert.equal(await readFile(formal, 'utf8'), '磁盘失败时仍保留的输入。')
  // The settings component stays mounted while changing library identities.
  await openManagement(page)
  if (!await settings.evaluate(element => element.open)) await settings.locator(':scope > summary').click()
  await settings.getByLabel('Previous locations', { exact: true }).selectOption(join(output, 'workspace'))
  await settings.getByRole('button', { name: 'Switch library', exact: true }).click()
  await showContent(page)
  await body.waitFor()
  assert.equal(await body.inputValue(), '磁盘失败时仍保留的输入。')
  await openManagement(page)
  const open = settings.getByRole('button', { name: 'Open save folder', exact: true })
  const nativeOpen = await open.isEnabled()
  if (nativeOpen) {
    await open.click()
    await page.waitForFunction(() => [...document.querySelectorAll('.sn-storage button')].some(button => button.textContent === 'Open save folder' && !button.disabled))
    assert.equal(await settings.locator('[role=alert]').count(), 0)
  }
  assert(await page.locator('.super-novel-setup').evaluate(element => element.scrollWidth <= element.clientWidth + 1))
  await page.screenshot({ path: join(output, 'drafts-en.png') })
  await writeFile(join(output, 'draft-validation.json'), JSON.stringify({ twoWindows: Boolean(second), browserDataCleared: true, recoveredFromDisk: true, failedCheckpointRetry: true, switchedLibrary: true, nativeOpenerRequested: nativeOpen }, null, 2))
  console.log(`PASS drafts: ${second ? 'independent windows, ' : ''}disk recovery after browser data removal, checkpoint failure/retry, save and library switching.`)
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = resolve(process.argv[2])
  await withWorkspace(output, page => checkDraftWorkflow(page, output))
}
