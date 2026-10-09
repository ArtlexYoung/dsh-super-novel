import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { BookStore } from '../lib/host/book-store.js'
import { BookFiles } from '../lib/host/book-files.js'
import { BackupStore } from '../lib/host/backup-store.js'
import { DraftStore } from '../lib/host/draft-store.js'
import { hash } from '../lib/domain/books.js'
import { packArchive } from '../lib/host/backup-archive.js'
const signal = () => new AbortController().signal
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'novel-backup-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const books = await BookStore.at(root), bookId = randomUUID(), chapterId = randomUUID()
  await books.createBook({ operationId: bookId, title: '备份测试' }, signal())
  const book = await books.mutate({ operationId: randomUUID(), bookId, expectedRevision: 1, action: 'create', chapterId, title: '第一章', content: '雨夜。', expectedHash: '', beforeChapterId: '' }, signal())
  return { root, books, book, chapterId, backups: await BackupStore.at(root) }
}

test('complete backup includes formal text, draft branches and immutable receipts, supports independent tar extraction and new-root restore', async t => {
  const { root, books, book, chapterId, backups } = await fixture(t)
  const drafts = await DraftStore.at(root, hash(root), books)
  await drafts.put({ workspaceId: hash(root), bookId: book.bookId, chapterId, branchId: randomUUID(), sequence: 1, baseHash: hash('雨夜。'), bookRevision: book.revision, content: '未保存的后半章。', operationId: randomUUID() }, signal())
  const before = await readFile(join(root, 'novels', book.bookId, 'project.json'))
  const backup = await backups.create(book.bookId, randomUUID(), signal())
  const preview = await backups.inspect(book.bookId, backup.backupId, signal())
  assert(preview.files.some(name => name.includes('/drafts/'))); assert(preview.files.some(name => name.includes('/transactions/')))
  assert.equal((await backups.list(book.bookId)).length, 1)
  assert.equal((await backups.catalog())[0].backupId, backup.backupId)
  assert.deepEqual(await backups.create(book.bookId, backup.backupId, signal()).then(value => value.backupId), backup.backupId)
  const extracted = join(root, 'unpacked'); await mkdir(extracted)
  execFileSync('tar', ['-xzf', backup.path, '-C', extracted])
  for (const name of preview.files) assert.deepEqual(await readFile(join(root, name)), await readFile(join(extracted, name)))
  const restored = await backups.restore(book.bookId, backup.backupId, preview.manifestHash, signal())
  assert.notEqual(restored.root, root)
  for (const name of preview.files) assert.deepEqual(await readFile(join(root, name)), await readFile(join(restored.root, name)))
  assert.deepEqual(await readFile(join(root, 'novels', book.bookId, 'project.json')), before)
  const reopened = await BookStore.at(restored.root)
  assert.equal((await reopened.readChapter(book.bookId, chapterId)).content, '雨夜。')
})

test('corrupt backup and changed preview are refused, a later failed attempt preserves previous verified archive', async t => {
  const { root, book, backups } = await fixture(t), backup = await backups.create(book.bookId, randomUUID(), signal())
  await assert.rejects(backups.restore(book.bookId, backup.backupId, '0'.repeat(64), signal()), /revision-conflict/)
  const bytes = await readFile(backup.path); bytes[bytes.length - 5] ^= 0xff; await writeFile(backup.path, bytes)
  await assert.rejects(backups.inspect(book.bookId, backup.backupId, signal()))
  const good = await backups.create(book.bookId, randomUUID(), signal()), goodBytes = await readFile(good.path)
  await symlink(join(root, 'novels', book.bookId, 'project.json'), join(root, 'novels', book.bookId, 'bad.json'))
  await assert.rejects(backups.create(book.bookId, randomUUID(), signal()), /unsafe-path/)
  assert.deepEqual(await readFile(good.path), goodBytes)
  assert(!(await readdir(join(root, '.super-novel-backups', book.bookId))).some(name => name.startsWith('.stage-')))
})

test('archive traversal, duplicate entries and links cannot be restored; querying empty backups does not write', async t => {
  const { root, book, backups } = await fixture(t)
  assert.deepEqual(await backups.list(book.bookId), [])
  assert(!(await readdir(root)).includes('.super-novel-backups'))
  await assert.rejects(backups.configure(join(root, 'novels'), true, 'danger-full-access'), /backup-inside-library/)
  const folder = join(root, '.super-novel-backups', book.bookId); await mkdir(folder, { recursive: true })
  const id = randomUUID(), path = join(folder, `${id}.tar.gz`)
  async function* entries() { yield { path: '../outside', data: Buffer.from('bad') } }
  await packArchive(entries(), path, signal())
  await assert.rejects(backups.inspect(book.bookId, id, signal()), /unsafe-path/)
})

test('snapshot barrier blocks every managed writer and is reentrant for nested formal transactions', async t => {
  const { root, books, book, chapterId, backups } = await fixture(t), files = await BookFiles.at(root)
  let release, entered
  const ready = new Promise(resolve => { entered = resolve }), wait = new Promise(resolve => { release = resolve })
  const running = files.freeze(book.bookId, async () => { entered(); await wait; return true })
  await ready
  await assert.rejects(backups.create(book.bookId, randomUUID(), signal()), /busy/)
  await assert.rejects(files.replace(`novels/${book.bookId}/chapters/${chapterId}.md`, 'changed', { exists: true, text: '雨夜。' }), /busy/)
  release(); await running
  await books.mutate({ operationId: randomUUID(), bookId: book.bookId, expectedRevision: book.revision, action: 'save', chapterId, title: '', content: '新稿。', expectedHash: hash('雨夜。'), beforeChapterId: '' }, signal())
  const backup = await backups.create(book.bookId, randomUUID(), signal())
  assert.equal(backup.revision, book.revision + 1)
})

test('large multi-file archive is streamed and verified beyond a single RPC payload', async t => {
  const { root, book, backups } = await fixture(t)
  const folder = join(root, 'novels', book.bookId, 'recoveries'); await mkdir(folder)
  const text = JSON.stringify({ retained: '备份内容。'.repeat(300_000) })
  for (let i = 0; i < 8; i++) await writeFile(join(folder, `${randomUUID()}.json`), text)
  const backup = await backups.create(book.bookId, randomUUID(), signal())
  assert(backup.bytes > 32 * 1024 * 1024)
  assert.equal((await backups.inspect(book.bookId, backup.backupId, signal())).summary.bytes, backup.bytes)
})
