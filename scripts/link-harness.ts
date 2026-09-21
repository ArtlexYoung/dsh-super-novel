/** Link existing built Harness packages for local development without changing them. */
import { readdir, readFile, mkdir, symlink, lstat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root = resolve(process.argv[2] ?? '../deepseek-harness')
const groups = await readdir(join(root, 'packages'), { withFileTypes: true })
const candidates = []
for (const group of groups.filter(entry => entry.isDirectory())) {
  for (const entry of await readdir(join(root, 'packages', group.name), { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(join(root, 'packages', group.name, entry.name))
  }
}
for (const entry of await readdir(join(root, 'vendor'), { withFileTypes: true })) {
  if (entry.isDirectory()) candidates.push(join(root, 'vendor', entry.name))
}
let count = 0
for (const dir of candidates) {
  let manifest
  try { manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') continue; throw error }
  if (!manifest.name?.startsWith('@deepseek-ai/')) continue
  const target = resolve('node_modules', manifest.name)
  await mkdir(resolve(target, '..'), { recursive: true })
  try { await lstat(target); continue }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await symlink(dir, target, 'dir')
  count++
}
console.log(`Linked ${count} Harness packages; existing dependencies were preserved.`)
// Preset discovery checks physical node_modules presence, including the package under test.
const self = resolve('node_modules/dsh-super-novel')
try { await lstat(self) }
catch (error) {
  if (error.code !== 'ENOENT') throw error
  await symlink(resolve('.'), self, 'dir')
}
