import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { withWorkspace, openBookCreator, showContent, openGeneration, openDocumentOptions, selectBook, openDirectory, createChapter, selectDocumentType, openMaterialCreator } from './browser-workspace.ts'

const output = resolve(process.argv[2]), mode = process.argv[3] ?? 'workflow'
const calls = async () => JSON.parse(await readFile(join(output, 'generation-calls.json'), 'utf8').catch(() => '[]'))
const initialCalls = (await calls()).length
const bookPath = id => join(output, 'workspace/novels', id)
const snapshot = async id => JSON.parse(await readFile(join(bookPath(id), 'project.json'), 'utf8'))
const text = (bookId, chapterId) => readFile(join(bookPath(bookId), 'chapters', `${chapterId}.md`), 'utf8')

await withWorkspace(output, async page => {
  const creator = page.locator('.sn-material-creator'), panel = page.locator('.sn-proposals')
  const body = page.getByRole('textbox', { name: 'Chapter text', exact: true })
  const material = page.locator('textarea[aria-label="Material text"]')
  const tab = name => selectDocumentType(page, name)
  const openCreator = () => openMaterialCreator(page)
  const openSources = async () => { const details = creator.locator('details'); if (!await details.evaluate(element => element.open)) await details.locator('summary').click() }
  const ready = () => panel.locator('.sn-candidate-status [role=status]').filter({ hasText: /^Ready for review$/ }).waitFor()
  const titleIs = title => page.waitForFunction(name => document.querySelector('input[aria-label="Rename"]')?.value === name, title)
  const chooseChapter = async name => {
    await createChapter(page, name); await titleIs(name); await body.waitFor()
  }
  let identity
  if (mode === 'workflow') {
    const previousBook = await page.getByLabel('Book', { exact: true }).inputValue()
    await openBookCreator(page)
    await page.getByRole('textbox', { name: 'Book title', exact: true }).fill('资料生成验收')
    await page.getByRole('button', { name: 'New book', exact: true }).click()
    await page.waitForFunction(previous => document.querySelector('select[aria-label="Book"]')?.value !== previous, previousBook)
    const bookId = await page.getByLabel('Book', { exact: true }).inputValue()
    await chooseChapter('已保存原文')
    const prose = '林舟左腕受伤。他站在渡口，不能游泳。'
    await body.fill(prose); await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.locator('.sn-editor-toolbar [role=status]').filter({ hasText: /^Saved$/ }).waitFor()
    const sourceId = (await snapshot(bookId)).chapters[0].chapterId
    await chooseChapter('空来源')
    const emptySourceId = (await snapshot(bookId)).chapters.at(-1).chapterId
    await tab('Materials and plans')
    const kinds = [['seed', 'Story seed'], ['book-card', 'Book card'], ['character', 'Character'], ['world', 'World'], ['outline', 'Outline'], ['chapter-outline', 'Chapter outline'], ['scene', 'Scene']]
    const generatedIds = []
    for (const [kind, name] of kinds) {
      await openCreator()
      await creator.getByLabel('Material type', { exact: true }).selectOption(kind)
      if (kind !== 'seed') {
        await openSources()
        await creator.getByRole('checkbox', { name: 'Story seed · Story seed', exact: true }).check()
        if (kind === 'character') await creator.getByRole('checkbox', { name: '已保存原文 · Chapter', exact: true }).check()
      }
      if (kind === 'scene' || kind === 'chapter-outline') await creator.getByLabel('Related chapter', { exact: true }).selectOption(sourceId)
      if (kind === 'seed') await creator.getByLabel('Idea and requirements', { exact: true }).fill('雨夜渡河，主角左腕受伤。')
      if (kind === 'seed') await creator.getByRole('button', { name: 'Generate material with AI', exact: true }).evaluate(button => { button.click(); button.click() })
      else await creator.getByRole('button', { name: 'Generate material with AI', exact: true }).click()
      await titleIs(name); await ready()
      if (kind === 'seed') assert((await panel.locator('textarea[aria-label="Writing instructions"]').inputValue()).includes('雨夜渡河'))
      assert(await panel.isVisible())
      assert.equal(await page.locator('.sn-work-tabs:visible').count(), 1)
      assert.equal(await page.locator('#sn-tab-revisions').getAttribute('aria-selected'), 'true')
      assert(!await page.locator('.sn-generation').evaluate(element => element.open))
      const target = (await snapshot(bookId)).chapters.at(-1); generatedIds.push(target.chapterId)
      assert.equal(target.kind, kind)
      if (kind === 'scene' || kind === 'chapter-outline') assert.equal(target.linkedChapterId, sourceId)
      assert.equal(await text(bookId, target.chapterId), '')
      assert.equal(await material.inputValue(), '')
      if (kind === 'character') {
        await openGeneration(page)
        await panel.getByText('Organize from saved prose', { exact: true }).click()
        assert(await panel.getByRole('checkbox', { name: '已保存原文 · Chapter', exact: true }).isChecked())
      }
      await panel.getByRole('button', { name: 'Changes', exact: true }).click()
      assert.equal(await panel.getByLabel('Original selection', { exact: true }).innerText(), '')
      await panel.getByRole('button', { name: 'Accept', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('textarea[aria-label="Material text"]')?.value.includes('候选前句'))
      assert((await text(bookId, target.chapterId)).includes('候选前句'))
    }
    const records = await Promise.all((await readdir(join(bookPath(bookId), 'proposals'))).map(async name => JSON.parse(await readFile(join(bookPath(bookId), 'proposals', name), 'utf8'))))
    assert.equal(records.length, 7)
    assert.equal(records.find(item => item.documentKind === 'character').context.filter(item => item.kind === 'chapter')[0].content, prose)
    assert.equal(records.filter(item => item.context?.some(source => source.kind === 'seed')).length, 6)
    assert.equal(await text(bookId, sourceId), prose)

    // Unsaved editing cannot be overwritten by an inline candidate.
    await showContent(page)
    await material.fill('本地未保存的资料草稿')
    await openGeneration(page)
    assert(await panel.getByRole('button', { name: 'Generate', exact: true }).isDisabled())
    await openDocumentOptions(page)
    await page.getByRole('button', { name: 'Read disk version', exact: true }).click(); await showContent(page)
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="Material text"]')?.value.includes('候选前句'))

    // A selected empty source fails after creation. Retry and reload retain both request identities.
    await openCreator(); await creator.getByLabel('Material type', { exact: true }).selectOption('character')
    await creator.getByLabel('Material name', { exact: true }).fill('失败后保留资料')
    await openSources()
    await creator.getByRole('checkbox', { name: '空来源 · Chapter', exact: true }).check()
    await creator.getByRole('button', { name: 'Generate material with AI', exact: true }).click()
    await creator.getByRole('alert').filter({ hasText: /Selected material is empty/ }).waitFor()
    const failure = (await snapshot(bookId)).chapters.at(-1)
    assert.equal(await text(bookId, failure.chapterId), '')
    const count = (await snapshot(bookId)).chapters.length
    await creator.getByRole('button', { name: 'Retry original operation', exact: true }).click()
    await creator.getByRole('alert').filter({ hasText: /Selected material is empty/ }).waitFor()
    assert.equal((await snapshot(bookId)).chapters.length, count)
    await page.reload()
    const expand = page.getByRole('button', { name: 'Open right sidebar', exact: true })
    await page.locator('.sn-books').or(expand).first().waitFor()
    if (await expand.isVisible()) await expand.click()
    const guide = page.getByText('Novel workspace', { exact: true })
    await page.locator('.sn-books').or(guide).first().waitFor()
    if (!await page.locator('.sn-books').isVisible()) await guide.click()
    await openCreator()
    await creator.getByRole('button', { name: 'Retry original operation', exact: true }).waitFor()
    await creator.getByRole('button', { name: 'Retry original operation', exact: true }).click()
    await creator.getByRole('alert').filter({ hasText: /Selected material is empty/ }).waitFor()
    assert.equal((await snapshot(bookId)).chapters.length, count)
    assert.equal((await calls()).length - initialCalls, 7)
    await creator.getByRole('button', { name: 'Create another material', exact: true }).click()
    await openGeneration(page)
    await panel.getByRole('button', { name: 'Generate', exact: true }).click(); await ready()
    assert.equal(await text(bookId, failure.chapterId), '')
    await panel.getByRole('button', { name: 'Reject', exact: true }).click()
    await panel.locator('.sn-candidate-status [role=status]').filter({ hasText: /^Rejected$/ }).waitFor()
    assert.equal(await text(bookId, failure.chapterId), '')

    // Stop and switch books without changing the running task's target.
    await openCreator(); await creator.getByLabel('Material type', { exact: true }).selectOption('world')
    await creator.getByLabel('Material name', { exact: true }).fill('可停止资料')
    await creator.getByLabel('Idea and requirements', { exact: true }).fill('[slow]')
    await creator.getByRole('button', { name: 'Generate material with AI', exact: true }).click(); await titleIs('可停止资料')
    await panel.getByRole('button', { name: 'Stop', exact: true }).waitFor()
    const stoppedId = (await snapshot(bookId)).chapters.at(-1).chapterId
    await openBookCreator(page)
    await page.getByLabel('Book title', { exact: true }).fill('另一作品')
    await page.getByRole('button', { name: 'New book', exact: true }).click()
    await page.waitForFunction(previous => document.querySelector('select[aria-label="Book"]')?.value !== previous, bookId)
    const otherId = await page.getByLabel('Book', { exact: true }).inputValue()
    await selectBook(page, bookId)
    await openDirectory(page)
    await page.locator('.sn-chapters').getByRole('button', { name: /可停止资料 · World/ }).click()
    await openGeneration(page)
    await panel.getByRole('button', { name: 'Stop', exact: true }).click()
    await panel.locator('.sn-candidate-status [role=status]').filter({ hasText: /^Incomplete$/ }).waitFor()
    assert(await panel.getByRole('button', { name: 'Accept', exact: true }).isDisabled())
    assert.equal(await text(bookId, stoppedId), '')
    assert.equal((await snapshot(otherId)).chapters.length, 0)
    assert.equal((await calls()).length - initialCalls, 9)
    identity = { bookId, sourceId, emptySourceId, generatedIds, failureId: failure.chapterId, stoppedId, otherId, prose }
    await writeFile(join(output, 'material-generation-book.json'), JSON.stringify(identity))
  } else {
    identity = JSON.parse(await readFile(join(output, 'material-generation-book.json'), 'utf8'))
    await selectBook(page, identity.bookId)
    await tab('Materials and plans')
    await openDirectory(page)
    await page.locator('.sn-chapters').getByRole('button', { name: /可停止资料 · World/ }).click()
    await page.locator('#sn-tab-revisions').click()
    await panel.locator('.sn-candidate-status [role=status]').filter({ hasText: /^Incomplete$/ }).waitFor()
    assert.equal(await panel.locator('textarea[aria-label="Writing instructions"]').inputValue(), '[slow]')
    assert.equal(await text(identity.bookId, identity.sourceId), identity.prose)
    for (const id of identity.generatedIds) assert((await text(identity.bookId, id)).includes('候选前句'))
    assert.equal(await text(identity.bookId, identity.failureId), '')
    assert.equal(await text(identity.bookId, identity.stoppedId), '')
    assert.equal((await calls()).length, initialCalls)
  }
  // Inspect the useful controls in the narrow sidebar and in both language/theme combinations.
  await openCreator()
  assert(await creator.getByRole('button', { name: 'Generate material with AI', exact: true }).isVisible())
  assert(await page.locator('.super-novel-setup').evaluate(element => element.scrollWidth <= element.clientWidth))
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Light', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click(); await page.setViewportSize({ width: 900, height: 800 })
  await creator.scrollIntoViewIfNeeded(); await page.locator('.sn-directory').evaluate(element => { element.scrollTop = 0 }); await page.screenshot({ path: join(output, 'material-generation-en-light.png') })
  assert(await page.locator('.super-novel-setup').evaluate(element => element.scrollWidth <= element.clientWidth))
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click(); await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Dark', exact: true }).click(); await page.getByRole('button', { name: 'English', exact: true }).click(); await page.getByText('中文', { exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await creator.getByRole('button', { name: 'AI 生成资料', exact: true }).waitFor()
  await page.getByRole('button', { name: '全屏', exact: true }).click(); await page.setViewportSize({ width: 900, height: 800 })
  await creator.scrollIntoViewIfNeeded(); await page.locator('.sn-directory').evaluate(element => { element.scrollTop = 0 }); await page.screenshot({ path: join(output, 'material-generation-zh-dark.png') })
  assert(await page.locator('.super-novel-setup').evaluate(element => element.scrollWidth <= element.clientWidth))
  assert.equal((await calls()).length, mode === 'workflow' ? initialCalls + 9 : initialCalls)
  console.log(`PASS ${mode}: seven material types, explicit sources, adoption, retry without duplicates, cancellation, book isolation and query-only restart.`)
})
