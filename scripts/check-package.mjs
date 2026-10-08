/** Check the actual npm inventory, not only the package's files allowlist. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const npmArgs = ['pack', '--dry-run', '--json', '--ignore-scripts']
const [pack] = JSON.parse(process.env.npm_execpath
  ? execFileSync(process.execPath, [process.env.npm_execpath, ...npmArgs], { cwd: root, encoding: 'utf8' })
  : execFileSync('npm', npmArgs, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' }))
assert.equal(pack.version, manifest.version)
const names = new Set(pack.files.map(file => file.path))
for (const name of names) {
  assert(!/(^|\/)(?:PLAN|MEMORY|TASKS|AGENTS|CLAUDE|SPEC|SPECS|DESIGN|IMPLEMENTATION|RESEARCH)\.md$|(^|\/)(?:\.githooks|\.development|eval|\.test-output|\.build|node_modules|plans|specs)\/|(^|\/)\.env(?:\.|$)|\.env$|\.pem$|\.key$/.test(name), `Forbidden package file: ${name}`)
  assert(!name.startsWith('/') && !name.split('/').includes('..'), `Unsafe package path: ${name}`)
}
const exportPaths = value => typeof value === 'string' ? [value] : Object.values(value).flatMap(exportPaths)
for (const name of [manifest.main, manifest.types, manifest.dsh.bundle.patch, 'lib/client.js', 'LICENSE', 'README.md', 'scripts/doctor.mjs', 'screenshots.json', 'presets/dsh-super-novel/preset.yml', 'presets/dsh-super-novel/agent.cordis.yml', ...exportPaths(manifest.exports)]) {
  assert(names.has(name.replace(/^\.\//, '')), `Missing package entry: ${name}`)
}
const screenshots = JSON.parse(await readFile(join(root, 'screenshots.json'), 'utf8'))
assert(Array.isArray(screenshots) && screenshots.length >= 1 && screenshots.length <= 8)
assert.equal(new Set(screenshots).size, screenshots.length)
for (const path of screenshots) {
  assert(typeof path === 'string' && !path.startsWith('/') && !path.includes('..') && /\.(png|jpe?g|webp)$/.test(path))
  assert(names.has(path), `Missing screenshot: ${path}`)
  const bytes = await readFile(join(root, path))
  assert(bytes.length > 100, `Empty screenshot: ${path}`)
}
console.log(`PASS package ${manifest.version}: ${names.size} files, exports, bundle, diagnostics and ${screenshots.length} screenshots; no local materials.`)
