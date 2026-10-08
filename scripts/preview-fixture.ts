/** Seed two deterministic sessions with empty completed turns in the isolated smoke profile; never sends a prompt. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
export const inject = ['workspaceController', 'sessionController', 'sessions', 'agentPresets', 'superNovel']
export async function apply(ctx) {
  const roster = await ctx.agentPresets.list()
  assert.equal(ctx.agentPresets.defaultId, 'standard')
  assert(!roster.some(row => row.broken))
  await writeFile('.test-output/profile-check.json', JSON.stringify({
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
}
