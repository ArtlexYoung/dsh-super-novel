import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { discoverPresets } from '@deepseek-ai/dsh-agent-presets'
import { PresetInstaller, PRESET_ID } from '../lib/host/preset-install.js'
const source = resolve('presets/dsh-super-novel')
const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const anchor = pathToFileURL(resolve('package.json')).href
async function fixture(t) {
  await mkdir('.test-output', { recursive: true })
  const dir = await mkdtemp(resolve('.test-output/install-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'presets')
  const roots = [{ path: root, trust: 'user' }]
  const host = { roots, list: () => discoverPresets(roots, anchor) }
  return { dir, root, host, installer: new PresetInstaller(host, source, version) }
}
const signal = () => new AbortController().signal

test('view is read-only; enable is discoverable, idempotent and preserves siblings', async t => {
  const f = await fixture(t)
  assert.equal((await f.installer.status()).state, 'available')
  assert.deepEqual(await readdir(f.dir), [])
  await mkdir(join(f.root, 'another-mode'), { recursive: true })
  await writeFile(join(f.root, 'another-mode/agent.cordis.yml'), '[]\n')
  assert.equal((await f.installer.enable(signal())).state, 'enabled')
  const bytes = await readFile(join(f.root, PRESET_ID, 'agent.cordis.yml'))
  assert.equal((await f.installer.enable(signal())).state, 'enabled')
  assert.deepEqual(await readFile(join(f.root, PRESET_ID, 'agent.cordis.yml')), bytes)
  assert.deepEqual((await f.host.list()).map(x => x.id).sort(), ['another-mode', PRESET_ID].sort())
})

test('unowned, modified, extra-file and different-version directories are never overwritten', async t => {
  const f = await fixture(t)
  const target = join(f.root, PRESET_ID)
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'author.txt'), 'keep me')
  assert.equal((await f.installer.enable(signal())).reason, 'unowned-directory')
  assert.equal(await readFile(join(target, 'author.txt'), 'utf8'), 'keep me')
  await rm(target, { recursive: true })
  await f.installer.enable(signal())
  const newer = new PresetInstaller(f.host, source, '0.2.0')
  assert.equal((await newer.enable(signal())).reason, 'different-version-or-owner')
  await writeFile(join(target, 'agent.cordis.yml'), 'author edit\n')
  assert.equal((await f.installer.enable(signal())).reason, 'modified-preset')
  assert.equal(await readFile(join(target, 'agent.cordis.yml'), 'utf8'), 'author edit\n')
  await writeFile(join(target, 'notes.md'), 'my notes')
  assert.equal((await f.installer.enable(signal())).reason, 'extra-files')
})

test('a missing composition resumes from an owned complete prefix', async t => {
  const f = await fixture(t)
  await f.installer.enable(signal())
  await rm(join(f.root, PRESET_ID, 'agent.cordis.yml'))
  assert.equal((await f.installer.status()).state, 'incomplete')
  assert.equal((await f.installer.enable(signal())).state, 'enabled')
})

test('symlink roots, target directories and files are rejected', async t => {
  const f = await fixture(t)
  const outside = join(f.dir, 'outside')
  await mkdir(outside)
  try { await symlink(outside, f.root, 'dir') }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows symlink privilege unavailable'); return }; throw error }
  assert.equal((await f.installer.enable(signal())).reason, 'unsafe-root')
  await rm(f.root)
  await mkdir(f.root)
  await symlink(outside, join(f.root, PRESET_ID), 'dir')
  assert.equal((await f.installer.enable(signal())).reason, 'unsafe-target')
  await rm(join(f.root, PRESET_ID))
  await f.installer.enable(signal())
  await rm(join(f.root, PRESET_ID, 'preset.yml'))
  const sentinel = join(outside, 'sentinel')
  await writeFile(sentinel, 'preserve')
  await symlink(sentinel, join(f.root, PRESET_ID, 'preset.yml'))
  assert.equal((await f.installer.enable(signal())).reason, 'unsafe-file')
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve')
})

test('concurrent instances settle without overwriting, stale lock is never stolen', async t => {
  const f = await fixture(t)
  const other = new PresetInstaller(f.host, source, version)
  const values = await Promise.all([f.installer.enable(signal()), other.enable(signal())])
  assert(values.some(value => value.state === 'enabled'))
  assert(values.every(value => ['busy', 'enabled'].includes(value.state)))
  assert.equal((await f.installer.status()).state, 'enabled')
  await mkdir(join(f.root, '.dsh-super-novel.lock'))
  assert.equal((await f.installer.enable(signal())).state, 'busy')
  assert((await readdir(f.root)).includes('.dsh-super-novel.lock'))
})

test('abort, read-only deployments, and shadowed identities cannot create a preset', async t => {
  const f = await fixture(t)
  await assert.rejects(f.installer.enable(AbortSignal.abort()), { name: 'AbortError' })
  assert.deepEqual(await readdir(f.dir), [])
  const readonly = new PresetInstaller({ roots: [], list: async () => [] }, source, version)
  assert.equal((await readonly.enable(signal())).state, 'unavailable')
  const shadowed = new PresetInstaller({ roots: f.host.roots, list: async () => [{ id: PRESET_ID, path: '/different/agent.cordis.yml' }] }, source, version)
  assert.equal((await shadowed.enable(signal())).reason, 'shadowed-id')
  assert.deepEqual(await readdir(f.dir), [])
})

test('tilde roots match host discovery; relative roots and truncated files are explicit failures', async t => {
  const f = await fixture(t)
  const { homedir } = await import('node:os')
  const { relative } = await import('node:path')
  const roots = [{ path: `~/${relative(homedir(), f.root)}`, trust: 'user' }]
  const installer = new PresetInstaller({ roots, list: () => discoverPresets(roots, anchor) }, source, version)
  assert.equal((await installer.enable(signal())).state, 'enabled')
  await writeFile(join(f.root, PRESET_ID, 'preset.yml'), 'name: par')
  assert.equal((await installer.enable(signal())).reason, 'modified-preset')
  const ambiguous = new PresetInstaller({ roots: [{ path: './presets', trust: 'user' }], list: async () => [] }, source, version)
  assert.equal((await ambiguous.enable(signal())).reason, 'relative-user-root')
})

test('an unwritable root fails without leaving a lock or deleting existing data', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'POSIX permission enforcement unavailable' : false }, async t => {
  const f = await fixture(t)
  const { chmod } = await import('node:fs/promises')
  await mkdir(f.root)
  await writeFile(join(f.root, 'sentinel.txt'), 'keep')
  await chmod(f.root, 0o500)
  try {
    await assert.rejects(f.installer.enable(signal()), error => ['EACCES', 'EPERM'].includes(error.code))
    assert.deepEqual(await readdir(f.root), ['sentinel.txt'])
    assert.equal(await readFile(join(f.root, 'sentinel.txt'), 'utf8'), 'keep')
  } finally { await chmod(f.root, 0o700) }
})
