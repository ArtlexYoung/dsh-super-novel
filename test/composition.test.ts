import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { createRequire } from 'node:module'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
const require = createRequire(import.meta.resolve('@deepseek-ai/cordis-plugin-include'))
const yaml = require('js-yaml')

test('bundle preserves custom roots, discovery flags and the author default', async () => {
  const own = yaml.load(await readFile('cordis.patch.yml', 'utf8'), { schema: entryListSchema })
  const config = { default: 'author-mode', roots: [{ path: '/author/presets', trust: 'user' }], includeShippedRoot: false, includeUserRoot: false }
  const original = structuredClone(config)
  const rows = applyEntryPatches([{ id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets', config }], own, message => assert.fail(message))
  assert.deepEqual(rows.find(row => row.id === 'agent-presets').config, original)
  assert.deepEqual(config, original)
  assert.equal(rows.filter(row => row.id === 'dsh-super-novel').length, 1)
})

test('bundle composes in both orders without replacing the super-code preset config', async () => {
  const own = yaml.load(await readFile('cordis.patch.yml', 'utf8'), { schema: entryListSchema })
  const code = yaml.load(await readFile('../dsh-super-code/cordis.patch.yml', 'utf8'), { schema: entryListSchema })
  const baseline = [{ id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets', config: { default: 'standard' } }]
  const expected = applyEntryPatches(structuredClone(baseline), code, message => assert.fail(message)).find(x => x.id === 'agent-presets').config
  for (const patches of [[...code, ...own], [...own, ...code]]) {
    const rows = applyEntryPatches(structuredClone(baseline), patches, message => assert.fail(message))
    assert.deepEqual(rows.find(x => x.id === 'agent-presets').config, expected)
    assert.equal(rows.filter(x => x.id === 'dsh-super-novel').length, 1)
  }
})

test('real Loader discovers host RPC and mounts the writing persona only in its Agent scope', async t => {
  await mkdir('.test-output', { recursive: true })
  const dir = await mkdtemp(resolve('.test-output/loader-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'presets')
  await mkdir(join(root, 'standard'), { recursive: true })
  await writeFile(join(root, 'standard/agent.cordis.yml'), '[]\n')
  const rows = [
    { name: '@deepseek-ai/dsh-llm' },
    { name: '@deepseek-ai/dsh-session' },
    { name: '@deepseek-ai/dsh-session-projection' },
    { name: '@deepseek-ai/dsh-system-prompt', config: { personaPrefix: 'Original persona' } },
    { name: '@deepseek-ai/dsh-tools' },
    { name: '@deepseek-ai/dsh-agent' },
    { name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } },
    { name: '@deepseek-ai/dsh-typert-registry' },
    { name: '@deepseek-ai/dsh-typert-loader' },
    { id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets', config: { default: 'standard', roots: [{ path: root, trust: 'user' }], includeShippedRoot: false, includeUserRoot: false } },
  ]
  const file = join(dir, 'cordis.yml')
  await writeFile(file, yaml.dump(rows))
  const patches = yaml.load(await readFile('cordis.patch.yml', 'utf8'), { schema: entryListSchema })
  const ctx = await boot('super-novel-test', file, patches)
  t.after(() => ctx.fiber.dispose())
  assert.equal((await ctx.superNovel.status(new AbortController().signal)).state, 'available')
  assert.equal((await ctx.superNovel.enable(new AbortController().signal)).state, 'enabled')
  assert.equal(ctx.agentPresets.defaultId, 'standard')
  assert(ctx.typert.local.get('superNovel/status'))
  assert(ctx.typert.local.get('superNovel/enable'))
  for (const name of ['library', 'createBook', 'chapter', 'changeChapter', 'recoverBook', 'generateChapter', 'proposals', 'proposal', 'stopProposal', 'acceptProposal', 'rejectProposal', 'reviewChapter', 'chapterReviews', 'reviseIssue', 'voiceSamples', 'authorizeVoice', 'revokeVoice', 'previewImport', 'importBook', 'exportBook', 'generateFacts']) assert(ctx.typert.local.get(`superNovel/${name}`))
  const handle = await ctx.agents.create({ sessionId: SessionId('write-p0'), setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'dsh-super-novel') } })
  t.after(() => handle.dispose())
  const writing = await ctx.systemPrompt.assemble(assembleContextFor(handle.agent))
  const global = await ctx.systemPrompt.assemble({})
  assert(JSON.stringify(writing).includes('人物动机'))
  assert(!JSON.stringify(global).includes('人物动机'))
  assert.equal((await ctx.agentPresets.list()).find(row => row.id === 'dsh-super-novel').broken, undefined)
})
