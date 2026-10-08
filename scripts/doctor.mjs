/** Read-only installation diagnostics; never reads credentials or contacts a model. */
import { readFile, access, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  try {
    const installed = await installedPackage(name), actual = installed.version
    let compatible = actual === expected
    const lower = /^\^([1-9][0-9]*)\.([0-9]+)\.([0-9]+)$/.exec(expected)
    if (lower) {
      const tuple = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(actual)
      compatible = !!tuple && tuple[1] === lower[1] && (Number(tuple[2]) > Number(lower[2]) || Number(tuple[2]) === Number(lower[2]) && Number(tuple[3]) >= Number(lower[3]))
    }
    check(compatible, `${name}: ${actual}; required ${expected}`)
    if (profileRequire && name in manifest.peerDependencies) {
      const host = await installedPackage(name, profileRequire)
      check(host.path === installed.path, `${name}: shares the profile Host instance`)
    }
  } catch { check(false, `${name}: missing or unreadable; required ${expected}`) }
}
console.log(`Installation diagnostics: ${failures.length} failure(s). Runtime services and model quality are not checked.`)
process.exitCode = failures.length ? 1 : 0
