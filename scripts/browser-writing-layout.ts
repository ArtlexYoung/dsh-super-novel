/** Packed-plugin checks for actual sidebar geometry and uninterrupted writing. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSidebarFixture } from './browser-sidebar.ts'
import { withWorkspace, selectBook, showContent, openDirectory, openManagement, resizeSidebar, openHostSettings } from './browser-workspace.ts'

export async function createWritingLayoutFixture(output) {
  const identity = await createSidebarFixture(output), folder = join(output, 'workspace/novels', identity.bookId)
  const book = JSON.parse(await readFile(join(folder, 'project.json'), 'utf8'))
  const reference = book.chapters.find(item => item.kind === 'chapter-outline' && item.linkedChapterId === identity.proseId)
  const content = '本章目标：林舟带信渡河。\n\n阻力：左腕受伤，不能游泳；渡船准备收班。\n\n转折：信使赶到岸边，船夫必须立刻决定是否离岸。\n\n结尾：停在船离岸时，暂不揭开信中的秘密。'
  book.title = '雨夜渡河'; reference.title = '第一章 · 渡河章纲'
  reference.hash = createHash('sha256').update(content).digest('hex')
  await writeFile(join(folder, 'chapters', `${reference.chapterId}.md`), content)
  await writeFile(join(folder, 'project.json'), JSON.stringify(book))
  return identity
}

export async function checkWritingLayout(page, output, identity, resize = size => page.setViewportSize(size)) {
  const exit = page.getByRole('button', { name: 'Exit fullscreen', exact: true })
  if (await exit.isVisible()) await exit.click()
  await selectBook(page, identity.bookId)
  await openDirectory(page)
  await page.getByRole('tab', { name: 'Chapters', exact: true }).click()
  await page.locator('.sn-chapters button').filter({ hasText: '第一章' }).click()
  const body = page.locator('.sn-editor'), root = page.locator('.super-novel-setup')
  const saved = () => page.locator('.sn-editor-toolbar [role=status]').filter({ hasText: /^Saved$/ }).waitFor()
  const calls = () => readFile(join(output, 'generation-calls.json'), 'utf8').then(text => JSON.parse(text).length, () => 0)
  const beforeCalls = await calls()
  const manuscript = [
    '雨从柳枝落下，打湿了渡口最后一盏灯。林舟站在石阶上，看着船夫解开缆绳。',
    '“还过河吗？”他问。船夫没有抬头，只将绳结往掌心绕了一圈。',
    '林舟摸了摸怀里的信。油纸完好，封口却被体温焐得发软。他向前走了一步，左腕随即疼起来。',
    '“明早再来。”船夫说，“今晚水急。”',
    '岸上有脚步声。林舟回头，看见一道人影从茶棚后走出。他把左手藏进袖中，右手扶住船沿。',
    '船夫终于看向他，又看了看石阶上的人影。两人都没有再说话。',
    '林舟将铜钱放在船头。钱滚了一圈，碰到一只空木碗，发出清脆的声响。',
    '那道人影加快了脚步。林舟低声说：“信得在天亮前送到。”',
    '船夫伸手按住木碗，收起铜钱，抬脚把缆绳踢进船舱。',
    '林舟跨进船里。湿木板在脚下轻轻晃动，石阶与船头之间的缝隙慢慢宽了。',
  ].join('\n\n').concat('\n\n').repeat(12)
  await body.fill(manuscript)
  const saveButton = page.getByRole('button', { name: 'Save', exact: true })
  if (await saveButton.isEnabled()) await saveButton.click()
  await saved()
  const formal = join(output, 'workspace/novels', identity.bookId, 'chapters', `${identity.proseId}.md`)
  assert.equal(await readFile(formal, 'utf8'), manuscript)
  const originalNode = await body.elementHandle()
  const sameEditor = () => body.evaluate((element, original) => element === original, originalNode).then(value => assert(value, 'Tools must preserve the original textarea and undo stack'))
  const position = () => body.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection, scroll: element.scrollTop }))
  const remember = async () => {
    await body.focus()
    await body.evaluate(element => { element.setSelectionRange(2600, 2612, 'backward'); element.scrollTop = 700; element.dispatchEvent(new Event('select', { bubbles: true })); element.dispatchEvent(new Event('scroll', { bubbles: true })) })
    return position()
  }
  const unchanged = async expected => {
    await sameEditor()
    assert.equal(await body.inputValue(), manuscript)
    await page.waitForFunction(expected => {
      const editor = document.querySelector('.sn-editor')
      return editor.selectionStart === expected.start && editor.selectionEnd === expected.end && Math.abs(editor.scrollTop - expected.scroll) < 2
    }, expected)
    assert.equal((await position()).direction, expected.direction)
    assert.equal(await readFile(formal, 'utf8'), manuscript)
  }
  const geometry = async label => {
    const measured = await root.evaluate(element => {
      const rect = item => { const { x, y, width, height, bottom, right } = item.getBoundingClientRect(); return { x, y, width, height, bottom, right } }
      return { pane: rect(element), writing: rect(element.querySelector('.sn-editor')), toolbar: rect(element.querySelector('.sn-editor-toolbar')), navigation: rect(element.querySelector('.sn-work-tabs')), overflow: element.scrollWidth - element.clientWidth }
    })
    assert(measured.overflow <= 1, `${label}: no horizontal overflow`)
    assert(measured.writing.height / measured.pane.height >= .6, `${label}: writing should occupy at least 60% of the pane`)
    for (const key of ['writing', 'toolbar', 'navigation']) {
      const item = measured[key]
      assert(item.x >= measured.pane.x && item.right <= measured.pane.right + 1, `${label}: ${key} fits horizontally`)
      assert(item.y >= measured.pane.y && item.bottom <= measured.pane.bottom + 1, `${label}: ${key} fits vertically`)
    }
    return { label, ...measured }
  }
  const results = []
  await resize({ width: 1440, height: 1000 })
  for (const width of [300, 420]) {
    await resizeSidebar(page, width); await showContent(page)
    results.push(await geometry(`${width}px`))
    const expected = await remember()
    for (const tool of ['directory', 'materials', 'management']) {
      await page.locator(`#sn-tab-${tool}`).click()
      const panel = page.locator(`#sn-panel-${tool}`)
      await panel.waitFor()
      assert.equal(await page.locator('.sn-workspace-panel[role=dialog]:visible').count(), 1)
      assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1))
      // Tab cycles within the current tool; Escape returns to the same writing position.
      const focusable = await panel.evaluate(element => [...element.querySelectorAll('button,input,select,textarea,[tabindex]')].filter(control => !control.disabled && control.tabIndex >= 0 && control.getClientRects().length).length)
      assert(focusable)
      await panel.evaluate(element => {
        const controls = [...element.querySelectorAll('button,input,select,textarea,[tabindex]')].filter(control => !control.disabled && control.tabIndex >= 0 && control.getClientRects().length)
        controls.at(-1).focus()
      })
      await page.keyboard.press('Tab')
      assert(await panel.evaluate(element => element.contains(document.activeElement)))
      await page.keyboard.press('Shift+Tab')
      assert(await panel.evaluate(element => element.contains(document.activeElement)))
      if (tool === 'materials') {
        if (await panel.locator('.sn-reference-back').isVisible()) await panel.locator('.sn-reference-back').click()
        await panel.locator('.sn-reference-list button').first().click()
        await panel.locator('.sn-reference-text').waitFor()
        if (width === 300) {
          await panel.getByRole('button', { name: 'Pin reference', exact: true }).click()
          await panel.locator('.sn-reference-back').click()
          await panel.getByRole('button', { name: 'Pinned', exact: true }).click()
          assert(await panel.locator('.sn-reference-list button').count() > 0)
          await panel.getByRole('button', { name: 'Recent', exact: true }).click()
          assert(await panel.locator('.sn-reference-list button').count() > 0)
          await panel.getByRole('button', { name: 'All', exact: true }).click()
          await panel.locator('.sn-reference-list button').first().click()
          await panel.locator('.sn-reference-text').waitFor()
        }

        assert.equal(await body.inputValue(), manuscript)
        assert.equal(await body.getAttribute('data-chapter-id'), identity.proseId)
        if (width === 300) await page.screenshot({ path: join(output, 'references-300-en.png') })
      }
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'hidden' }); await unchanged(expected)
      assert(await body.evaluate(element => element === document.activeElement))
    }
    // Changing the directory category and filters must not switch away from the chapter.
    await openDirectory(page)
    await page.getByRole('tab', { name: 'Materials and plans', exact: true }).click()
    await page.getByLabel('Filter material type', { exact: true }).selectOption('world')
    assert.equal(await body.getAttribute('data-chapter-id'), identity.proseId)
    await page.keyboard.press('Escape'); await unchanged(expected)
    await page.screenshot({ path: join(output, `writing-${width}-en.png`) })
  }
  // Previewing also preserves the node; real typing can still be undone after a tool visit.
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  assert.equal(await page.locator('.sn-preview').textContent(), manuscript)
  await page.getByRole('button', { name: 'Edit', exact: true }).click(); await sameEditor()
  const endOfText = async () => {
    await body.focus()
    await body.evaluate(element => { element.setSelectionRange(element.value.length, element.value.length); element.dispatchEvent(new Event('select', { bubbles: true })) })
  }
  await endOfText(); await page.keyboard.insertText('新增一句，用于撤销检查。')
  assert((await body.inputValue()).endsWith('新增一句，用于撤销检查。'))
  await openManagement(page); await page.keyboard.press('Escape')
  await body.press('ControlOrMeta+z'); assert.equal(await body.inputValue(), manuscript)
  // An explicit edit changes documents only after the current unsaved draft is checkpointed.
  await endOfText(); await page.keyboard.insertText('参考编辑前保留的草稿。')
  const draft = await body.inputValue()
  await page.locator('#sn-tab-materials').click()
  const reference = page.locator('#sn-panel-materials')
  if (await reference.locator('.sn-reference-list button').count()) await reference.locator('.sn-reference-list button').first().click()
  await reference.getByRole('button', { name: 'Edit this material', exact: true }).click()
  await page.locator('textarea[aria-label="Material text"]').waitFor()
  await openDirectory(page); await page.getByRole('tab', { name: 'Chapters', exact: true }).click()
  await page.locator('.sn-chapters button').filter({ hasText: '第一章' }).click()
  await page.waitForFunction(text => document.querySelector('.sn-editor')?.value === text, draft)
  assert.equal(await readFile(formal, 'utf8'), manuscript)
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await saved()
  await page.locator('#sn-tab-writing').focus(); await page.keyboard.press('ArrowRight')
  assert.equal(await page.locator('#sn-tab-directory').getAttribute('aria-selected'), 'true')
  await page.keyboard.press('Escape')
  await page.locator('#sn-tab-writing').focus(); await page.keyboard.press('End')
  assert.equal(await page.locator('#sn-tab-management').getAttribute('aria-selected'), 'true')
  await page.keyboard.press('Escape')
  await resize({ width: 1440, height: 650 }); await resizeSidebar(page, 300)
  results.push(await geometry('300px / short window'))
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click(); await resize({ width: 900, height: 800 })
  await page.waitForFunction(() => document.querySelector('.sn-books').dataset.compact === 'false')
  assert.equal(await page.locator('#sn-panel-directory').getAttribute('role'), 'region')
  assert.equal(await body.inputValue(), draft)
  results.push(await geometry('900px fullscreen'))
  await page.screenshot({ path: join(output, 'writing-900-en.png') })
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click(); await resize({ width: 1440, height: 1000 })
  await openHostSettings(page)
  await page.getByRole('button', { name: 'Dark', exact: true }).click()
  await page.getByRole('button', { name: 'English', exact: true }).click(); await page.getByText('中文', { exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await resizeSidebar(page, 300)
  results.push(await geometry('300px / Chinese dark'))
  await body.evaluate(element => { element.scrollTop = 0 })
  await page.screenshot({ path: join(output, 'writing-300-zh-dark.png') })
  await page.locator('#sn-tab-materials').click()
  await page.locator('#sn-panel-materials .sn-reference-text').waitFor()
  await page.screenshot({ path: join(output, 'references-300-zh-dark.png') })
  await page.keyboard.press('Escape')
  assert.equal(await calls(), beforeCalls, 'Reading and navigating materials must not call the model')
  await writeFile(join(output, 'writing-layout-validation.json'), JSON.stringify({ result: 'PASS', measurements: results, positionPreserved: true, sameEditor: true, nativeUndo: true, readOnlyReference: true, explicitEditKeepsDraft: true, additionalModelCalls: 0 }, null, 2))
  console.log('PASS writing layout: 300/420px, short window, fullscreen, single tools, position, undo, references and draft retention.')
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = resolve(process.argv[2]), identity = await createWritingLayoutFixture(output)
  await withWorkspace(output, page => checkWritingLayout(page, output, identity))
}
