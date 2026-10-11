import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BookStore } from '../lib/host/book-store.js'
import { BookStructureStore } from '../lib/host/book-structure.js'
import { BookReviewStore } from '../lib/host/book-review-store.js'
import { ProposalStore } from '../lib/host/proposal-store.js'
import { FactStore } from '../lib/host/fact-store.js'
import { DraftStore } from '../lib/host/draft-store.js'
import { hash } from '../lib/domain/books.js'
import { withWorkspace, openManagement, openDirectory, selectBook, showContent, resizeSidebar } from './browser-workspace.ts'
const signal = () => new AbortController().signal
const until = async (read, check, message) => {
  for (let at = 0; at < 100; at++) {
    try { const value = await read(); if (check(value)) return value }
    catch (error) { if (!['recovery-required', 'busy'].includes(error.code)) throw error }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(message)
}

export async function createBookReviewFixture(output) {
  const root = join(output, 'workspace'); await mkdir(root, { recursive: true })
  const books = await BookStore.at(root), workspaceId = hash(root), ids = [randomUUID(), randomUUID(), randomUUID()]
  const texts = ['林舟左腕骨折，不能握住东西。\n' + '她沿着渡口寻找丢失的铜钥匙。\n'.repeat(70), '开头保留。\n林舟用左手举起沉重的铁箱。\n结尾保留。', '范围外的正文保持原样。']
  let book = await books.createBook({ operationId: randomUUID(), title: '跨章改稿验收' }, signal())
  for (const [at, chapterId] of ids.entries()) book = await books.mutate({ operationId: randomUUID(), bookId: book.bookId, chapterId, expectedRevision: book.revision, action: 'create', title: ['伤腕', '铁箱', '范围外'][at], content: texts[at], expectedHash: '', beforeChapterId: '' }, signal())
  book = await books.upgrade(book.bookId, book.revision, randomUUID(), signal(), 3)
  const storylineId = randomUUID(), structures = await BookStructureStore.at(root, workspaceId, books)
  const request = { workspaceId, bookId: book.bookId, operationId: randomUUID(), expectedRevision: book.revision, structure: { volumes: [], storylines: [{ storylineId, title: '伤腕线' }], chapters: book.chapters.map(item => ({ chapterId: item.chapterId, ...item.structure, storylineIds: ids.slice(0, 2).includes(item.chapterId) ? [storylineId] : [] })) } }
  book = await structures.update({ ...request, previewHash: (await structures.preview(request, signal())).previewHash }, signal())
  const facts = await FactStore.at(root, workspaceId, books), quote = texts[0].split('\n')[0]
  const fact = await facts.propose({ proposalId: randomUUID(), bookId: book.bookId, sourceChapterId: ids[0], expectedRevision: book.revision, expectedHash: hash(texts[0]), facts: [{ subject: '林舟', predicate: '伤势', value: '左腕骨折', scope: { kind: 'reader' }, sourceChapterId: ids[0], start: 0, end: quote.length, quote }] }, signal())
  await facts.decide(book.bookId, fact.proposalId, fact.factsHash, true, signal())
  const identity = { workspaceId, bookId: book.bookId, ids, texts, storylineId }
  await writeFile(join(output, 'book-review-book.json'), JSON.stringify(identity)); return identity
}

export async function checkBookReview(page, output, identity, resize = size => page.setViewportSize(size)) {
  const root = join(output, 'workspace'), books = await BookStore.at(root), reviews = await BookReviewStore.at(root, identity.workspaceId, books), proposals = await ProposalStore.at(root, identity.workspaceId, books)
  const body = page.locator('.sn-editor'), panel = page.locator('#sn-panel-book-review'), tool = panel.locator('.sn-book-reviews')
  const calls = async () => JSON.parse(await readFile(join(output, 'generation-calls.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '[]'; throw error })).length, beforeCalls = await calls()
  const expand = async locator => { if (!await locator.evaluate(element => element.open)) await locator.locator(':scope > summary').click() }
  const open = async () => { await openManagement(page); await page.locator('#sn-panel-management').getByRole('button', { name: 'Cross-chapter revision', exact: true }).click(); await panel.waitFor() }
  const preview = async () => { await panel.getByRole('button', { name: 'Preview review sources', exact: true }).click(); await tool.locator('[role=status]').filter({ hasText: 'At most 1 model call' }).waitFor() }
  const records = async () => { await expand(panel.locator('.sn-review-records')); await panel.locator('.sn-review-record').first().waitFor() }
  await selectBook(page, identity.bookId)
  const originalWidth = await page.locator('.super-novel-setup').evaluate(element => element.clientWidth)
  await body.fill(identity.texts[0] + '尚未保存的正文输入。'); await body.evaluate(element => { element.setSelectionRange(30, 42); element.scrollTop = 230 })
  const node = await body.elementHandle(), text = await body.inputValue(), position = await body.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, scroll: element.scrollTop }))
  await open(); assert.equal(await panel.getByRole('checkbox').count(), 3)
  assert.deepEqual(await panel.getByRole('checkbox').evaluateAll(items => items.map(item => item.checked)), [true, true, false])
  await panel.getByLabel('Review scope', { exact: true }).selectOption(identity.storylineId); await preview(); assert.equal(await calls(), beforeCalls)
  await expand(panel.locator('.sn-review-saved-sources')); await panel.getByRole('button', { name: '伤腕', exact: true }).click()
  await page.locator('#sn-panel-reader .sn-reader-text').waitFor(); assert(!(await page.locator('#sn-panel-reader .sn-reader-text').innerText()).includes('尚未保存'))
  await page.locator('#sn-panel-reader').getByRole('button', { name: 'Back to list', exact: true }).click(); await panel.waitFor()
  for (const width of [300, 420]) {
    await resizeSidebar(page, width); assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 2), `source preview fits ${width}px`)
    const bounds = await panel.boundingBox(), button = await panel.getByRole('button', { name: 'Start cross-chapter review', exact: true }).boundingBox()
    assert(button.y >= bounds.y && button.y + button.height <= bounds.y + bounds.height, 'start action visible in narrow source preview')
    await page.screenshot({ path: join(output, `book-review-sources-${width}.png`) })
  }
  await panel.getByRole('button', { name: 'Start cross-chapter review', exact: true }).click({ clickCount: 2 })
  await panel.locator('.sn-review-issue').first().waitFor(); assert.equal(await calls(), beforeCalls + 1)
  const listing = await reviews.list(identity.bookId, signal()), reviewId = listing.items[0].reviewId
  assert.equal((await reviews.get(identity.bookId, reviewId, signal())).state, 'issues')
  const first = panel.locator('.sn-review-issue').first(), second = panel.locator('.sn-review-issue').nth(1)
  await first.getByRole('button', { name: '伤腕', exact: true }).click(); await page.locator('#sn-panel-reader mark').waitFor()
  assert.equal(await page.locator('#sn-panel-reader mark').innerText(), identity.texts[0].split('\n')[0]); await page.locator('#sn-panel-reader').getByRole('button', { name: 'Back to list', exact: true }).click()
  await first.getByRole('button', { name: 'Confirm this issue', exact: true }).click(); await first.getByRole('button', { name: 'Generate local revision candidate', exact: true }).waitFor()
  await second.locator(':scope > summary').click(); assert.equal(await panel.locator('.sn-review-issue[open]').count(), 1)
  await second.getByRole('button', { name: 'Dismiss this issue', exact: true }).click(); await second.getByText('Pacing · Dismissed', { exact: true }).waitFor()
  for (const width of [300, 420]) { await resizeSidebar(page, width); assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 2)); await page.screenshot({ path: join(output, `book-review-checklist-${width}.png`) }) }
  await page.keyboard.press('Escape'); await showContent(page); assert(await body.evaluate((element, node) => element === node, node)); assert.equal(await body.inputValue(), text)
  // Compare positions only at the original layout, after resizing back.
  await resizeSidebar(page, originalWidth); const returned = await body.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, scroll: element.scrollTop }))
  assert.equal(returned.start, position.start); assert.equal(returned.end, position.end)
  assert(Math.abs(returned.scroll - position.scroll) < 2, 'same-layout scroll retained')
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click(); await resize({ width: 900, height: 800 }); await open()
  assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 2)); await page.screenshot({ path: join(output, 'book-review-checklist-900.png') })
  assert.equal(await calls(), beforeCalls + 1); await panel.getByRole('button', { name: 'Choose scope for a new review', exact: true }).click(); await panel.getByLabel('Review focus (optional)', { exact: true }).fill('[slow]')
  await preview(); await panel.getByRole('button', { name: 'Start cross-chapter review', exact: true }).click()
  await until(calls, value => value === beforeCalls + 2, 'slow review never called'); await panel.getByRole('button', { name: 'Stop', exact: true }).click()
  await tool.locator('.sn-review-budget').waitFor(); await tool.waitFor({ state: 'visible' }); await page.waitForFunction(() => !document.querySelector('#sn-panel-book-review .sn-book-reviews').dataset.busy)
  await until(() => reviews.list(identity.bookId, signal()), result => result.items.some(item => item.reason === 'book-review-stopped'), 'stop did not persist')
  const drafts = await DraftStore.at(root, identity.workspaceId, books), savedDrafts = await drafts.list({ workspaceId: identity.workspaceId, bookId: identity.bookId, chapterId: identity.ids[0] })
  assert(savedDrafts.drafts.some(item => item.contentHash === hash(text)), 'current input retained on disk before review')
  // Lose the live browser request as well: an older desktop host may keep it running.
  await panel.getByRole('button', { name: 'Choose scope for a new review', exact: true }).click(); await preview()
  await panel.getByRole('button', { name: 'Start cross-chapter review', exact: true }).click()
  await until(calls, value => value === beforeCalls + 3, 'reload review never called')
  const reloadId = (await reviews.list(identity.bookId, signal())).items[0].reviewId
  await page.reload({ waitUntil: 'domcontentloaded' })
  const expandSidebar = page.getByRole('button', { name: 'Open right sidebar', exact: true }), guide = page.getByText('Novel workspace', { exact: true })
  await page.locator('.sn-books').or(expandSidebar).or(guide).first().waitFor()
  if (await expandSidebar.isVisible()) await expandSidebar.click()
  await page.locator('.sn-books').or(guide).first().waitFor()
  if (!await page.locator('.sn-books').isVisible()) await guide.click()
  await page.locator('.sn-books').waitFor(); await open(); await records()
  await panel.locator('.sn-review-record').filter({ hasText: reloadId.slice(0, 8) }).click(); await panel.getByText('Review incomplete', { exact: true }).first().waitFor()
  if (await panel.getByRole('button', { name: 'Stop and check request', exact: true }).isVisible()) await panel.getByRole('button', { name: 'Stop and check request', exact: true }).click()
  await until(() => reviews.get(identity.bookId, reloadId, signal()), value => value.reason === 'book-review-stopped', 'reopened request was not stopped')
  assert.equal(await calls(), beforeCalls + 3, 'reopening and stopping an existing request never resends')
  await records(); await panel.locator('.sn-review-record').filter({ hasText: reviewId.slice(0, 8) }).click(); await first.getByRole('button', { name: 'Generate local revision candidate', exact: true }).waitFor(); assert((await reviews.get(identity.bookId, reviewId, signal())).issues.some(item => item.decision === 'dismissed'))
  await first.getByRole('button', { name: 'Generate local revision candidate', exact: true }).click({ clickCount: 2 }); await page.locator('.sn-proposals .sn-candidate').waitFor()
  const summary = await until(() => proposals.list(identity.bookId, identity.ids[1], () => false), items => items.some(item => item.state === 'review'), 'candidate not ready').then(items => items.find(item => item.state === 'review'))
  const candidate = await proposals.view(identity.bookId, summary.proposalId, false)
  const target = (await reviews.get(identity.bookId, reviewId, signal())).issues[0].evidence.find(item => item.chapterId === identity.ids[1])
  assert(candidate.candidate.startsWith(identity.texts[1].slice(0, target.start))); assert(candidate.candidate.endsWith(identity.texts[1].slice(target.end))); assert.equal(await calls(), beforeCalls + 4)
  for (const [at, id] of identity.ids.entries()) assert.equal((await books.readChapter(identity.bookId, id)).content, identity.texts[at], 'generating never writes prose')
  await page.getByRole('button', { name: 'Back to cross-chapter checklist', exact: true }).click(); await first.getByRole('button', { name: 'Generate local revision candidate', exact: true }).click()
  await page.locator('.sn-proposals .sn-candidate').waitFor(); assert.equal(await calls(), beforeCalls + 4, 'same issue request reopens existing candidate')
  await page.locator('.sn-proposals').getByRole('button', { name: 'Accept', exact: true }).click(); await until(() => books.readChapter(identity.bookId, identity.ids[1]), value => value.content === candidate.candidate, 'candidate was not adopted')
  for (const at of [0, 2]) assert.equal((await books.readChapter(identity.bookId, identity.ids[at])).content, identity.texts[at])
  await page.getByRole('button', { name: 'Back to cross-chapter checklist', exact: true }).click(); await panel.getByText('Review expired', { exact: true }).first().waitFor()
  assert(await first.getByRole('button', { name: 'Generate local revision candidate', exact: true }).isDisabled()); assert.equal(await calls(), beforeCalls + 4)
  await writeFile(join(output, 'book-review-validation.json'), JSON.stringify({ result: 'PASS', savedScopePreviewMakesNoCalls: true, storyline: true, doubleClickOneCall: true, exactEvidenceNavigation: true, confirmedAndDismissedPersist: true, oneExpandedIssue: true, stoppedReloadNeverResends: true, inFlightReloadCanStopFromRecord: true, diskInputRetained: true, originalEditorAndSelection: true, localCandidateUsesOriginalReview: true, retryReopensSameCandidate: true, onlyTargetQuoteAdopted: true, staleRevisionBlocked: true, widths: [300, 420, 900], fixedModelCalls: 4, liveModelCalls: 0 }, null, 2))
  console.log('PASS cross-chapter review: scope, exact evidence, decisions, stop/reload, local revision and 300/420/900px.')
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { const output = resolve(process.argv[2]), identity = await createBookReviewFixture(output); await withWorkspace(output, page => checkBookReview(page, output, identity)) }
