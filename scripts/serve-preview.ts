/** Start only the task-owned preview profile; keep its session URL out of logs. */
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const output = resolve(process.argv[2] ?? '.test-output/preview-v003')
const child = spawn(process.execPath, [resolve('../deepseek-harness/apps/cli/lib/bin.js'), '--profile', 'web', '--no-open', '--port', '0'], {
  env: { ...process.env, DSH_HOME: resolve(output, 'home'), DSH_AGENTS_HOME: resolve(output, 'agents') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let buffer = ''
child.stdout.on('data', async chunk => {
  buffer += chunk.toString()
  const match = buffer.match(/dsh web: (http:\/\/[^\s]+)/)
  if (match) {
    await writeFile(resolve(output, 'preview-url'), match[1], { mode: 0o600 })
    console.log('Isolated packed-plugin Web preview ready; authenticated URL stored in ignored task directory.')
    buffer = ''
  }
})
child.stderr.on('data', chunk => process.stderr.write(chunk.toString().replace(/([?&]token=)[^\s&]+/g, '$1[redacted]')))
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
child.on('exit', code => { process.exitCode = code ?? 0 })
