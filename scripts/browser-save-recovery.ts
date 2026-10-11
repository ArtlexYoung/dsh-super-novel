import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BookStore } from '../lib/host/book-store.js'
import { BackupStore } from '../lib/host/backup-store.js'
import { MilestoneStore } from '../lib/host/milestone-store.js'
import { DraftStore } from '../lib/host/draft-store.js'
import { hash } from '../lib/domain/books.js'
import { withWorkspace, selectBook, openManagement, openDirectory, showContent, resizeSidebar } from './browser-workspace.ts'
const signal = () => new AbortController().signal

export async function createRecoveryFixture(output) {
  const root = join(output, 'workspace'); await mkdir(root, { recursive: true }); const books = await BookStore.at(root)
  let book = await books.createBook({ operationId: randomUUID(), title: '保存与恢复验收' }, signal())
  const chapterId = randomUUID(), content = '林舟把铜钥匙交回桌上。雨声隔开了两人的话。\n'.repeat(40)
  book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId, expectedRevision: book.revision, action: 'create', title: '雨夜', content, expectedHash: '', beforeChapterId: '' }, signal())
  book = await books.upgrade(book.bookId, book.revision, randomUUID(), signal(), 3)
  const other = await books.createBook({ operationId: randomUUID(), title: book.title }, signal()); await (await BackupStore.at(root)).create(other.bookId, randomUUID(), signal())
  const identity = { workspaceId: hash(root), bookId: book.bookId, chapterId, content }
  await writeFile(join(output, 'recovery-book.json'), JSON.stringify(identity)); return identity
}

