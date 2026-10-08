import { basename } from 'node:path'
import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ZodError } from 'zod'
import { BookError, hash } from '../domain/books.js'
import { BookStore } from './book-store.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap { 'super-novel/storage': { readonly reason: string } }
}

export interface WorkspaceBooks {
  readonly store: BookStore
  readonly workspace: string
  readonly root: string
  readonly workspaceId: string
  readonly writable: boolean
  readonly session: Session
}

export async function workspaceBooks(ctx: Context, sessionId: string, writing: boolean, signal: AbortSignal): Promise<WorkspaceBooks> {
  signal.throwIfAborted()
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const fs = ctx.get('fs')
  const policy = ctx.get('sandboxPolicy')
  if (!sessions || !persistence || !fs || !policy) throw new BookError('host-unavailable')
  if (!sessionId || sessionId.length > 200) throw new BookError('session-unavailable')
  let session = sessions.get(SessionId(sessionId))
  const header = session?.header ?? (await persistence.stat(SessionId(sessionId)))?.header
  if (!header?.cwd) throw new BookError('workspace-unavailable')
  const root = await realpath(header.cwd)
  const target = await fs.resolve(root, { signal })
  if (fs.processPathFromHostPath(root) !== root || fs.processPath(target) !== root) throw new BookError('local-only')
  if (!session) {
    const handle = await persistence.open(SessionId(sessionId), 'read', { signal })
    try {
      const log = await handle.read(0, undefined, { signal })
      session = sessions.get(SessionId(sessionId)) ?? sessions.prepare(SessionId(sessionId), {
        meta: structuredClone(handle.header), inheritedEventCount: handle.inheritedEventCount,
        seed: [...log.events], eventState: log.eventState,
      })
    } finally { await handle.close() }
  }
  const mode = policy.resolve({ session }).mode
  const writable = mode !== 'read-only'
  if (writing && !writable) throw new BookError('read-only')
  return { store: await BookStore.at(root), root, workspace: basename(root), workspaceId: hash(root), writable, session }
}

export async function storageResult<T>(action: () => Promise<T>): Promise<T> {
  try { return await action() }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    const code = error instanceof BookError ? error.code : error instanceof ZodError ? 'invalid-request' : 'storage-failed'
    throw new RemoteError('super-novel/storage', code, { reason: code })
  }
}
