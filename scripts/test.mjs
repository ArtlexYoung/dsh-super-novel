/** Pass explicit test paths; Windows shells do not expand the POSIX wildcard. */
import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
const files = (await readdir('test')).filter(name => name.endsWith('.test.ts')).sort().map(name => `test/${name}`)
if (!files.length) throw new Error('No test files found')
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...files], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
