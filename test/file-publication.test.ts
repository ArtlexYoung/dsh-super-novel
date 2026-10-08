import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { syncDirectory, publishFile } from '../lib/host/file-publication.js'
const failure = code => Object.assign(new Error(code), { code })

test('directory sync closes on success and failure; Windows does not attempt unsupported directory open', async () => {
  let syncs = 0, closes = 0
  const handle = { sync: async () => { syncs++ }, close: async () => { closes++ } }
  await syncDirectory('directory', 'linux', async () => handle)
  assert.equal(syncs, 1); assert.equal(closes, 1)
  await assert.rejects(syncDirectory('directory', 'darwin', async () => ({ ...handle, sync: async () => { throw failure('ENOSPC') } })), { code: 'ENOSPC' })
  assert.equal(closes, 2)
  await syncDirectory('directory', 'win32', async () => { throw new Error('must not open') })
  await assert.rejects(syncDirectory('directory', 'linux', async () => { throw failure('EACCES') }), { code: 'EACCES' })
})

test('transient Windows replacement failures retry within bounds; all other failures propagate immediately', async () => {
  const delays = [], errors = ['EACCES', 'EBUSY', 'EPERM']; let attempts = 0
  await publishFile(async () => { if (attempts++ < errors.length) throw failure(errors[attempts - 1]) }, 'win32', async ms => { delays.push(ms) })
  assert.equal(attempts, 4); assert.deepEqual(delays, [20, 40, 80])
  attempts = 0; delays.length = 0
  await assert.rejects(publishFile(async () => { attempts++; throw failure('EPERM') }, 'win32', async ms => { delays.push(ms) }), { code: 'EPERM' })
  assert.equal(attempts, 9); assert.equal(delays.length, 8); assert(delays.every(ms => ms <= 200))
  for (const [platform, code] of [['linux', 'EPERM'], ['darwin', 'EBUSY'], ['win32', 'ENOSPC'], ['win32', 'revision-conflict']]) {
    await assert.rejects(publishFile(async () => { throw failure(code) }, platform, async () => { throw new Error('must not retry') }), { code })
  }
})

test('baseline is checked again after Windows interference and a new author edit is preserved', async t => {
  await mkdir('.test-output', { recursive: true })
  const root = await mkdtemp(resolve('.test-output/publication-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = join(root, 'chapter.md'), temp = join(root, 'candidate.tmp')
  await writeFile(target, '旧稿'); await writeFile(temp, '候选')
  let attempts = 0
  await assert.rejects(publishFile(async () => {
    if (await readFile(target, 'utf8') !== '旧稿') throw failure('revision-conflict')
    if (++attempts === 1) throw failure('EBUSY')
    await rename(temp, target)
  }, 'win32', async () => { await writeFile(target, '作者新稿') }), { code: 'revision-conflict' })
  assert.equal(attempts, 1); assert.equal(await readFile(target, 'utf8'), '作者新稿'); assert.equal(await readFile(temp, 'utf8'), '候选')
})
