import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BookStore } from '../lib/host/book-store.js'
import { BackupStore } from '../lib/host/backup-store.js'
import { IntentStore } from '../lib/host/intent-store.js'
import { ProposalStore } from '../lib/host/proposal-store.js'
import { StoryStore } from '../lib/host/story-store.js'
import { hash } from '../lib/domain/books.js'
import { emptyIntent } from '../lib/domain/intents.js'
import { withWorkspace, openDirectory, openManagement, selectBook, showContent, resizeSidebar } from './browser-workspace.ts'
const signal = () => new AbortController().signal

export async function createOutlineFixture(output) {
  const root = join(output, 'workspace'); await mkdir(root, { recursive: true })
  const books = await BookStore.at(root), workspaceId = hash(root), ids = [randomUUID(), randomUUID(), randomUUID()], materialId = randomUUID(), sceneId = randomUUID()
  let book = await books.createBook({ title: '整书提纲验收', operationId: randomUUID() }, signal())
  const texts = ['林舟把铜钥匙放回桌上。她留意到钥匙齿间的白线。\n'.repeat(60), '林舟跟随白线来到渡口。船夫取出同一枚钥匙。\n'.repeat(15), '船夫交还铜钥匙，白线仍然留在齿间。\n'.repeat(15)]
  for (const [at, chapterId] of ids.entries()) {
    book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId, expectedRevision: book.revision, action: 'create', title: ['白线', '渡口', '钥匙归来'][at], content: texts[at], expectedHash: '', beforeChapterId: '' }, signal())
    if (!at) book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId: materialId, expectedRevision: book.revision, action: 'create', title: '钥匙资料', kind: 'seed', content: '作者安排的钥匙线索。', expectedHash: '', beforeChapterId: '' }, signal())
  }
  book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId: sceneId, linkedChapterId: ids[0], expectedRevision: book.revision, action: 'create', title: '桌边场景', kind: 'scene', content: '桌边还钥匙，保留人物沉默。', expectedHash: '', beforeChapterId: '' }, signal())
  book = await books.upgrade(book.bookId, book.revision, randomUUID(), signal())
  await (await IntentStore.at(root, workspaceId, books)).save({ workspaceId, bookId: book.bookId, chapterId: ids[0], expectedRevision: book.revision, expectedVersion: 0, expectedHash: hash(texts[0]), operationId: randomUUID(), intent: { ...emptyIntent(), goal: '找到白线的主人', viewpoint: '林舟' } }, signal())
  const candidate = { workspaceId, proposalId: randomUUID(), bookId: book.bookId, chapterId: ids[1], expectedRevision: book.revision, expectedHash: hash(texts[1]), mode: 'continue', instruction: '沿用前章线索', materials: '', start: texts[1].length, end: texts[1].length, precedingChapterIds: [ids[0]] }
  const proposals = await ProposalStore.at(root, workspaceId, books)
  await proposals.create('outline-fixture', candidate, signal()); await proposals.checkpoint(book.bookId, candidate.proposalId, '作者尚未采纳的候选。', 'review', '', { state: 'unknown' }, 1)
  const evidence = at => ({ chapterId: ids[at], revision: 1, hash: hash(texts[at]), start: 0, end: 2, quote: '林舟' })
  const foreshadow = { foreshadowId: randomUUID(), title: '白线回收', note: '合成验证', status: 'resolved', planted: evidence(0), resolved: evidence(1) }
  await (await StoryStore.at(root, workspaceId, books)).save({ workspaceId, bookId: book.bookId, operationId: randomUUID(), expectedVersion: 0, expectedRevision: book.revision, foreshadow }, signal())
  const identity = { workspaceId, bookId: book.bookId, ids, texts, materialId, sceneId, revision: book.revision, proposalId: candidate.proposalId }
  await writeFile(join(output, 'outline-book.json'), JSON.stringify(identity))
  return identity
}

