/** Generate official Typert artifacts in a task-owned workspace, then bundle the client. */
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'
import { build } from 'esbuild'
const root = resolve('.build/typert')
await rm(root, { recursive: true, force: true })
const pkg = join(root, 'packages/super-novel')
await mkdir(pkg, { recursive: true })
await cp('src', join(pkg, 'src'), { recursive: true })
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
await writeFile(join(pkg, 'package.json'), JSON.stringify(manifest, null, 2))
const config = JSON.parse(await readFile('tsconfig.host.json', 'utf8'))
// The generator recognizes Remote only when its owning protocol is registered.
// Use the installed package's real declarations, never handwritten decorator stubs.
const protocolDir = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-typert-protocol/package.json')))
const protocol = join(root, 'packages/protocol')
await mkdir(protocol, { recursive: true })
await cp(join(protocolDir, 'lib/types'), join(protocol, 'src'), { recursive: true })
await writeFile(join(protocol, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-typert-protocol', type: 'module', exports: { '.': { types: './src/index.d.ts', default: './src/index.js' } } }))
await writeFile(join(protocol, 'tsconfig.json'), JSON.stringify({ compilerOptions: { ...config.compilerOptions, noEmit: true }, include: ['src/**/*.d.ts'] }))
config.compilerOptions.paths = { '@deepseek-ai/dsh-typert-protocol': [join(protocol, 'src/index.d.ts')] }
await writeFile(join(pkg, 'tsconfig.host.json'), JSON.stringify(config))
await writeFile(join(root, 'tsconfig.host.json'), JSON.stringify({ compilerOptions: config.compilerOptions, files: [], references: [{ path: './packages/super-novel/tsconfig.host.json' }, { path: './packages/protocol/tsconfig.json' }] }))
const artifacts = new WorkspaceTypertGenerator(root).generate(['dsh-super-novel'], ['host'])
if (artifacts.length !== 1 || !artifacts[0].remote) throw new Error('Expected one Host artifact with a strict Remote contribution')
const artifact = artifacts[0]
await writeFile('lib/typert.host.js', artifact.js)
await writeFile('lib/typert.host.d.ts', artifact.dts.replace(/^\/\/# sourceMappingURL=.*$/gm, ''))
await writeFile('lib/typert.remote-client.js', artifact.remote.js)
await writeFile('lib/typert.remote-client.d.ts', artifact.remote.dts.replace(/^\/\/# sourceMappingURL=.*$/gm, ''))
await build({
  entryPoints: ['src/client/index.tsx'], outfile: 'lib/client.js', bundle: true,
  format: 'cjs', platform: 'browser', target: 'es2022', external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
  banner: { js: `;(globalThis.window || globalThis).__ModuleLoader__.load({ id: 'dsh-super-novel', factory: (require) => { const exports = {}; const module = { exports };` },
  footer: { js: 'return module.exports; } });' },
})
console.error('Built Host, generated strict Typert/Remote, and browser closure artifact.')
