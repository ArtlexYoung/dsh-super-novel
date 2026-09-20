/** Pack into a fresh, task-owned profile. Refuse to replace an existing fixture. */
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
await mkdir('.test-output', { recursive: true })
await mkdir('.test-output/web-home')
const profile = resolve('.test-output/web-home/profiles/web')
const target = resolve(profile, 'node_modules/dsh-super-novel')
await mkdir(target, { recursive: true })
await mkdir('.build', { recursive: true })
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', '.build'], { encoding: 'utf8' }))
execFileSync('tar', ['-xzf', resolve('.build', pack.filename), '--strip-components=1', '-C', target])
await writeFile(resolve(profile, 'package.json'), JSON.stringify({
  name: 'super-novel-p0-profile', private: true, dependencies: { 'dsh-super-novel': pack.version },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-super-novel'] } },
}, null, 2) + '\n')
await writeFile(resolve(profile, 'cordis.patch.yml'), `- insert:\n    - id: super-novel-preview-fixture\n      name: ${JSON.stringify(resolve('scripts/preview-fixture.mjs'))}\n`)
console.log('Packed plugin extracted into a fresh isolated profile. Run node scripts/serve-preview.mjs next.')
