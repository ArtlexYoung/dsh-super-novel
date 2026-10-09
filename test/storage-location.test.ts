import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projection from '@deepseek-ai/dsh-session-projection'
import Policy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import SuperNovel from '../lib/index.js'
import { hash } from '../lib/domain/books.js'

const signal = () => new AbortController().signal
const reason = expected => error => error.details.reason === expected

async function fixture(t) {
  await mkdir('.test-output', { recursive: true })
  const parent = await mkdtemp(resolve('.test-output/locations-')), root = join(parent, 'workspace'), outside = join(parent, 'other disk')
  await mkdir(root); await mkdir(outside)
  t.after(() => rm(parent, { recursive: true, force: true }))
  const ctx = new Context()
  ctx.provide('sessionPersistence', { stat: async () => undefined })
  ctx.provide('agentPresets', { roots: [], list: async () => [] })
  ctx.plugin(Sessions); ctx.plugin(Projection); ctx.plugin(Policy, { mode: 'read-only' }); ctx.plugin(LocalFs); ctx.plugin(SuperNovel)
  t.after(() => ctx.fiber.dispose())
  await new Promise(resolve => ctx.inject(['sessions', 'sessionProjections', 'sandboxPolicy', 'fs', 'superNovel'], () => resolve(true)))
  const sessionId = SessionId('location-session'), session = ctx.sessions.create(sessionId, { meta: { cwd: root } })
  return { root, outside, ctx, session, sessionId, api: ctx.superNovel }
}

test('locations are read without creating files; readonly, external workspace-write and linked paths are rejected', async t => {
  const { root, outside, api, ctx, session, sessionId } = await fixture(t)
  const info = await api.storageLocation(sessionId, signal())
  assert.equal(info.root, root); assert.equal(info.path, join(root, 'novels')); assert.equal(info.canChange, false)
  assert.deepEqual(await readdir(root), [])
  await assert.rejects(api.changeStorageLocation(sessionId, { root: outside, expectedWorkspaceId: info.workspaceId }, signal()), reason('read-only'))
  setSandboxMode(session, 'workspace-write')
  await assert.rejects(api.changeStorageLocation(sessionId, { root: outside, expectedWorkspaceId: info.workspaceId }, signal()), reason('location-outside-workspace'))
  assert.deepEqual(await readdir(outside), [])
  const link = join(root, 'link'); await symlink(outside, link)
  await assert.rejects(api.changeStorageLocation(sessionId, { root: link, expectedWorkspaceId: info.workspaceId }, signal()), reason('workspace-unavailable'))
  await assert.rejects(api.changeStorageLocation(sessionId, { root: '../relative', expectedWorkspaceId: info.workspaceId }, signal()), reason('invalid-location'))
  assert.equal((await api.library(sessionId, signal())).workspaceId, hash(root))
  const opened = []
  ctx.provide('sessionController', { workspaceDesktop: () => ({ available: true }), openWorkspacePath: async request => { opened.push(request.path); return { opened: true } } })
  assert.deepEqual(await api.openStorageLocation(sessionId, info.workspaceId, signal()), { opened: true })
  assert.deepEqual(opened, [root])
})

test('switching retains the original library and checkpoints; stale windows cannot checkpoint or save to the new root', async t => {
  const { root, api, session, sessionId } = await fixture(t)
  setSandboxMode(session, 'workspace-write')
  const info = await api.storageLocation(sessionId, signal()), alternate = join(root, 'books elsewhere')
  await mkdir(alternate)
  let book = await api.createBook(sessionId, { operationId: randomUUID(), title: '保留原库' }, signal())
  const chapterId = randomUUID()
  book = await api.changeChapter(sessionId, { operationId: randomUUID(), bookId: book.bookId, chapterId, expectedRevision: book.revision, expectedHash: '', action: 'create', title: '首章', content: '', beforeChapterId: '' }, signal())
  const request = { workspaceId: info.workspaceId, bookId: book.bookId, chapterId, branchId: randomUUID(), sequence: 1, baseHash: hash(''), bookRevision: book.revision, content: '切换前的草稿。', operationId: randomUUID() }
  await api.checkpointDraft(sessionId, request, signal())
  const switched = await api.changeStorageLocation(sessionId, { root: alternate, expectedWorkspaceId: info.workspaceId }, signal())
  assert.equal(switched.workspaceId, hash(alternate)); assert.deepEqual(switched.previousRoots, [root])
  assert.deepEqual((await api.library(sessionId, signal())).books, [])
  await assert.rejects(api.checkpointDraft(sessionId, { ...request, sequence: 2 }, signal()), reason('location-changed'))
  await assert.rejects(api.changeChapter(sessionId, { operationId: request.operationId, workspaceId: info.workspaceId, bookId: book.bookId, chapterId, expectedRevision: book.revision, expectedHash: hash(''), action: 'save', content: request.content, title: '', beforeChapterId: '' }, signal()), reason('location-changed'))
  await assert.rejects(api.changeStorageLocation(sessionId, { root, expectedWorkspaceId: info.workspaceId }, signal()), reason('location-changed'))
  await api.changeStorageLocation(sessionId, { root, expectedWorkspaceId: switched.workspaceId }, signal())
  assert.equal((await api.chapterDrafts(sessionId, { workspaceId: info.workspaceId, bookId: book.bookId, chapterId }, signal())).drafts[0].contentHash, hash(request.content))
  assert.equal((await api.chapter(sessionId, book.bookId, chapterId, signal())).content, '')
  setSandboxMode(session, 'read-only')
  await assert.rejects(api.checkpointDraft(sessionId, { ...request, sequence: 2 }, signal()), reason('read-only'))
  await assert.rejects(api.settleDraft(sessionId, { workspaceId: info.workspaceId, bookId: book.bookId, chapterId, branchId: request.branchId, sequence: 1, contentHash: hash(request.content), action: 'dismissed' }, signal()), reason('read-only'))
  assert.equal((await api.readDraft(sessionId, { workspaceId: info.workspaceId, bookId: book.bookId, chapterId, branchId: request.branchId, sequence: 1 }, signal())).content, request.content)
})

test('an unavailable selected disk still allows switching back; external access respects a later permission downgrade', async t => {
  const { root, outside, api, ctx, session, sessionId } = await fixture(t)
  setSandboxMode(session, 'danger-full-access')
  let info = await api.storageLocation(sessionId, signal())
  info = await api.changeStorageLocation(sessionId, { root: outside, expectedWorkspaceId: info.workspaceId }, signal())
  setSandboxMode(session, 'workspace-write')
  assert.equal((await api.library(sessionId, signal())).writable, false)
  await assert.rejects(api.createBook(sessionId, { operationId: randomUUID(), title: '越界' }, signal()), reason('location-outside-workspace'))
  await rm(outside, { recursive: true })
  assert.equal((await api.storageLocation(sessionId, signal())).root, outside)
  await api.changeStorageLocation(sessionId, { root, expectedWorkspaceId: info.workspaceId }, signal())
  assert.equal((await api.library(sessionId, signal())).writable, true)
  ctx.provide('directoryPicker', { capability: () => ({ kind: 'native', pick: async () => null }) })
  assert.deepEqual(await api.pickStorageLocation(sessionId, signal()), { selected: false, root: '' })
  await assert.rejects(api.openStorageLocation(sessionId, hash(root), signal()), reason('native-open-unavailable'))
})