export async function checkSaveRecovery(page, output, identity, resize = size => page.setViewportSize(size)) {
  const root = join(output, 'workspace'), books = await BookStore.at(root), body = page.locator('.sn-editor'), details = page.locator('#sn-panel-save-details'), backups = page.locator('.sn-backups')
  const storageState = () => readFile(join(root, '.super-novel/storage.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error }), initialStorage = await storageState()
  const calls = async () => JSON.parse(await readFile(join(output, 'generation-calls.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '[]'; throw error })).length, initialCalls = await calls()
  const expand = async element => { if (!await element.evaluate(item => item.open)) await element.locator(':scope > summary').click() }
  const openDetails = async () => { await showContent(page); await page.getByRole('button', { name: 'Save details', exact: true }).click(); await details.waitFor() }
  await selectBook(page, identity.bookId); const firstInput = identity.content + '尚未正式保存的后半章。'
  await body.fill(firstInput); await body.evaluate(element => { element.setSelectionRange(20, 36); element.scrollTop = 220 })
  const originalNode = await body.elementHandle(), position = await body.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, scroll: element.scrollTop }))
  await page.locator('.sn-editor-toolbar [role=status]').filter({ hasText: /^Draft saved to disk$/ }).waitFor(); await openDetails()
  await details.getByText('Current input is confirmed on disk as a draft; formal text is unchanged.', { exact: true }).waitFor()
  await details.getByText('This book has no complete backup yet.', { exact: true }).waitFor()
  assert.equal((await books.readChapter(identity.bookId, identity.chapterId)).content, identity.content)
  for (const width of [300, 420]) { await resizeSidebar(page, width); assert(await details.evaluate(element => element.scrollWidth <= element.clientWidth + 2)); await page.screenshot({ path: join(output, `save-details-${width}.png`) }) }
  const waitPosition = expected => page.waitForFunction(expected => {
    const element = document.querySelector('.sn-editor')
    return element.selectionStart === expected.start && element.selectionEnd === expected.end && Math.abs(element.scrollTop - expected.scroll) < 2
  }, expected)
  await page.keyboard.press('Escape'); await waitPosition(position)
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click(); await resize({ width: 900, height: 800 })
  await page.waitForFunction(() => document.querySelector('.sn-books')?.dataset.compact === 'false')
  await body.evaluate(element => { element.setSelectionRange(20, 36); element.scrollTop = 220; element.dispatchEvent(new Event('select', { bubbles: true })); element.dispatchEvent(new Event('scroll', { bubbles: true })) })
  const fullPosition = await body.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, scroll: element.scrollTop }))
  await openDetails()
  assert(await details.evaluate(element => element.scrollWidth <= element.clientWidth + 2)); await page.screenshot({ path: join(output, 'save-details-900.png') })
  await expand(details.locator('.sn-milestones > details')); await details.getByLabel('Milestone name', { exact: true }).fill('初稿完成')
  await details.getByRole('button', { name: 'Verify and save milestone', exact: true }).click({ clickCount: 2 })
  await details.getByRole('status').filter({ hasText: 'Milestone saved: 初稿完成' }).waitFor(); await details.locator('.sn-milestone-item').waitFor()
  const milestone = (await (await MilestoneStore.at(root, books)).list(identity.bookId, signal())).items[0]
  assert.equal((await (await BackupStore.at(root)).list(identity.bookId)).length, 1, 'double click creates one archive')
  await page.keyboard.press('Escape'); await showContent(page)
  assert(await body.evaluate((element, original) => element === original, originalNode)); assert.equal(await body.inputValue(), firstInput)
  await waitPosition(fullPosition)
  const returned = await body.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, scroll: element.scrollTop }))
  assert.equal(returned.start, fullPosition.start); assert.equal(returned.end, fullPosition.end); assert(Math.abs(returned.scroll - fullPosition.scroll) < 2)
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click(); await openDetails()
  await details.locator(`[data-backup-id="${milestone.backupId}"]`).getByRole('button', { name: 'Backups and recovery', exact: true }).click()
  await backups.getByText('Verified backup preview', { exact: true }).waitFor(); await backups.getByRole('button', { name: 'Restore new copy', exact: true }).click()
  const copyPanel = backups.locator('.sn-restored-copy'); await copyPanel.getByRole('button', { name: 'Switch to this copy', exact: true }).waitFor()
  const copyRoot = (await copyPanel.locator('> .sn-path').innerText()).trim()
  for (const width of [300, 420]) { await resizeSidebar(page, width); await copyPanel.scrollIntoViewIfNeeded(); assert(await backups.evaluate(element => element.scrollWidth <= element.clientWidth + 2)); await page.screenshot({ path: join(output, `restored-copy-${width}.png`) }) }
  await page.keyboard.press('Escape'); await openDirectory(page); await page.locator('#sn-panel-directory').getByRole('button', { name: 'Book outline', exact: true }).click()
  const outline = page.locator('#sn-panel-outline'); await outline.getByRole('button', { name: 'Arrange structure', exact: true }).click(); await outline.getByLabel('Chapter summary', { exact: true }).fill('切换前必须保留的结构输入。')
  const record = await page.evaluate(bookId => {
    const key = Object.keys(localStorage).find(key => key.startsWith('super-novel.form:structure:') && key.includes(bookId))
    if (!key) throw new Error('Structure cache not recorded'); return JSON.parse(localStorage.getItem(key))
  }, identity.bookId)
  const formBranch = join(root, 'novels', identity.bookId, 'form-drafts', 'structure', identity.bookId, record.branchId), formLock = join(formBranch, '.write.lock')
  await mkdir(formLock, { recursive: true })
  const bodyLock = join(root, 'novels', identity.bookId, 'drafts', identity.chapterId, record.branchId, '.write.lock')
  try {
    await outline.locator('.sn-form-draft-status[data-state=failed]').waitFor()
    await page.keyboard.press('Escape'); await showContent(page); await mkdir(bodyLock)
    await page.getByRole('button', { name: 'Focus writing', exact: true }).click()
    const latestInput = firstInput + '又写了一句。'; await body.fill(latestInput); await page.locator('.sn-draft-alert').waitFor(); const heldNode = await body.elementHandle()
    assert.equal(await page.locator('.sn-books').getAttribute('data-focused'), 'true')
    assert(await page.locator('.sn-draft-alert').isVisible(), 'Focus must keep failed draft and recovery actions visible')
    assert(await page.locator('.sn-draft-alert').getByRole('button', { name: 'Download local draft', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Exit focus', exact: true }).click()
    await openManagement(page); await expand(backups); await copyPanel.getByRole('button', { name: 'Switch to this copy', exact: true }).click()
    await backups.locator('> p[role=alert]').waitFor(); assert.equal(await storageState(), initialStorage, 'failed draft must not change the selected library')
    assert(await body.evaluate((element, original) => element === original, heldNode)); assert.equal(await body.inputValue(), latestInput)
    await rm(bodyLock, { recursive: true }); await copyPanel.getByRole('button', { name: 'Switch to this copy', exact: true }).click(); await backups.locator('> p[role=alert]').waitFor()
    assert.equal(await body.inputValue(), latestInput); assert.equal(await page.locator('.sn-storage input').inputValue(), root, 'form failure also blocks switching')
    await rm(formLock, { recursive: true }); await copyPanel.getByRole('button', { name: 'Switch to this copy', exact: true }).click()
    await page.waitForFunction(({ root, bookId }) => document.querySelector('.sn-storage input')?.value === root && document.querySelector('.sn-editor')?.dataset.bookId === bookId, { root: copyRoot, bookId: identity.bookId })
    await showContent(page); assert.equal(await body.inputValue(), identity.content, 'copy starts from its formal body, without cross-library draft adoption')
    assert.equal((await books.readChapter(identity.bookId, identity.chapterId)).content, identity.content)
    const drafts = await DraftStore.at(root, identity.workspaceId, books), list = await drafts.list({ workspaceId: identity.workspaceId, bookId: identity.bookId, chapterId: identity.chapterId })
    assert.equal((await drafts.read({ workspaceId: identity.workspaceId, bookId: identity.bookId, chapterId: identity.chapterId, branchId: list.drafts[0].branchId, sequence: list.drafts[0].sequence })).content, latestInput)
    const forms = await DraftStore.formsAt(root, identity.workspaceId, books, 'structure'), savedForms = await forms.list({ workspaceId: identity.workspaceId, bookId: identity.bookId, chapterId: identity.bookId })
    assert(JSON.parse((await forms.read({ workspaceId: identity.workspaceId, bookId: identity.bookId, chapterId: identity.bookId, branchId: savedForms.drafts[0].branchId, sequence: savedForms.drafts[0].sequence })).content).form.chapters.some(item => item.summary === '切换前必须保留的结构输入。'))
    await openManagement(page); const location = page.locator('.sn-storage'); await expand(location); await location.getByLabel('Previous locations', { exact: true }).selectOption(root); await location.getByRole('button', { name: 'Switch library', exact: true }).click()
    await page.waitForFunction(({ root, content }) => document.querySelector('.sn-storage input')?.value === root && document.querySelector('.sn-editor')?.value === content && !document.querySelector('.sn-editor')?.readOnly, { root, content: latestInput }); await showContent(page); assert.equal(await body.inputValue(), latestInput)
  } finally { await rm(formLock, { recursive: true, force: true }); await rm(bodyLock, { recursive: true, force: true }) }
  assert.equal(await calls(), initialCalls, 'save status, milestones and recovery are zero-call operations')
  await writeFile(join(output, 'save-recovery-validation.json'), JSON.stringify({ result: 'PASS', currentBookAndInputScoped: true, namedFullBackup: true, doubleClickSingleArchive: true, originalNodeAndPosition: true, restoredCopyPreview: true, failedBodyAndFormBlockSwitch: true, originalInputsConfirmedBeforeSwitch: true, sourceIdentityKept: true, returnToOriginalInput: true, widths: [300, 420, 900], fixedModelCalls: 0, liveModelCalls: 0 }, null, 2))
  console.log('PASS save recovery: input receipts, named milestones, copy preview, two failure gates, switch and original input recovery.')
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { const output = resolve(process.argv[2]), identity = await createRecoveryFixture(output); await withWorkspace(output, page => checkSaveRecovery(page, output, identity)) }
