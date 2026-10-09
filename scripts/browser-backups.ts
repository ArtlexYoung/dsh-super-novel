import assert from 'node:assert/strict'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openManagement, openBookCreator, createChapter, withWorkspace, showContent } from './browser-workspace.ts'

export async function checkBackups(page, output) {
  await openBookCreator(page)
  await page.getByLabel('Book title', { exact: true }).fill('完整备份演练')
  await page.getByRole('button', { name: 'New book', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('select[aria-label=Book]')?.selectedOptions[0]?.textContent === '完整备份演练')
  await createChapter(page, '备份第一章')
  const body = page.getByRole('textbox', { name: 'Chapter text', exact: true })
  await body.fill('正文保存稿。'); await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.locator('.sn-editor-toolbar [role=status]').filter({ hasText: /^Saved$/ }).waitFor()
  await body.fill('另有未保存的草稿。')
  await page.locator('.sn-editor-toolbar [role=status]').filter({ hasText: /^Draft saved to disk$/ }).waitFor()
  await openManagement(page)
  const panel = page.locator('.sn-backups'); await panel.locator('summary').first().click()
  await panel.getByRole('button', { name: 'Back up now', exact: true }).click()
  await panel.getByText('Backup verified', { exact: true }).waitFor()
  await panel.locator('.sn-reference-list button').first().click()
  await panel.getByText('Verified backup preview', { exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Restore new copy', exact: true }).click()
  await panel.getByText(/^Restored root/).waitFor()
  const roots = await readdir(join(output, 'workspace', '.super-novel', 'restored'))
  assert.equal(roots.length, 1)
  const bookId = await page.getByLabel('Book', { exact: true }).inputValue()
  const root = join(output, 'workspace', '.super-novel', 'restored', roots[0])
  const manifest = JSON.parse(await readFile(join(root, 'novels', bookId, 'project.json'), 'utf8'))
  assert.equal(await readFile(join(root, 'novels', bookId, 'chapters', `${manifest.chapters[0].chapterId}.md`), 'utf8'), '正文保存稿。')
  assert((await readdir(join(root, 'novels', bookId, 'drafts'))).length > 0)
  const alternate = join(output, 'workspace', 'backup-other'); await mkdir(alternate)
  await panel.getByLabel('Backup root', { exact: true }).fill(alternate)
  await panel.getByRole('button', { name: 'Save backup location', exact: true }).click()
  await panel.getByText('No verified backup yet', { exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Back up now', exact: true }).click()
  await panel.getByText('Backup verified', { exact: true }).waitFor()
  assert((await readdir(join(alternate, '.super-novel-backups', bookId))).some(name => name.endsWith('.tar.gz')))
  await showContent(page); assert.equal(await body.inputValue(), '另有未保存的草稿。')
  await writeFile(join(output, 'backup-validation.json'), JSON.stringify({ result: 'PASS', verified: true, restoredNewRoot: true, draftRetained: true, changedBackupRoot: true }, null, 2))
  console.log('PASS complete backup: verified archive, new-root restore, original draft retained and configurable folder.')
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await withWorkspace(resolve(process.argv[2]), page => checkBackups(page, resolve(process.argv[2])))
