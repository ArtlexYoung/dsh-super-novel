/** Bounded real-model prompt comparison through the actual Harness Agent/preset runtime. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { WRITING_GUIDANCE } from '../lib/preset/index.js'
import { measureOutput, measureEvents } from './live-eval-metrics.mjs'
const require = createRequire(import.meta.resolve('@deepseek-ai/cordis-plugin-include'))
const yaml = require('js-yaml')
const [action, inputDir = 'eval/live-p0-l1'] = process.argv.slice(2)
assert(['prepare', 'run'].includes(action), 'Usage: node scripts/live-eval.mjs prepare|run [eval/subdirectory]')
const dir = resolve(inputDir)
const child = relative(resolve('eval'), dir)
assert(child && !child.startsWith('..') && !isAbsolute(child), 'Output must be below ignored eval/')
const sha = value => createHash('sha256').update(value).digest('hex')
const casesText = await readFile(join(dir, 'cases.json'), 'utf8')
const cases = JSON.parse(casesText)
assert(cases.length === 3 && new Set(cases.map(x => x.id)).size === 3, 'Exactly three distinct cases required')
for (const item of cases) assert(/^[a-z-]+$/.test(item.id) && typeof item.prompt === 'string' && item.prompt.length > 0)
const baseline = '你是小说写作助手。根据作者提供的素材与要求完成写作任务。'
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const snapshot = {
  package: pkg.name, version: pkg.version,
  pluginCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  harnessCommit: execFileSync('git', ['-C', '../deepseek-harness', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  casesSha256: sha(casesText), guidanceSha256: sha(WRITING_GUIDANCE),
  presetSha256: sha(await readFile('presets/dsh-super-novel/agent.cordis.yml')),
  runnerSha256: sha(await readFile(import.meta.filename)),
  metricsSha256: sha(await readFile(new URL('./live-eval-metrics.mjs', import.meta.url))),
}
const plan = {
  schema: 1, mode: 'real-harness-prompt-comparison', ...snapshot,
  provider: 'tokenhub', endpoint: 'https://tokenhub.tencentmaas.com/plan/v3', model: 'deepseek-v4.1-flash',
  reasoningEffort: 'high', maxTokens: 6000, timeoutMs: 180000, maxRetries: 0, temperature: 'provider-default',
  baseline: { id: 'plain-writing', prompt: baseline, mountedPreset: false },
  candidate: { id: 'dsh-super-novel', mountedPreset: true },
  order: cases.flatMap((item, index) => (index % 2 ? ['dsh-super-novel', 'plain-writing'] : ['plain-writing', 'dsh-super-novel']).map(preset => ({ caseId: item.id, preset }))),
  evaluation: 'Frozen mechanical constraints plus evidence-based qualitative review; no blind preference or release claim.',
  maxTaskRequests: 6, healthRequests: 1, actualCost: 'unknown-no-billing-data',
}
if (action === 'prepare') {
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...plan, frozenAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log('Frozen manifest; no model request made.')
} else {
  const frozen = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  const { frozenAt, ...parameters } = frozen
  assert.deepEqual(parameters, plan, 'Manifest drift; prepare a new evaluation directory')
  assert(process.env.DSH_MODEL_API_KEY, 'DSH_MODEL_API_KEY is required')
  await writeFile(join(dir, 'run-started.json'), JSON.stringify({ startedAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 })
  await run(plan)
}

async function run(plan) {
  // Redact credential values before persisting exception or provider-derived event text.
  const secrets = Object.entries(process.env).filter(([name, value]) => /KEY|TOKEN|SECRET|PASSWORD/.test(name) && value?.length > 8).map(([, value]) => value)
  const safe = value => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), JSON.stringify(value, null, 2))
  const save = async (file, value) => { await writeFile(join(dir, file), safe(value) + '\n', { mode: 0o600 }) }
  let health
  try {
    const response = await fetch(`${plan.endpoint}/responses`, {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${process.env.DSH_MODEL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: plan.model, reasoning: { effort: plan.reasoningEffort }, max_output_tokens: plan.maxTokens, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with OK.' }] }] }),
    })
    const body = await response.json()
    health = { ok: response.ok && body.status === 'completed', httpStatus: response.status, status: body.status ?? 'unknown', usage: body.usage ?? { status: 'unreported' } }
  } catch (error) { health = { ok: false, errorKind: error.name } }
  await save('health.json', health)
  console.log(JSON.stringify({ stage: 'health', ...health }))
  if (!health.ok) { process.exitCode = 1; return }
  const home = join(dir, 'home')
  await mkdir(home, { recursive: true })
  process.env.DSH_HOME = home
  process.env.DSH_AGENTS_HOME = join(dir, 'agents')
  const rows = [
    { name: '@deepseek-ai/dsh-llm' },
    { name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { tokenhub: {
      api: 'openai-responses', baseURL: plan.endpoint, apiKeyEnv: 'DSH_MODEL_API_KEY', timeoutMs: plan.timeoutMs,
      retryPolicy: { mode: 'normal', maxRetries: 0 },
      models: [{ id: plan.model, contextWindow: 1000000, maxTokens: 384000, reasoningEfforts: { high: 'high' } }],
    } } } },
    { name: '@deepseek-ai/dsh-session' }, { name: '@deepseek-ai/dsh-session-projection' },
    { name: '@deepseek-ai/dsh-system-prompt' }, { name: '@deepseek-ai/dsh-tools' },
    { name: '@deepseek-ai/dsh-agent' }, { name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } },
    { name: '@deepseek-ai/dsh-agent-presets', config: { default: 'dsh-super-novel', roots: [{ path: resolve('presets'), trust: 'system' }], includeShippedRoot: false, includeUserRoot: false } },
  ]
  const config = join(dir, 'cordis.yml')
  await writeFile(config, yaml.dump(rows), { mode: 0o600 })
  const ctx = await boot('super-novel-live-eval', config, [])
  const results = []
  try {
    for (const task of plan.order) {
      const item = cases.find(item => item.id === task.caseId)
      const id = `${item.id}-${task.preset}`
      const started = performance.now()
      let handle, timer
      try {
        handle = await ctx.agentLoop.createAgent(ctx, {
          sessionId: SessionId(id), agentOptions: { provider: plan.provider, model: plan.model, reasoningEffort: ReasoningEffortId(plan.reasoningEffort), maxTokens: plan.maxTokens },
          setup: async agentCtx => {
            if (task.preset === 'dsh-super-novel') await ctx.agentPresets.mount(agentCtx, task.preset)
            else agentCtx.effect(() => agentCtx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, order: 0, text: baseline }))
          },
        })
        assert.equal(ctx.tools.schemas(handle.agent).length, 0)
        const prompt = await ctx.systemPrompt.assemble(assembleContextFor(handle.agent))
        await save(`${id}.context.json`, prompt)
        assert(!(await ctx.systemPrompt.assemble({})).sections.some(section => section.text.includes(baseline)), 'Baseline leaked globally')
        assert(JSON.stringify(prompt).includes(task.preset === 'dsh-super-novel' ? '人物动机' : baseline), 'Prompt not mounted in Agent scope')
        let timedOut = false
        timer = setTimeout(() => { timedOut = true; handle.agent.cancel({ kind: 'user' }) }, plan.timeoutMs)
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: item.prompt }], source: { kind: 'user' } }))
        await handle.agent.whenIdle()
        const events = handle.agent.session.snapshotEvents()
        await save(`${id}.events.json`, events)
        const measurement = measureEvents(events)
        await writeFile(join(dir, `${id}.txt`), measurement.output + '\n', { mode: 0o600 })
        const result = { id, ...task, mode: 'real', ...measurement, timedOut, latencyMs: Math.round(performance.now() - started), checks: measureOutput(item, measurement.output) }
        result.runtimeSuccess = !timedOut && measurement.completed && measurement.output.length > 0 && measurement.requestCount === 1 && measurement.toolCalls === 0
        results.push(result)
      } catch (error) {
        if (handle) await save(`${id}.failure-events.json`, handle.agent.session.snapshotEvents())
        results.push({ id, ...task, mode: 'real', runtimeSuccess: false, errorKind: error.name, error: String(error.message), latencyMs: Math.round(performance.now() - started) })
      } finally {
        clearTimeout(timer)
        if (handle) await handle.dispose()
      }
      await save(`${id}.result.json`, results.at(-1))
      console.log(JSON.stringify({ id, runtimeSuccess: results.at(-1).runtimeSuccess, latencyMs: results.at(-1).latencyMs, checks: results.at(-1).checks, usage: results.at(-1).usage }))
      if (!results.at(-1).runtimeSuccess) break // Stop on runtime failure; no hidden retries or partial quality ranking.
    }
  } finally { await ctx.fiber.dispose() }
  await save('summary.json', { expected: plan.order.length, observed: results.length, complete: results.length === plan.order.length && results.every(x => x.runtimeSuccess), results })
  if (results.length !== plan.order.length || results.some(x => !x.runtimeSuccess)) process.exitCode = 1
}
