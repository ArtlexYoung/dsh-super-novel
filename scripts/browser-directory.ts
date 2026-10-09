import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { platform, release } from 'node:os'
import { withWorkspace, selectBook, openDirectory } from './browser-workspace.ts'
const output = resolve(process.argv[2]), bookId = randomUUID(), folder = join(output, 'workspace/novels', bookId)
await mkdir(join(folder, 'chapters'), { recursive: true })
const chapters = [], text = '长正文。'.repeat(12_000)
for (let i = 1; i <= 1000; i++) {
  const chapterId = randomUUID(), content = i === 1000 ? text : `第 ${i} 章正文。`
  chapters.push({ chapterId, title: `目录 ${String(i).padStart(4, '0')}`, revision: 1, hash: createHash('sha256').update(content).digest('hex') })
  await writeFile(join(folder, 'chapters', `${chapterId}.md`), content)
}
await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, bookId, title: '千章目录', revision: 1, chapters }))
await withWorkspace(output, async page => {
  const start = performance.now()
  await selectBook(page, bookId)
  await openDirectory(page)
  await page.locator('.sn-chapters button').first().waitFor()
  assert.equal(await page.locator('.sn-chapters button').count(), 100)
  await page.getByRole('button', { name: 'Next page', exact: true }).click()
  assert((await page.locator('.sn-chapters button').first().innerText()).includes('0101'))
  await page.getByLabel('Search chapters or materials', { exact: true }).fill('1000')
  await page.locator('.sn-chapters').getByRole('button', { name: /目录 1000/ }).click()
  const body = page.getByRole('textbox', { name: 'Chapter text', exact: true }); await body.waitFor()
  assert.equal(await body.inputValue(), text)
  assert.equal(await page.locator('.sn-chapters button').count(), 1)
  await body.evaluate(element => { element.scrollTop = element.scrollHeight })
  assert(await body.evaluate(element => element.scrollTop > 0))
  console.log(JSON.stringify({ result: 'PASS', chapters: 1000, visibleRows: 100, searchRows: 1, longCharacters: text.length, elapsedMs: Math.round(performance.now() - start), platform: platform(), release: release(), node: process.version }))
})
