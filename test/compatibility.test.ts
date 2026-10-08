import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { satisfies } from 'semver'
import { createPresetSetup } from '../lib/host/preset-setup.js'
import { TYPERT } from '../lib/typert.host.js'
import { TYPERT_REMOTE } from '../lib/typert.remote-client.js'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'

test('client icons use public exports in old and new DSH without replacing its controls', async () => {
  const result = await build({ entryPoints: ['src/client/primitives.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', '@deepseek-ai/dsh-client-ui-primitives'] })
  const names = ['Plus', 'Edit', 'Refresh', 'Check', 'Close', 'Search', 'ChevronUp', 'ChevronDown', 'ChevronLeft', 'ChevronRight']
  for (const modern of [false, true]) {
    const primitives = { Button: () => {}, Input: () => {}, Tag: () => {} }
    for (const name of names) {
      const size = name.startsWith('Chevron') ? 14 : 16
      primitives[`Icon${name}Outline${modern ? 'Regular' : size}`] = () => {}
    }
    primitives[`IconSparkle${modern ? 'Regular' : 16}`] = () => {}
    const module = { exports: {} }
    runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? { createElement: (type, props) => ({ type, props }) } : primitives })
    for (const name of ['Button', 'Input', 'Tag']) assert.equal(module.exports[name], primitives[name])
    const icons = Object.entries(module.exports).filter(([name]) => name.startsWith('Icon'))
    assert.equal(icons.length, 11)
    for (const [name, component] of icons) {
      const rendered = component({ className: 'host-icon' })
      assert.equal(typeof rendered.type, 'function')
      assert.equal(rendered.props.size, name.endsWith('14') ? 14 : 16)
      assert.equal(rendered.props.className, 'host-icon')
    }
  }
})

test('Host and browser codecs preserve strict validation across both RPC contracts', () => {
  const host = TYPERT.invocations, remote = TYPERT_REMOTE.descriptors
  assert.equal(host.length, remote.length)
  for (const descriptors of [host, remote]) {
    for (const descriptor of descriptors) {
      for (const codec of [...descriptor.parameters.map(parameter => parameter.codec), descriptor.result]) {
        assert.equal(codec.mode, 'strict')
        assert.equal(codec.create(), codec.schema)
        assert.throws(() => codec.create().parse(Symbol('invalid wire value')))
      }
    }
  }
  const save = host.find(item => item.method === 'changeChapter').parameters[1].codec
  assert.throws(() => save.create().parse({ bookId: 'incomplete request' }))
  const status = host.find(item => item.method === 'status').result
  assert.deepEqual(status.create().parse({ state: 'enabled', reason: 'ready' }), { state: 'enabled', reason: 'ready' })
})

test('preset registry owns one scoped definition, leaves the default intact and releases it on unload', async t => {
  const ctx = new Context(), rows = [], definitions = []
  t.after(() => ctx.fiber.dispose())
  let disposals = 0
  const registry = {
    defaultId: 'author-mode', list: async () => rows,
    async register(definition) {
      definitions.push(definition); rows.push({ id: definition.id })
      return async () => { disposals++; rows.length = 0 }
    },
  }
  const setup = createPresetSetup(ctx, registry, '/unused', 'test')
  assert.equal((await setup.status()).state, 'enabled')
  assert.equal((await setup.enable(new AbortController().signal)).state, 'enabled')
  assert.equal(definitions.length, 1)
  assert.deepEqual(definitions[0].plugins, [{ id: 'super-novel-persona', name: 'dsh-super-novel/preset' }])
  assert.equal(registry.defaultId, 'author-mode')
  rows[0].broken = 'Scoped row unavailable'
  assert.equal((await setup.status()).state, 'unavailable')
  await assert.rejects(setup.enable(AbortSignal.abort()), { name: 'AbortError' })
  await ctx.fiber.dispose()
  assert.equal(disposals, 1)
  assert.deepEqual(rows, [])
})

test('preset registration failures remain visible and unsupported Hosts fail explicitly', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const setup = createPresetSetup(ctx, { list: async () => [], register: async () => { throw new Error('Duplicate agent preset') } }, '/unused', 'test')
  await assert.rejects(setup.status(), /Duplicate agent preset/)
  assert.throws(() => createPresetSetup(ctx, {}, '/unused', 'test'), /Unsupported Host/)
})

test('DSH peer declarations support both maintained lines and reject unknown major/minor contracts', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  for (const [name, range] of Object.entries(manifest.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))) {
    for (const version of ['0.1.5-rc.2', '0.1.5-rc.3', '0.1.5', '0.2.0-rc.2', '0.2.0', '0.2.1']) assert(satisfies(version, range, { includePrerelease: true }), `${name}: ${version}`)
    for (const version of ['0.1.4', '0.2.0-rc.1', '0.3.0-rc.1', '1.0.0']) assert(!satisfies(version, range, { includePrerelease: true }), `${name}: ${version}`)
  }
})
