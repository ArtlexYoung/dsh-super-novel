/** Own only the fixed bundled preset; never alter the host roster configuration. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rmdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'

export const PRESET_ID = 'dsh-super-novel'
const MARKER = '.dsh-super-novel.json'
const FILES = ['preset.yml', 'agent.cordis.yml'] as const
const MAX_BYTES = 65_536

import type { PresetStatus } from '../types.js'

/** Narrow adapter to the host's authoritative preset roots and roster. */
export interface PresetHost {
  readonly roots: readonly { readonly path: string; readonly trust: 'system' | 'user' }[]
  list(): Promise<readonly { readonly id: string; readonly path: string; readonly broken?: string }[]>
}

interface Owner {
  readonly package: string
  readonly version: string
  readonly hashes: Record<string, string>
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

async function regularText(path: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Unsafe or oversized preset file')
  return await readFile(path, 'utf8')
}

/** Installation is explicit, no-overwrite, serialized across processes, and resumable. */
export class PresetInstaller {
  constructor(
    private readonly host: PresetHost,
    private readonly source: string,
    private readonly version: string,
  ) {}

  private root(): string {
    const root = this.host.roots.find(entry => entry.trust === 'user')
    if (!root) throw new Error('No user preset root')
    return resolve(expandHomePath(root.path))
  }

  private async payload(): Promise<{ owner: Owner; files: Record<string, string> }> {
    const files: Record<string, string> = {}
    for (const name of FILES) files[name] = await regularText(join(this.source, name))
    return { owner: { package: PRESET_ID, version: this.version, hashes: Object.fromEntries(FILES.map(name => [name, hash(files[name]!)])) }, files }
  }

  /** Inspect only; viewing the sidebar never creates a directory or calls a model. */
  async status(): Promise<PresetStatus> {
    if (!this.host.roots.some(entry => entry.trust === 'user')) return { state: 'unavailable', reason: 'no-user-root' }
    const configured = this.host.roots.find(entry => entry.trust === 'user')!
    // Discovery accepts relative paths, but explicit setup requires an unambiguous root.
    if (!isAbsolute(expandHomePath(configured.path))) return { state: 'unavailable', reason: 'relative-user-root' }
    const root = this.root()
    if (await exists(root) && !(await lstat(root)).isDirectory()) return { state: 'conflict', reason: 'unsafe-root' }
    if (await exists(join(root, '.dsh-super-novel.lock'))) return { state: 'busy', reason: 'installation-lock' }
    return await this.inspect(root)
  }

  private async inspect(root: string): Promise<PresetStatus> {
    const target = join(root, PRESET_ID)
    const roster = (await this.host.list()).find(entry => entry.id === PRESET_ID)
    if (roster && resolve(roster.path) !== join(target, 'agent.cordis.yml')) return { state: 'conflict', reason: 'shadowed-id' }
    if (!await exists(target)) return { state: 'available', reason: 'not-installed' }
    if (!(await lstat(target)).isDirectory()) return { state: 'conflict', reason: 'unsafe-target' }
    if (!await exists(join(target, MARKER))) return { state: 'conflict', reason: 'unowned-directory' }
    const { owner } = await this.payload()
    let actual: unknown
    try { actual = JSON.parse(await regularText(join(target, MARKER))) }
    catch { return { state: 'conflict', reason: 'invalid-owner-record' } }
    if (JSON.stringify(actual) !== JSON.stringify(owner)) return { state: 'conflict', reason: 'different-version-or-owner' }
    const entries = await readdir(target)
    if (entries.some(name => name !== MARKER && !(FILES as readonly string[]).includes(name))) return { state: 'conflict', reason: 'extra-files' }
    let missing = false
    for (const name of FILES) {
      if (!await exists(join(target, name))) { missing = true; continue }
      try {
        if (hash(await regularText(join(target, name))) !== owner.hashes[name]) return { state: 'conflict', reason: 'modified-preset' }
      } catch { return { state: 'conflict', reason: 'unsafe-file' } }
    }
    if (missing) return { state: 'incomplete', reason: 'resume-installation' }
    if (!roster || roster.broken) return { state: 'unavailable', reason: 'host-discovery-failed' }
    return { state: 'enabled', reason: 'ready' }
  }

  /** Explicit user action: publish composition last, never replace existing bytes. */
  async enable(signal: AbortSignal): Promise<PresetStatus> {
    signal.throwIfAborted()
    const before = await this.status()
    if (before.state !== 'available' && before.state !== 'incomplete') return before
    const root = this.root()
    await mkdir(root, { recursive: true, mode: 0o700 })
    if (!(await lstat(root)).isDirectory()) return { state: 'conflict', reason: 'unsafe-root' }
    const lock = join(root, '.dsh-super-novel.lock')
    try { await mkdir(lock, { mode: 0o700 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { state: 'busy', reason: 'installation-lock' }
      throw error
    }
    try {
      const current = await this.inspect(root)
      if (current.state !== 'available' && current.state !== 'incomplete') return current
      const { owner, files } = await this.payload()
      const target = join(root, PRESET_ID)
      signal.throwIfAborted()
      if (current.state === 'available') {
        // mkdir exclusively reserves the ID; failure never cleans somebody else's tree.
        try { await mkdir(target, { mode: 0o700 }) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { state: 'conflict', reason: 'concurrent-owner' }
          throw error
        }
        await writeFile(join(target, MARKER), JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 })
      }
      for (const name of FILES) {
        signal.throwIfAborted()
        if (!await exists(join(target, name))) await writeFile(join(target, name), files[name]!, { flag: 'wx', mode: 0o600 })
      }
      return await this.inspect(root)
    } finally {
      // Only our exclusively created, still-empty lock is removed. Crash locks stay visible.
      await rmdir(lock)
    }
  }
}
