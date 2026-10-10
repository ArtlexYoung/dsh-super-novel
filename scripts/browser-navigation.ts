import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rmdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { BookStore } from '../lib/host/book-store.js'
import { hash } from '../lib/domain/books.js'
import { withWorkspace, selectBook, openDirectory, resizeSidebar } from './browser-workspace.ts'

/** All manuscripts in this check live in the isolated preview workspace. */
export async function createNavigationFixture(output) {
  const root = join(output, 'workspace'); await mkdir(root, { recursive: true })
  const store = await BookStore.at(root), bookId = randomUUID(), first = randomUUID(), second = randomUUID(), character = randomUUID(), seed = randomUUID()
  await store.createBook({ operationId: bookId, title: '导航验收' }, new AbortController().signal)
  const text = '林舟走向渡口，铜钥匙还在掌心。\n\n'.repeat(1400), source = '林舟交还铜钥匙。'
  let book = await store.mutate({ operationId: randomUUID(), bookId, chapterId: first, title: '第一章·长稿', action: 'create', content: text, expectedRevision: 1, expectedHash: '', beforeChapterId: '' }, new AbortController().signal)
  for (const [id, title, kind, content] of [[second, '第二章·渡口', 'chapter', source], [character, '林舟·人物卡', 'character', '铜钥匙是他的信物。林舟在渡口等她。'], [seed, '交还钥匙·灵感', 'seed', '查看铜钥匙的来源。']]) {
    book = await store.mutate({ operationId: randomUUID(), bookId, chapterId: id, title, kind, content, action: 'create', expectedRevision: book.revision, expectedHash: '', beforeChapterId: '' }, new AbortController().signal)
  }
  book = await store.upgrade(bookId, book.revision, randomUUID(), new AbortController().signal)
  book = await store.metadata({ workspaceId: hash(root), bookId, chapterId: character, operationId: randomUUID(), expectedRevision: book.revision, tags: [], aliases: ['阿舟'], favorite: false, status: 'active', linkedChapterIds: [first, second], relatedMaterialIds: [] }, new AbortController().signal)
  const selected = book.chapters.find(item => item.chapterId === seed)
  const raw = JSON.parse(await readFile(join(root, 'novels', bookId, 'project.json'), 'utf8'))
  raw.chapters.find(item => item.chapterId === selected.chapterId).sourceEvidence = { chapterId: second, revision: 1, hash: hash(source), start: 0, end: 2, quote: '林舟' }
  await writeFile(join(root, 'novels', bookId, 'project.json'), JSON.stringify(raw, null, 2) + '\n')
  const identity = { bookId, first, second, character, seed, text, source }
  await writeFile(join(output, 'navigation-book.json'), JSON.stringify(identity))
  return identity
}

