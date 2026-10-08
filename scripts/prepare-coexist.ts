import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
const output = resolve(process.argv[2]), order = process.argv[3]
if (!['first', 'last'].includes(order)) throw new Error('Order must be first or last')
const profile = join(output, 'home/profiles/web'), target = join(profile, 'node_modules/dsh-super-code')
await mkdir(target)
execFileSync('tar', ['-xzf', resolve('.build/dsh-super-code-0.3.0-reflection.4.tgz'), '--strip-components=1', '-C', target])
const path = join(profile, 'package.json'), manifest = JSON.parse(await readFile(path, 'utf8'))
manifest.dependencies['dsh-super-code'] = '0.3.0-reflection.4'
manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...(order === 'first' ? ['dsh-super-code', 'dsh-super-novel'] : ['dsh-super-novel', 'dsh-super-code'])]
await writeFile(path, JSON.stringify(manifest, null, 2) + '\n')
const fixture = join(profile, 'cordis.patch.yml')
await writeFile(fixture, await readFile(fixture, 'utf8') + '        locale: en\n')
console.log(`Isolated packed-plugin coexistence profile prepared: super-code ${order}.`)
