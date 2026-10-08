/** Seed two deterministic sessions with empty completed turns in the isolated smoke profile; never sends a prompt. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
export const inject = ['workspaceController', 'sessionController', 'sessions', 'agentPresets', 'superNovel', 'llm', 'settings']
export function apply(ctx, config = {}) {
  // 0.2 roster diagnostics may await the Loader, so never query them while this row is activating.
  const task = ctx.fiber.await().then(() => seed(ctx, config))
  task.catch(async error => {
    await writeFile(resolve(process.env.DSH_HOME, '../fixture-error.json'), JSON.stringify({ message: error.message }))
    ctx.logger.error(error)
  })
  ctx.effect(() => async () => { await task })
}

async function seed(ctx, config) {
  if (config.locale === 'en') await ctx.settings.update('locale', { preference: 'en' })
  const roster = await ctx.agentPresets.list()
  assert.notEqual(ctx.agentPresets.defaultId, 'dsh-super-novel')
  assert(!roster.some(row => row.broken))
  await writeFile(resolve(process.env.DSH_HOME, '../profile-check.json'), JSON.stringify({
    defaultId: ctx.agentPresets.defaultId, presets: roster.map(row => row.id),
    setup: await ctx.superNovel.status(new AbortController().signal),
  }, null, 2))
  const path = resolve(process.env.DSH_HOME, '../workspace')
  await mkdir(path, { recursive: true })
  const { workspace } = await ctx.workspaceController.create({ path })
  for (const sessionId of ['super-novel-preview-a', 'super-novel-preview-b', 'super-novel-preview-readonly']) {
    await ctx.sessionController.create({ workspaceId: workspace.workspaceId, sessionId })
    const session = ctx.sessions.get(sessionId)
    setSandboxMode(session, sessionId.endsWith('readonly') ? 'read-only' : 'workspace-write')
    if (!(await ctx.sessionController.list({})).items.find(item => item.sessionId === sessionId && !item.blank)) {
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }
    await ctx.sessionController.rename({ sessionId, title: sessionId })
  }
  await writeFile(resolve(process.env.DSH_HOME, '../fixture-stage.json'), JSON.stringify({ stage: 'sessions-created' }))
  if (config.generationFixture === true) {
    const { apply } = await import('./preview-generation.ts')
    await apply(ctx)
  }
  await writeFile(resolve(process.env.DSH_HOME, '../sessions-check.json'), JSON.stringify({
    items: (await ctx.sessionController.list({})).items.map(item => ({ sessionId: item.sessionId, blank: item.blank })),
  }))
}
