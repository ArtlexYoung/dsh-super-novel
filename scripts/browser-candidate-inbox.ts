import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BookStore } from '../lib/host/book-store.js'
import { ProposalStore } from '../lib/host/proposal-store.js'
import { FactStore } from '../lib/host/fact-store.js'
import { IntentStore } from '../lib/host/intent-store.js'
import { StoryStore } from '../lib/host/story-store.js'
import { emptyIntent } from '../lib/domain/intents.js'
import { hash, json } from '../lib/domain/books.js'
import { withWorkspace, selectBook, openManagement, openGeneration, showContent, resizeSidebar } from './browser-workspace.ts'
const signal = () => new AbortController().signal
const response = value => ({ replacement: json(value), complete: true, reason: '', usage: { state: 'unknown' } })

/** Prepare canonical fixed records in a task-owned workspace, without provider calls. */
export async function createInboxFixture(output) {
  const root = join(output, 'workspace'); await mkdir(root, { recursive: true })
  const books = await BookStore.at(root), workspaceId = hash(root), first = randomUUID(), second = randomUUID(), material = randomUUID()
  const firstText = '林舟走向渡口，铜钥匙还在掌心。', secondText = '林舟交还钥匙。船头刻着白花。'
  let book = await books.createBook({ title: '待确认验收', operationId: randomUUID() }, signal())
  for (const [chapterId, title, content] of [[first, '渡口', firstText], [second, '白花', secondText]]) book = await books.mutate({ bookId: book.bookId, chapterId, title, content, action: 'create', expectedRevision: book.revision, expectedHash: '', beforeChapterId: '', operationId: randomUUID() }, signal())
  book = await books.upgrade(book.bookId, book.revision, randomUUID(), signal())
  book = await books.mutate({ bookId: book.bookId, chapterId: material, title: '铜钥匙资料', content: '旧设定：钥匙属于林舟。', kind: 'seed', action: 'create', expectedRevision: book.revision, expectedHash: '', beforeChapterId: '', operationId: randomUUID(), sourceEvidence: { chapterId: first, revision: 1, hash: hash(firstText), start: 0, end: 2, quote: '林舟' } }, signal())
  book = await books.metadata({ workspaceId, bookId: book.bookId, chapterId: material, expectedRevision: book.revision, operationId: randomUUID(), tags: [], aliases: [], favorite: false, status: 'active', linkedChapterIds: [second], relatedMaterialIds: [] }, signal())
  const source = { workspaceId, bookId: book.bookId, chapterId: second, expectedRevision: book.revision, expectedHash: hash(secondText) }
  const intents = await IntentStore.at(root, workspaceId, books), stories = await StoryStore.at(root, workspaceId, books), proposals = await ProposalStore.at(root, workspaceId, books), facts = await FactStore.at(root, workspaceId, books)
  const direction = await intents.suggest({ ...source, proposalId: randomUUID(), expectedVersion: 0, instruction: '测试方向' }, async () => response({ directions: [{ ...emptyIntent(), goal: '追查白花' }] }), signal())
  const story = await stories.suggest({ ...source, proposalId: randomUUID() }, async () => response({ events: [{ title: '交还钥匙', evidence: { start: 0, end: 7, quote: secondText.slice(0, 7) }, changes: [] }], foreshadows: [{ title: '白花', note: '待作者核对', evidence: { start: 7, end: secondText.length, quote: secondText.slice(7) } }] }), signal())
  const fact = await facts.propose({ bookId: book.bookId, sourceChapterId: first, proposalId: randomUUID(), expectedRevision: book.revision, expectedHash: hash(firstText), coverage: 'selection', facts: [{ subject: '林舟', predicate: '持有', value: '铜钥匙', scope: { kind: 'reader' }, sourceChapterId: first, start: 0, end: firstText.length, quote: firstText }] }, signal())
  const ids = []
  for (const [chapterId, content, replacement] of [[first, firstText, '正文候选。'], [material, '旧设定：钥匙属于林舟。', '作者待核对的新资料。']]) {
    const request = { workspaceId, bookId: book.bookId, chapterId, proposalId: randomUUID(), expectedRevision: book.revision, expectedHash: hash(content), mode: 'draft', start: 0, end: content.length, instruction: '合成候选', materials: '' }
    await proposals.create('inbox-fixture', request, signal()); await proposals.checkpoint(book.bookId, request.proposalId, replacement, 'review', '', { state: 'unknown' }, 1); ids.push(request.proposalId)
  }
  const identity = { workspaceId, bookId: book.bookId, first, second, material, firstText, secondText, direction: direction.proposalId, story: story.proposalId, fact: fact.proposalId, writing: ids[0], materialCandidate: ids[1] }
  await writeFile(join(output, 'inbox-book.json'), JSON.stringify(identity))
  return identity
}