export async function checkBookOutline(page, output, identity, resize = size => page.setViewportSize(size)) {
  const books = await BookStore.at(join(output, 'workspace')), panel = page.locator('#sn-panel-outline'), body = page.locator('.sn-editor'), book = () => books.readBook(identity.bookId)
  const calls = async () => JSON.parse(await readFile(join(output, 'generation-calls.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '[]'; throw error })).length, beforeCalls = await calls()
  const expand = async locator => { if (!await locator.evaluate(element => element.open)) await locator.locator(':scope > summary').click() }
  const open = async () => { await openDirectory(page); await page.locator('#sn-panel-directory').getByRole('button', { name: 'Book outline', exact: true }).click(); await panel.waitFor() }
  const waitDisk = async () => {
    const state = panel.locator('.sn-form-draft-status[data-state=disk],.sn-form-draft-status[data-state=failed]')
    await state.waitFor()
    assert.equal(await state.getAttribute('data-state'), 'disk', `form checkpoint: ${await state.getAttribute('data-reason')}`)
  }
  await selectBook(page, identity.bookId); await body.fill(identity.texts[0] + '尚未保存的正文输入。')
  await body.evaluate(element => { element.setSelectionRange(32, 44); element.scrollTop = 280 })
  const original = await body.elementHandle(), draftText = await body.inputValue(), position = await body.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, scroll: element.scrollTop }))
  await open(); assert.equal((await book()).schemaVersion, 2, 'opening does not migrate')
  await panel.getByRole('button', { name: 'Back up and enable outline', exact: true }).click(); await panel.locator('.sn-outline-card').first().waitFor()
  const backups = await (await BackupStore.at(join(output, 'workspace'))).list(identity.bookId)
  assert(backups.some(item => item.revision === identity.revision && item.verifiedAt > 0 && !item.recoveryRequired), 'activation verified the pre-upgrade book')
  assert.equal((await book()).schemaVersion, 3); assert.equal(await panel.locator('.sn-outline-card').count(), 3)
  await panel.getByText('找到白线的主人', { exact: false }).waitFor()
  const first = panel.locator(`[data-chapter-id="${identity.ids[0]}"]`)
  await expand(first.locator('.sn-outline-scenes')); await first.getByRole('button', { name: '桌边场景', exact: true }).click()
  await page.locator('#sn-panel-reader').getByText('桌边还钥匙，保留人物沉默。', { exact: true }).waitFor()
  await page.locator('#sn-panel-reader').getByRole('button', { name: 'Back to list', exact: true }).click(); await panel.waitFor()
  for (const width of [300, 420]) {
    await resizeSidebar(page, width); assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 2), `outline fits ${width}px`)
    assert(await panel.locator('.sn-outline-cards').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length === 1))
    await page.screenshot({ path: join(output, `book-outline-${width}.png`) })
  }
  await page.keyboard.press('Escape'); await showContent(page)
  assert(await body.evaluate((element, original) => element === original, original)); assert.equal(await body.inputValue(), draftText)
  const returned = await body.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, scroll: element.scrollTop }))
  assert.equal(returned.start, position.start); assert.equal(returned.end, position.end); assert(Math.abs(returned.scroll - position.scroll) < 2)
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click(); await resize({ width: 900, height: 800 }); await open()
  assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 2)); assert(await panel.locator('.sn-outline-cards').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length === 2))
  await page.screenshot({ path: join(output, 'book-outline-900.png') })
  await first.getByRole('button', { name: 'Arrange chapter', exact: true }).click(); await panel.locator('.sn-structure-editor').waitFor()
  await expand(panel.locator('.sn-outline-groups'))
  for (const name of ['第一卷', '第二卷']) { await panel.getByLabel('New volume title', { exact: true }).fill(name); await panel.getByRole('button', { name: 'Add volume', exact: true }).click() }
  await panel.getByLabel('New storyline title', { exact: true }).fill('钥匙线'); await panel.getByRole('button', { name: 'Add storyline', exact: true }).click()
  const volumes = await panel.getByLabel('Chapter volume', { exact: true }).locator('option').evaluateAll(items => items.map(item => ({ id: item.value, text: item.textContent })))
  const a = volumes.find(item => item.text === '第一卷').id, b = volumes.find(item => item.text === '第二卷').id
  await panel.getByLabel('Chapter volume', { exact: true }).selectOption(a); await panel.getByLabel('Chapter summary', { exact: true }).fill('林舟发现白线，决定去渡口。')
  await panel.getByLabel('Writing progress', { exact: true }).selectOption('draft'); await expand(panel.locator('.sn-outline-line-selector')); await panel.getByLabel('钥匙线', { exact: true }).check()
  await panel.getByLabel('Arrange chapter', { exact: true }).selectOption(identity.ids[1]); await panel.getByLabel('Chapter volume', { exact: true }).selectOption(a)
  await panel.getByRole('button', { name: 'Move up', exact: true }).focus(); await page.keyboard.press('Enter')
  await panel.getByLabel('Arrange chapter', { exact: true }).selectOption(identity.ids[2]); await panel.getByLabel('Chapter volume', { exact: true }).selectOption(b)
  await waitDisk(); assert.deepEqual((await book()).chapters.filter(item => !item.kind).map(item => item.chapterId), identity.ids, 'draft arrangements do not change the book')
  await panel.getByRole('button', { name: 'Preview structure changes', exact: true }).click(); await panel.locator('.sn-structure-preview').waitFor()
  await panel.getByText('白线回收', { exact: false }).waitFor()
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click(); await open()
  for (const width of [300, 420]) {
    await resizeSidebar(page, width); assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 2))
    const bounds = await panel.boundingBox(), confirmation = await panel.getByRole('button', { name: 'Confirm structure', exact: true }).boundingBox()
    assert(confirmation.y >= bounds.y && confirmation.y + confirmation.height <= bounds.y + bounds.height + 1, 'preview confirmation is visible')
    await page.screenshot({ path: join(output, `book-structure-preview-${width}.png`) })
  }
  let current = await book()
  await books.metadata({ workspaceId: identity.workspaceId, bookId: identity.bookId, chapterId: identity.materialId, expectedRevision: current.revision, operationId: randomUUID(), tags: ['另一窗口'], aliases: [], favorite: false, status: 'active', linkedChapterIds: [], relatedMaterialIds: [] }, signal())
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await panel.getByRole('alert').filter({ hasText: 'The book version changed.' }).waitFor(); assert(await panel.getByRole('button', { name: 'Confirm structure', exact: true }).isDisabled())
  await panel.getByRole('button', { name: 'Back to editing', exact: true }).click(); await panel.getByRole('button', { name: 'Checked; continue with my input', exact: true }).click()
  await panel.getByLabel('Arrange chapter', { exact: true }).selectOption(identity.ids[0]); assert.equal(await panel.getByLabel('Chapter summary', { exact: true }).inputValue(), '林舟发现白线，决定去渡口。')
  await panel.getByRole('button', { name: 'Preview structure changes', exact: true }).click(); await panel.getByRole('button', { name: 'Confirm structure', exact: true }).click()
  await panel.getByRole('status').filter({ hasText: 'Structure saved; text files preserved.' }).waitFor()
  current = await book(); assert.deepEqual(current.chapters.filter(item => !item.kind).map(item => item.chapterId), [identity.ids[1], identity.ids[0], identity.ids[2]])
  assert.equal(current.chapters.find(item => item.chapterId === identity.ids[0]).structure.summary, '林舟发现白线，决定去渡口。')
  for (const [at, id] of identity.ids.entries()) assert.equal((await books.readChapter(identity.bookId, id)).content, identity.texts[at])
  assert.equal((await (await ProposalStore.at(join(output, 'workspace'), identity.workspaceId, books)).view(identity.bookId, identity.proposalId, false)).state, 'expired')
  assert.equal((await (await StoryStore.at(join(output, 'workspace'), identity.workspaceId, books)).read(identity.bookId)).foreshadows[0].state, 'expired')
  await panel.getByRole('button', { name: 'Preview undo of last structure change', exact: true }).click(); await panel.getByRole('button', { name: 'Preview structure changes', exact: true }).click(); await panel.getByRole('button', { name: 'Confirm structure', exact: true }).click()
  await panel.getByRole('status').filter({ hasText: 'Structure saved; text files preserved.' }).waitFor(); assert.deepEqual((await book()).chapters.filter(item => !item.kind).map(item => item.chapterId), identity.ids)
  await panel.getByRole('button', { name: 'Back to outline', exact: true }).click()
  await page.keyboard.press('Escape'); await showContent(page)
  assert.equal(await body.inputValue(), draftText, 'activation, reordering and undo preserve the unsaved body')
  await page.locator('.sn-editor-toolbar [role=status]').filter({ hasText: /^Draft saved to disk$/ }).waitFor()
  await open()
  await panel.getByRole('button', { name: 'Arrange structure', exact: true }).click()
  await panel.getByLabel('Arrange chapter', { exact: true }).selectOption(identity.ids[0]); await panel.getByLabel('Chapter summary', { exact: true }).fill('从磁盘恢复的结构草稿。'); await waitDisk()
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('super-novel.form:structure:')) localStorage.removeItem(key) })
  await page.evaluate(identity => new Promise((resolve, reject) => {
    const request = indexedDB.open('super-novel-drafts', 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result, transaction = database.transaction('drafts', 'readwrite'), cursor = transaction.objectStore('drafts').openCursor()
      cursor.onsuccess = () => { const item = cursor.result; if (item) { if (item.value.bookId === identity.bookId) item.delete(); item.continue() } }
      transaction.oncomplete = () => { database.close(); resolve(true) }
      transaction.onerror = () => { database.close(); reject(transaction.error) }
    }
  }), identity)
  await page.reload({ waitUntil: 'domcontentloaded' })
  const expandSidebar = page.getByRole('button', { name: 'Open right sidebar', exact: true }), guide = page.getByText('Novel workspace', { exact: true })
  await page.locator('.sn-books').or(expandSidebar).or(guide).first().waitFor(); if (await expandSidebar.isVisible()) await expandSidebar.click(); if (!await page.locator('.sn-books').isVisible()) await guide.click()
  await selectBook(page, identity.bookId)
  assert.equal(await body.inputValue(), identity.texts[0], 'reload shows the formal body until a previous branch is explicitly restored')
  await openManagement(page); const recovery = page.locator('.sn-draft-recovery'); await expand(recovery)
  await recovery.locator('.sn-draft-item').filter({ hasText: 'Disk draft' }).getByRole('button', { name: 'Preview', exact: true }).first().click()
  assert.equal(await recovery.locator('.sn-draft-preview .sn-diff pre').last().innerText(), draftText)
  await recovery.getByRole('button', { name: 'Restore to editor', exact: true }).click()
  assert.equal(await body.inputValue(), draftText, 'the unsaved body is recoverable from disk without browser drafts')
  await open(); await panel.getByRole('button', { name: 'Arrange structure', exact: true }).click()
  await expand(panel.locator('.sn-form-recovery')); await panel.locator('.sn-form-recovery').getByRole('button', { name: 'Preview', exact: true }).first().click(); await panel.getByRole('button', { name: 'Restore form input', exact: true }).click()
  assert.equal(await panel.getByLabel('Chapter summary', { exact: true }).inputValue(), '从磁盘恢复的结构草稿。')
  let release, ready
  const held = new Promise(resolve => { release = resolve }), staged = new Promise(resolve => { ready = resolve })
  const heldStore = await BookStore.at(join(output, 'workspace'), { afterStage: async stage => { if (stage === 'prepared') { ready(); await held } } })
  current = await book(); const material = current.chapters.find(item => item.chapterId === identity.materialId), resumedNode = await body.elementHandle()
  const saving = heldStore.metadata({ workspaceId: identity.workspaceId, bookId: identity.bookId, chapterId: identity.materialId, expectedRevision: current.revision, operationId: randomUUID(), tags: material.tags ?? [], aliases: [], favorite: true, status: 'active', linkedChapterIds: [], relatedMaterialIds: [] }, signal())
  try { await staged; await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.locator('.sn-pending-save').waitFor(); assert(await body.evaluate((element, original) => element === original, resumedNode)); assert.equal(await panel.getByLabel('Chapter summary', { exact: true }).inputValue(), '从磁盘恢复的结构草稿。'); assert(await panel.getByRole('button', { name: 'Preview structure changes', exact: true }).isDisabled()) }
  finally { release(); await saving }
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.locator('.sn-pending-save').waitFor({ state: 'hidden' })
  assert.equal(await panel.getByLabel('Chapter summary', { exact: true }).inputValue(), '从磁盘恢复的结构草稿。')
  await page.keyboard.press('Escape'); await showContent(page); assert.equal(await body.inputValue(), draftText)
  assert.equal(await calls(), beforeCalls, 'outline, structure changes, backups and disk recovery use no model calls')
  await writeFile(join(output, 'book-outline-validation.json'), JSON.stringify({ result: 'PASS', explicitVerifiedMigration: true, canonicalGroups: true, keyboardReorder: true, intentSceneReuse: true, stalePreviewBlocked: true, inputRetainedAcrossRebind: true, originalTextBytesPreserved: true, precedingAndForeshadowValidityRechecked: true, previewableUndo: true, diskStructureDraftRecovery: true, concurrentPreparedRetainsEditorAndInput: true, sameEditorAndPosition: true, widths: [300, 420, 900], fixedModelCalls: 0, liveModelCalls: 0 }, null, 2))
  console.log('PASS book outline: verified activation, groups, keyboard reorder, impact preview, undo, disk drafts and 300/420/900px.')
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { const output = resolve(process.argv[2]), identity = await createOutlineFixture(output); await withWorkspace(output, page => checkBookOutline(page, output, identity)) }
