import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projection from '@deepseek-ai/dsh-session-projection'
import Policy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import { workspaceBooks, storageResult } from '../lib/host/workspace-books.js'

async function fixture(t) {
  await mkdir('.test-output', { recursive: true })
  const root = await mkdtemp(resolve('.test-output/workspace-books-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const ctx = new Context()
  ctx.provide('sessionPersistence', { stat: async () => undefined })
  ctx.plugin(Sessions)
  ctx.plugin(Projection)
  ctx.plugin(Policy, { mode: 'read-only' })
  ctx.plugin(LocalFs)
  t.after(() => ctx.fiber.dispose())
  await new Promise(resolve => ctx.inject(['sessions', 'sessionProjections', 'sandboxPolicy', 'fs'], () => resolve(true)))
  const session = ctx.sessions.create(SessionId('book-session'), { meta: { cwd: root } })
  return { ctx, root, session }
}

test('workspace identity comes only from the Session and read-only mode blocks writes', async t => {
  const { ctx, root, session } = await fixture(t)
  const before = session.seq
  const scope = await workspaceBooks(ctx, 'book-session', false, new AbortController().signal)
  assert.equal(scope.writable, false)
  assert.equal(scope.workspaceId.length, 64)
  assert.equal(scope.workspace, root.split('/').at(-1))
  assert.deepEqual(await scope.store.list(), [])
  await assert.rejects(workspaceBooks(ctx, 'book-session', true, new AbortController().signal), error => error.code === 'read-only')
  assert.deepEqual(await readdir(root), [])
  assert.equal(session.seq, before)
  setSandboxMode(session, 'workspace-write')
  assert.equal((await workspaceBooks(ctx, 'book-session', true, new AbortController().signal)).writable, true)
  await assert.rejects(workspaceBooks(ctx, '../another-session', true, new AbortController().signal), error => error.code === 'workspace-unavailable')
})

test('persisted cold Sessions retain their logged policy without activating an Agent', async t => {
  const { ctx, session } = await fixture(t)
  setSandboxMode(session, 'workspace-write')
  const header = structuredClone(session.header)
  const events = structuredClone(session.snapshotEvents())
  const id = SessionId('cold-session')
  header.id = id
  let closed = false
  ctx.set('sessionPersistence', {
    stat: async () => ({ header }),
    open: async () => ({ header, inheritedEventCount: 0, read: async () => ({ events, eventState: 'detached' }), close: async () => { closed = true } }),
  })
  assert.equal((await workspaceBooks(ctx, id, true, new AbortController().signal)).writable, true)
  assert.equal(closed, true)
  assert.equal(ctx.sessions.get(id), undefined)
  events.push({ type: 'sandbox/mode', seq: events.length, time: Date.now(), data: { mode: 'read-only' } })
  await assert.rejects(workspaceBooks(ctx, id, true, new AbortController().signal), error => error.code === 'read-only')
})

test('remote filesystems and pathless sessions fail with path-free Remote errors', async t => {
  const { ctx, session } = await fixture(t)
  ctx.sessions.create(SessionId('no-path'))
  await assert.rejects(storageResult(() => workspaceBooks(ctx, 'no-path', false, new AbortController().signal)), error => error.code === 'super-novel/storage' && error.details.reason === 'workspace-unavailable')
  const remote = { get: key => key === 'fs' ? { resolve: async () => ({ targetKey: 'remote' }), processPathFromHostPath: () => undefined, processPath: () => '/remote' } : ctx.get(key) }
  await assert.rejects(workspaceBooks(remote, session.id, false, new AbortController().signal), error => error.code === 'local-only')
})