export async function checkCandidateInbox(page, output, identity, resize = size => page.setViewportSize(size)) {
  const root = join(output, 'workspace'), books = await BookStore.at(root), folder = join(root, 'novels', identity.bookId)
  const body = page.locator('.sn-editor'), panel = page.locator('#sn-panel-inbox')
  const calls = async () => JSON.parse(await readFile(join(output, 'generation-calls.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '[]'; throw error })).length
  const beforeCalls = await calls()
  const inbox = async () => { await openManagement(page); await page.getByRole('button', { name: 'Awaiting review', exact: true }).click(); await panel.locator('.sn-inbox-items').waitFor() }
  const card = (kind, id) => panel.locator(`[data-candidate-key="${kind}:${id}"]`)
  await selectBook(page, identity.bookId)
  await body.fill(identity.firstText + ' 尚未保存的草稿。')
  const draft = await body.inputValue(), original = await body.elementHandle()
  await inbox(); assert.equal(await panel.locator('[data-candidate-key]').count(), 5)
  for (const width of [300, 420]) {
    await resizeSidebar(page, width)
    assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 2), `inbox fits ${width}px`)
    await page.screenshot({ path: join(output, `candidate-inbox-${width}.png`) })
  }
  await page.keyboard.press('Escape'); await showContent(page)
  assert(await body.evaluate((element, original) => element === original, original)); assert.equal(await body.inputValue(), draft)
  await inbox(); await card('facts', identity.fact).getByRole('button', { name: 'Open review', exact: true }).click()
  const facts = page.locator('.sn-facts'); await facts.getByLabel('Fact records', { exact: true }).waitFor()
  assert.equal(await facts.getByLabel('Fact records', { exact: true }).inputValue(), identity.fact)
  assert(await facts.getByRole('button', { name: 'Accept facts', exact: true }).isDisabled(), 'unsaved prose blocks adoption')
  await facts.getByRole('button', { name: 'Reject', exact: true }).click(); await facts.getByRole('status').filter({ hasText: /^Rejected$/ }).waitFor()
  await facts.getByRole('button', { name: 'Back to awaiting review', exact: true }).click(); await card('facts', identity.fact).waitFor({ state: 'hidden' })
  await card('intent', identity.direction).getByRole('button', { name: 'Open review', exact: true }).click()
  await page.waitForFunction(id => document.querySelector('.sn-editor')?.dataset.chapterId === id, identity.second)
  const intent = page.locator('#sn-panel-intent'), direction = intent.locator(`[data-proposal-id="${identity.direction}"]`)
  await direction.getByRole('button', { name: 'Choose and edit', exact: true }).click()
  await intent.getByLabel('Who wants what', { exact: true }).fill('作者改成寻找证人')
  await intent.getByRole('button', { name: 'Save intent', exact: true }).click(); await intent.getByRole('status').filter({ hasText: 'Intent saved to disk' }).waitFor()
  await direction.locator('summary').filter({ hasText: 'Accepted' }).waitFor()
  await intent.getByRole('button', { name: 'Back to awaiting review', exact: true }).click(); await card('intent', identity.direction).waitFor({ state: 'hidden' })
  await card('story', identity.story).getByRole('button', { name: 'Open review', exact: true }).click()
  const state = page.locator('#sn-panel-story-state'), suggestion = state.locator(`[data-proposal-id="${identity.story}"]`)
  await suggestion.getByRole('button', { name: 'Check and edit suggestion', exact: true }).first().click()
  await state.getByLabel('Record title', { exact: true }).fill('作者确认交还钥匙')
  await state.getByRole('button', { name: 'Confirm story record', exact: true }).click(); await state.locator('.sn-story-form').waitFor({ state: 'hidden' })
  await inbox(); assert(await card('story', identity.story).isVisible(), 'remaining foreshadow stays pending')
  await card('story', identity.story).getByRole('button', { name: 'Open review', exact: true }).click()
  await suggestion.getByRole('button', { name: 'Reject', exact: true }).click(); await suggestion.locator('summary').filter({ hasText: 'Rejected' }).waitFor()
  const ledger = await (await StoryStore.at(root, identity.workspaceId, books)).read(identity.bookId)
  assert.equal(ledger.events.length, 1); assert.equal(ledger.events[0].title, '作者确认交还钥匙'); assert.equal(ledger.foreshadows.length, 0)
  await inbox(); await card('story', identity.story).waitFor({ state: 'hidden' })
  await card('writing', identity.materialCandidate).getByRole('button', { name: 'Open review', exact: true }).click()
  await page.getByRole('button', { name: 'Accept', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.sn-editor')?.value === '作者待核对的新资料。')
  await inbox(); await card('writing', identity.materialCandidate).waitFor({ state: 'hidden' })
  await card('writing', identity.writing).getByRole('button', { name: 'Open review', exact: true }).click()
  assert.equal(await body.inputValue(), draft, 'returning to prose retains its checkpointed draft')
  await writeFile(join(folder, 'chapters', `${identity.first}.md`), identity.firstText + ' 外部改变来源。')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await inbox(); await card('writing', identity.writing).getByText('Expired', { exact: false }).waitFor()
  await card('writing', identity.writing).getByRole('button', { name: 'Open review', exact: true }).click()
  await page.getByRole('button', { name: 'Accept', exact: true }).waitFor()
  assert(await page.getByRole('button', { name: 'Accept', exact: true }).isDisabled())
  await inbox(); await card('source', identity.material).getByRole('button', { name: 'Check source', exact: true }).click()
  const library = page.locator('#sn-panel-library'); await library.getByRole('heading', { name: '铜钥匙资料', exact: true }).waitFor()
  assert.equal(await body.inputValue(), draft, 'checking material provenance does not switch the editor')
  assert.equal(await calls(), beforeCalls, 'queries and existing candidate decisions use no model')
  await library.getByRole('button', { name: 'AI organization candidate', exact: true }).click()
  await library.getByRole('heading', { name: 'Check material generation scope', exact: true }).waitFor()
  assert.equal(await calls(), beforeCalls, 'scope preview is free')
  await library.getByText('Inspect saved sources', { exact: true }).click()
  await library.locator('.sn-material-ai-preview').getByText('白花', { exact: true }).waitFor()
  let current = await books.readBook(identity.bookId), material = current.chapters.find(item => item.chapterId === identity.material)
  await books.metadata({ workspaceId: identity.workspaceId, bookId: identity.bookId, chapterId: identity.material, operationId: randomUUID(), expectedRevision: current.revision, tags: ['重新核对'], aliases: [], favorite: false, status: 'active', linkedChapterIds: material.linkedChapterIds ?? [], relatedMaterialIds: [] }, signal())
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await library.getByRole('alert').filter({ hasText: 'The material or links changed.' }).waitFor()
  assert(await library.getByRole('button', { name: 'Confirm scope and generate once', exact: true }).isDisabled())
  await library.getByRole('button', { name: 'AI organization candidate', exact: true }).click()
  await library.getByRole('button', { name: 'Confirm scope and generate once', exact: true }).click()
  await page.locator('#sn-panel-revisions').waitFor(); await page.getByRole('button', { name: 'Accept', exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => [...document.querySelectorAll('#sn-panel-revisions button')].some(button => button.textContent.trim() === 'Accept' && !button.disabled))
  const candidates = (await readdir(join(folder, 'proposals'))).filter(name => name.endsWith('.json'))
  assert.equal(candidates.length, 3)
  assert.equal(await calls(), beforeCalls + 1)
  assert.equal((await books.readChapter(identity.bookId, identity.material)).content, '作者待核对的新资料。', 'generation has not overwritten material')
  await inbox(); await page.keyboard.press('Escape'); await inbox(); assert.equal(await calls(), beforeCalls + 1, 'reopening does not generate again')
  await page.keyboard.press('Escape'); await openGeneration(page)
  const previous = new Set(candidates)
  await page.getByLabel('Writing instructions', { exact: true }).fill('[slow] 有明确的停止边界。')
  await page.getByRole('button', { name: 'Generate', exact: true }).click(); await page.getByRole('button', { name: 'Stop', exact: true }).waitFor()
  const pendingFiles = (await readdir(join(folder, 'proposals'))).filter(name => name.endsWith('.json') && !previous.has(name))
  assert.equal(pendingFiles.length, 1)
  const pendingId = pendingFiles[0].slice(0, -5)
  await page.getByRole('button', { name: 'Back to awaiting review', exact: true }).click()
  const pendingCard = card('writing', pendingId); await pendingCard.getByText('Generating', { exact: false }).waitFor()
  const button = pendingCard.getByRole('button', { name: 'Open review', exact: true }), focused = await button.elementHandle()
  await button.focus(); await page.waitForTimeout(2300)
  assert(await button.evaluate((element, focused) => element === focused && document.activeElement === element, focused), 'background generation polling retains the review control and focus')
  await button.click(); await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await page.locator('.sn-candidate-status [role=status]').filter({ hasText: /^Incomplete$/ }).waitFor()
  assert(await page.getByRole('button', { name: 'Accept', exact: true }).isDisabled())
  await inbox(); await card('writing', pendingId).getByText('Incomplete', { exact: false }).waitFor()
  assert.equal(await calls(), beforeCalls + 2)
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Fullscreen', exact: true }).click(); await resize({ width: 900, height: 800 }); await inbox()
  assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 2)); await page.screenshot({ path: join(output, 'candidate-inbox-900.png') })
  await writeFile(join(output, 'candidate-inbox-validation.json'), JSON.stringify({ result: 'PASS', kinds: ['writing', 'material', 'facts', 'intent', 'story', 'source'], draftRetainedAcrossReview: true, canonicalDecisions: true, directReviewReturn: true, partialConfirmation: true, rejectedRemainderKeepsConfirmedRecords: true, staleAdoptionRefused: true, materialPreflight: true, stalePreflightRefused: true, generationAwaitingConfirmation: true, reopenDoesNotGenerate: true, backgroundPollingRetainsFocus: true, stoppedCandidateIncomplete: true, widths: [300, 420, 900], explicitFixedModelCalls: 2, liveModelCalls: 0 }, null, 2))
  console.log('PASS candidate inbox: canonical review/decisions, drafts, provenance, explicit material preflight and 300/420/900px.')
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = resolve(process.argv[2]), identity = await createInboxFixture(output)
  await withWorkspace(output, page => checkCandidateInbox(page, output, identity))
}
