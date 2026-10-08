import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, cp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'

test('installation diagnostics are read-only and distinguish missing artifacts, dependencies and incompatible prereleases', async t => {
  await mkdir('.test-output', { recursive: true })
  const root = await mkdtemp(resolve('.test-output/doctor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'scripts')); await cp('scripts/doctor.mjs', join(root, 'scripts/doctor.mjs'))
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  manifest.peerDependencies = { 'doctor-fixture-peer': '0.1.5-rc.2' }; manifest.dependencies = { 'doctor-fixture-stable': '^4.6.5' }
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
  const run = () => spawnSync(process.execPath, [join(root, 'scripts/doctor.mjs')], { encoding: 'utf8' })
  const missing = run()
  assert.equal(missing.status, 1); assert.match(missing.stdout, /FAIL lib\/index.js/); assert.match(missing.stdout, /doctor-fixture-peer: missing/)
  for (const path of [manifest.main, manifest.types, 'lib/client.js', 'lib/typert.host.js', 'lib/typert.remote-client.js', 'cordis.patch.yml', 'presets/dsh-super-novel/agent.cordis.yml']) {
    await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), 'fixture')
  }
  for (const [name, version] of [['doctor-fixture-peer', '0.1.5-rc.3'], ['doctor-fixture-stable', '4.6.4']]) {
    await mkdir(join(root, 'node_modules', name), { recursive: true }); await writeFile(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }))
  }
  const incompatible = run()
  assert.equal(incompatible.status, 1); assert.match(incompatible.stdout, /doctor-fixture-peer: 0.1.5-rc.3; required 0.1.5-rc.2/); assert.match(incompatible.stdout, /FAIL doctor-fixture-stable/)
  for (const [name, version] of [['doctor-fixture-peer', '0.1.5-rc.2'], ['doctor-fixture-stable', '4.7.0']]) await writeFile(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }))
  const before = await readdir(root), bytes = await readFile(join(root, 'package.json'))
  const passed = run(); assert.equal(passed.status, 0); assert.match(passed.stdout, /0 failure/)
  assert.deepEqual(await readdir(root), before); assert.deepEqual(await readFile(join(root, 'package.json')), bytes)
})

test('profile diagnostics reject a separate peer instance even when both versions match', async t => {
  await mkdir('.test-output', { recursive: true })
  const root = await mkdtemp(resolve('.test-output/doctor-profile-')), plugin = join(root, 'node_modules', 'doctor-plugin')
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(plugin, 'scripts'), { recursive: true }); await cp('scripts/doctor.mjs', join(plugin, 'scripts/doctor.mjs'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['doctor-plugin'] } } }))
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ main: 'lib/index.js', types: 'lib/index.d.ts', engines: { node: '>=24.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } }, peerDependencies: { 'doctor-peer': '0.1.5-rc.2' }, dependencies: {} }))
  for (const path of ['lib/index.js', 'lib/index.d.ts', 'lib/client.js', 'lib/typert.host.js', 'lib/typert.remote-client.js', 'cordis.patch.yml', 'presets/dsh-super-novel/agent.cordis.yml']) {
    await mkdir(join(plugin, path, '..'), { recursive: true }); await writeFile(join(plugin, path), 'fixture')
  }
  const peer = join(root, 'node_modules', 'doctor-peer'), duplicate = join(plugin, 'node_modules', 'doctor-peer')
  for (const directory of [peer, duplicate]) {
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'doctor-peer', version: '0.1.5-rc.2' }))
  }
  const run = () => spawnSync(process.execPath, [join(plugin, 'scripts/doctor.mjs')], { cwd: root, encoding: 'utf8' })
  const failed = run(); assert.equal(failed.status, 1); assert.match(failed.stdout, /FAIL doctor-peer: shares the profile Host instance/)
  await rm(duplicate, { recursive: true })
  assert.equal(run().status, 0)
})