export async function checkNavigation(page, output, identity, resize = size => page.setViewportSize(size)) {
  const beforeCalls = JSON.parse(await readFile(join(output, 'generation-calls.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '[]'; throw error })).length
  await selectBook(page, identity.bookId)
  const body = page.locator('.sn-editor')
  await body.waitFor(); await page.waitForFunction(id => document.querySelector('.sn-editor')?.dataset.chapterId === id, identity.first)
  await body.focus()
  await body.evaluate(element => element.setSelectionRange(element.value.length, element.value.length))
  await page.keyboard.insertText('尚未保存的导航草稿。')
  const draft = await body.inputValue()
  await body.evaluate(element => { element.setSelectionRange(300, 307, 'backward'); element.scrollTop = 700; element.dispatchEvent(new Event('select', { bubbles: true })); element.dispatchEvent(new Event('scroll', { bubbles: true })); window.__navigationEditor = element })
  const position = await body.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection, scroll: element.scrollTop }))
  await page.getByRole('button', { name: 'Search this book', exact: true }).click()
  const search = page.locator('#sn-panel-search')
  await search.getByLabel('Search text and materials', { exact: true }).fill('铜钥匙')
  await search.locator('.sn-search-results button').filter({ hasText: '第二章·渡口' }).click()
  const reader = page.locator('#sn-panel-reader')
  await reader.locator('mark').waitFor(); assert.equal(await reader.locator('mark').innerText(), '铜钥匙')
  assert.equal(await body.inputValue(), draft)
  await reader.locator('.sn-document-references > summary').click()
  await reader.locator('.sn-link-list button').filter({ hasText: '林舟·人物卡' }).click()
  await reader.getByRole('heading', { name: '林舟·人物卡', exact: true }).waitFor()
  await reader.getByRole('button', { name: 'Previous reference', exact: true }).click()
  await reader.getByRole('heading', { name: '第二章·渡口', exact: true }).waitFor()
  await reader.getByRole('button', { name: 'Next reference', exact: true }).click()
  await reader.getByRole('heading', { name: '林舟·人物卡', exact: true }).waitFor()
  await reader.getByRole('button', { name: 'Back to list', exact: true }).click()
  assert.equal(await search.getByLabel('Search text and materials', { exact: true }).inputValue(), '铜钥匙')
  await page.keyboard.press('Escape'); await body.waitFor({ state: 'visible' })
  assert(await body.evaluate(element => element === window.__navigationEditor))
  assert.equal(await body.inputValue(), draft)
  await page.waitForFunction(expected => { const element = document.querySelector('.sn-editor'); return element.selectionStart === expected.start && element.selectionEnd === expected.end && Math.abs(element.scrollTop - expected.scroll) < 2 }, position)
  assert.equal(await body.evaluate(element => element.selectionDirection), position.direction)
  await body.press('ControlOrMeta+z')
  await page.waitForFunction(text => document.querySelector('.sn-editor').value === text, identity.text)
  await body.press('ControlOrMeta+Shift+z'); await page.waitForFunction(text => document.querySelector('.sn-editor').value === text, draft)
  await body.press('ControlOrMeta+z'); await page.waitForFunction(text => document.querySelector('.sn-editor').value === text, identity.text)
  await body.fill(draft)
  await page.getByRole('button', { name: 'Search this book', exact: true }).click()
  await search.getByLabel('Search text and materials', { exact: true }).fill('尚未保存的导航草稿')
  await search.getByRole('status').filter({ hasText: /^0 results/ }).waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.locator('.sn-editor-toolbar [role=status]').filter({ hasText: /^Saved$/ }).waitFor()
  await body.evaluate(element => { element.focus(); element.setSelectionRange(420, 425, 'backward'); element.scrollTop = 900; element.dispatchEvent(new Event('select', { bubbles: true })); element.dispatchEvent(new Event('scroll', { bubbles: true })) })
  const reopenedPosition = await body.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, scroll: element.scrollTop }))
  await page.reload({ waitUntil: 'domcontentloaded' })
  const expand = page.getByRole('button', { name: 'Open right sidebar', exact: true }), guide = page.getByText('Novel workspace', { exact: true })
  await page.locator('.sn-books').or(expand).or(guide).first().waitFor()
  if (await expand.isVisible()) await expand.click()
  if (!await page.locator('.sn-books').isVisible()) await guide.click()
  await page.waitForFunction(text => document.querySelector('.sn-editor')?.value === text, draft)
  await page.waitForFunction(expected => { const element = document.querySelector('.sn-editor'); return element.selectionStart === expected.start && element.selectionEnd === expected.end && Math.abs(element.scrollTop - expected.scroll) < 2 }, reopenedPosition)
  // Opening the saved source is explicit and selects the exact match in the editor.
  await page.getByRole('button', { name: 'Search this book', exact: true }).click()
  await search.getByLabel('Search text and materials', { exact: true }).fill('铜钥匙')
  await search.locator('.sn-search-results button').filter({ hasText: '第二章·渡口' }).click()
  await reader.locator('mark').waitFor()
  await reader.getByRole('button', { name: 'Open document', exact: true }).click()
  await page.waitForFunction(id => document.querySelector('.sn-editor')?.dataset.chapterId === id, identity.second)
  await page.waitForFunction(() => { const element = document.querySelector('.sn-editor'); return element.value.slice(element.selectionStart, element.selectionEnd) === '铜钥匙' })
  await openDirectory(page); await page.locator('.sn-chapters button').filter({ hasText: '第一章·长稿' }).click()
  await page.waitForFunction(text => document.querySelector('.sn-editor')?.value === text, draft)
  await page.waitForFunction(expected => { const element = document.querySelector('.sn-editor'); return element.selectionStart === expected.start && element.selectionEnd === expected.end && Math.abs(element.scrollTop - expected.scroll) < 2 }, reopenedPosition)
  // A failed disk checkpoint must block navigation and retain every character.
  await body.fill(draft + '切换前的检查点。')
  const diskSaved = page.locator('.sn-editor-toolbar [role=status]').filter({ hasText: /^Draft saved to disk$/ })
  await diskSaved.waitFor()
  const draftsRoot = join(output, 'workspace', 'novels', identity.bookId, 'drafts', identity.first)
  const records = []
  for (const branch of await readdir(draftsRoot)) for (const name of await readdir(join(draftsRoot, branch))) {
    if (/^[0-9]{16}\.json$/.test(name)) records.push(JSON.parse(await readFile(join(draftsRoot, branch, name), 'utf8')))
  }
  const lock = join(draftsRoot, records.sort((a, b) => b.savedAt - a.savedAt)[0].branchId, '.write.lock')
  const failedDraft = draft + '磁盘繁忙时保留输入。'
  await mkdir(lock)
  try {
    await body.fill(failedDraft)
    await page.locator('.sn-editor-toolbar [role=status]').filter({ hasText: /^Disk draft failed$/ }).waitFor()
    await openDirectory(page); await page.locator('.sn-chapters button').filter({ hasText: '第二章·渡口' }).click()
    await page.locator('.sn-books > .sn-alert:not(.sn-draft-alert)').waitFor()
    assert.equal(await body.getAttribute('data-chapter-id'), identity.first)
    assert.equal(await body.inputValue(), failedDraft)
    await page.keyboard.press('Escape')
  } finally { await rmdir(lock) }
  await page.getByRole('button', { name: 'Retry checkpoint', exact: true }).click(); await diskSaved.waitFor()
  await body.fill(draft)
  await page.locator('.sn-editor-toolbar [role=status]').filter({ hasText: /^Saved$/ }).waitFor()
  await openDirectory(page); await page.locator('.sn-chapters button').filter({ hasText: '第二章·渡口' }).click()
  await page.waitForFunction(id => document.querySelector('.sn-editor')?.dataset.chapterId === id, identity.second)
  await openDirectory(page); await page.locator('.sn-chapters button').filter({ hasText: '第一章·长稿' }).click()
  await page.waitForFunction(text => document.querySelector('.sn-editor')?.value === text, draft)
  await page.getByRole('button', { name: 'Search this book', exact: true }).click()
  await search.getByLabel('Search text and materials', { exact: true }).fill('交还钥匙')
  await search.locator('.sn-search-results button').filter({ hasText: '交还钥匙·灵感' }).click()
  await reader.getByRole('heading', { name: '交还钥匙·灵感', exact: true }).waitFor()
  await writeFile(join(output, 'workspace', 'novels', identity.bookId, 'chapters', `${identity.second}.md`), '林舟改变了决定。铜钥匙仍未交还。')
  await reader.locator('.sn-document-references > summary').click()
  await reader.locator('.sn-document-links').filter({ hasText: 'Selection source' }).getByRole('button').click()
  await reader.getByRole('alert').filter({ hasText: 'The source changed.' }).waitFor()
  assert.equal(await reader.locator('mark').count(), 0)
  await page.keyboard.press('Escape'); await body.waitFor({ state: 'visible' }); assert.equal(await body.inputValue(), draft)
  for (const width of [300, 420]) {
    await resizeSidebar(page, width)
    await page.getByRole('button', { name: 'Search this book', exact: true }).click()
    await search.getByLabel('Search text and materials', { exact: true }).fill('铜钥匙')
    await search.locator('.sn-search-results button').first().waitFor()
    assert(await search.evaluate(element => element.scrollWidth <= element.clientWidth + 2))
    assert(await search.locator('.sn-search-snippet').evaluateAll(elements => elements.every(element => element.getBoundingClientRect().height <= 64)), 'Long paragraphs must remain compact search snippets')
    await page.screenshot({ path: join(output, `navigation-${width}.png`) })
    await page.keyboard.press('Escape')
  }
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click(); await resize({ width: 900, height: 800 })
  await page.waitForFunction(() => document.querySelector('.sn-books').dataset.compact === 'false')
  await page.getByRole('button', { name: 'Search this book', exact: true }).click()
  await search.getByLabel('Search text and materials', { exact: true }).fill('铜钥匙')
  await search.locator('.sn-search-results button').first().waitFor()
  assert(await search.evaluate(element => element.scrollWidth <= element.clientWidth + 2))
  await page.screenshot({ path: join(output, 'navigation-900.png') })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click(); await resize({ width: 1440, height: 1000 })
  const afterCalls = JSON.parse(await readFile(join(output, 'generation-calls.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '[]'; throw error })).length
  assert.equal(afterCalls, beforeCalls)
  await writeFile(join(output, 'navigation-validation.json'), JSON.stringify({ result: 'PASS', searchSavedText: true, references: true, backForward: true, sameEditor: true, retainedDraft: true, undo: true, redo: true, reopenedPosition: true, preciseDocumentOpening: true, failedCheckpointBlocksSwitch: true, staleEvidence: true, widths: [300, 420, 900], modelCalls: afterCalls - beforeCalls }, null, 2))
  console.log('PASS navigation: saved-text search, references/history, draft/Undo, reopened position, stale evidence and narrow layout; zero model calls.')
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = resolve(process.argv[2])
  const previous = await readFile(join(output, 'navigation-book.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const identity = previous ? JSON.parse(previous) : await createNavigationFixture(output)
  await withWorkspace(output, page => checkNavigation(page, output, identity))
}
