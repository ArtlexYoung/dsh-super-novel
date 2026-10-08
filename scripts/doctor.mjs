/** Read-only installation diagnostics; never reads credentials or contacts a model. */
import { readFile, access, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { satisfies } from 'semver'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const require = createRequire(join(root, 'package.json'))
const profileManifest = await readFile(resolve('package.json'), 'utf8').then(text => JSON.parse(text), () => ({}))
const profileRequire = profileManifest.dsh?.profile ? createRequire(resolve('package.json')) : false
const failures = []
const check = (ok, message) => { console.log(`${ok ? 'OK' : 'FAIL'} ${message}`); if (!ok) failures.push(message) }
const version = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(process.versions.node)
check(!!version && (Number(version[1]) >= 24 || Number(version[1]) === 22 && Number(version[2]) >= 19), `Node ${process.versions.node}; required ${manifest.engines.node}`)
check(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'bundle patch declaration')
const artifacts = [manifest.main, manifest.types, 'lib/client.js', 'lib/typert.host.js', 'lib/typert.remote-client.js', 'cordis.patch.yml', 'presets/dsh-super-novel/agent.cordis.yml']
for (const path of artifacts) check(await access(join(root, path)).then(() => true, () => false), path)

async function installedPackage(name, resolver = require) {
  let path
  try { path = resolver.resolve(`${name}/package.json`) }
  catch {
    let directory = dirname(resolver.resolve(name))
    for (;;) {
      const candidate = join(directory, 'package.json')
      const value = await readFile(candidate, 'utf8').then(text => JSON.parse(text), () => ({}))
      if (value.name === name) { path = candidate; break }
      const parent = dirname(directory)
      if (parent === directory) throw new Error('Package manifest not found')
      directory = parent
    }
  }
  return { ...JSON.parse(await readFile(path, 'utf8')), path: await realpath(path) }
}

for (const [name, expected] of Object.entries({ ...manifest.peerDependencies, ...manifest.dependencies })) {
  let installed
  try { installed = await installedPackage(name) }
  catch {
    if (manifest.peerDependenciesMeta?.[name]?.optional) {
      console.log(`OK ${name}: optional Host alternative not installed`)
      continue
    }
    check(false, `${name}: missing or unreadable; required ${expected}`)
    continue
  }
  try {
    check(satisfies(installed.version, expected, { includePrerelease: true }), `${name}: ${installed.version}; required ${expected}`)
    if (profileRequire && name in manifest.peerDependencies) {
      const host = await installedPackage(name, profileRequire)
      check(host.path === installed.path, `${name}: shares the profile Host instance`)
    }
  } catch { check(false, `${name}: missing or unreadable; required ${expected}`) }
}
const presetAlternatives = ['@deepseek-ai/dsh-agent-presets', '@deepseek-ai/dsh-agent-preset-registry']
if (presetAlternatives.every(name => manifest.peerDependenciesMeta?.[name]?.optional)) {
  const available = await Promise.all(presetAlternatives.map(name => installedPackage(name).then(() => true, () => false)))
  check(available.some(Boolean), 'Host provides file-based presets or the preset registry')
}
console.log(`Installation diagnostics: ${failures.length} failure(s). Runtime services and model quality are not checked.`)
process.exitCode = failures.length ? 1 : 0
