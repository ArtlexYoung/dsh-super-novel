import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { BookError } from '../domain/books.js'
import { publishFile, syncDirectory } from './file-publication.js'

export interface FileState { readonly exists: boolean; readonly text: string }

const active = new AsyncLocalStorage<ReadonlySet<string>>()

/** Local-only storage. Every managed component is checked before opening it. */
export class BookFiles {
  private constructor(readonly root: string) {}

  static async at(root: string): Promise<BookFiles> {
    if (!isAbsolute(root) || !(await lstat(root)).isDirectory()) throw new BookError('workspace-unavailable')
    return new BookFiles(await realpath(root))
  }

  async path(name: string): Promise<string> {
    if (!(await lstat(this.root)).isDirectory() || await realpath(this.root) !== this.root) throw new BookError('unsafe-path')
    const target = resolve(this.root, name)
    const child = relative(this.root, target)
    if (!child || child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child)) throw new BookError('unsafe-path')
    let current = this.root
    const pieces = child.split(sep)
    for (let i = 0; i < pieces.length; i++) {
      current = join(current, pieces[i]!)
      try {
        const stat = await lstat(current)
        // lstat can also observe the old inode as atomic replacement unlinks it.
        if (stat.isSymbolicLink() || (i < pieces.length - 1 && !stat.isDirectory()) || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink > 1)) throw new BookError('unsafe-path')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; break }
    }
    return target
  }

  async directory(name: string, exclusive = false): Promise<void> {
    await this.guard(name, async () => { await this.makeDirectory(name, exclusive) })
  }
  private async makeDirectory(name: string, exclusive: boolean): Promise<void> {
    const path = await this.path(name)
    await mkdir(path, { recursive: !exclusive, mode: 0o700 })
    await this.path(name)
  }

  async read(name: string, maxBytes = 4 * 1024 * 1024): Promise<FileState> {
    const path = await this.path(name)
    let handle
    try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, text: '' }; throw error }
    try {
      const info = await handle.stat()
      // Atomic replacement can unlink an already-open, valid old inode.
      if (!info.isFile() || info.nlink > 1) throw new BookError('unsafe-path')
      if (info.size > maxBytes) throw new BookError('too-large')
      const chunks: Buffer[] = []
      let used = 0
      while (used <= maxBytes) {
        const buffer = Buffer.alloc(Math.min(65_536, maxBytes - used + 1))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) break
        used += bytesRead
        chunks.push(buffer.subarray(0, bytesRead))
      }
      if (used > maxBytes) throw new BookError('too-large')
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, used)) }
      catch { throw new BookError('invalid-text') }
      if (text.includes('\0')) throw new BookError('invalid-text')
      return { exists: true, text }
    } finally { await handle.close() }
  }

  async remove(name: string, before: FileState): Promise<void> {
    await this.guard(name, async () => { await this.removeFile(name, before) })
  }
  private async removeFile(name: string, before: FileState): Promise<void> {
    const current = await this.read(name, 32 * 1024 * 1024)
    if (current.exists !== before.exists || current.text !== before.text) throw new BookError('revision-conflict')
    const path = await this.path(name)
    await rm(path)
    await syncDirectory(dirname(path))
  }

  /** Check immediately before publication; a journal retains both versions. */
  async replace(name: string, text: string, before: FileState): Promise<void> {
    await this.guard(name, async () => { await this.replaceFile(name, text, before) })
  }
  private async replaceFile(name: string, text: string, before: FileState): Promise<void> {
    const path = await this.path(name)
    const temporary = `${path}.tmp-${randomUUID()}`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      try { await handle.writeFile(text, 'utf8'); await handle.sync() }
      finally { await handle.close() }
      await publishFile(async () => {
        const current = await this.read(name, 32 * 1024 * 1024)
        if (current.exists !== before.exists || current.text !== before.text) throw new BookError('revision-conflict')
        await this.path(name)
        await rename(temporary, path)
      })
      await syncDirectory(dirname(path))
    } finally { await rm(temporary, { force: true }) }
  }

  async lock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    return await this.guard(name, async () => await this.acquire(name, operation))
  }

  /** All managed writers share this barrier; compression runs after releasing it. */
  async freeze<T>(bookId: string, operation: () => Promise<T>): Promise<T> {
    return await this.guard(`novels/${bookId}/project.json`, operation)
  }

  private async guard<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const match = /^novels[/\\](?:imports[/\\]\.?)?([a-f0-9-]{36})(?:[/\\]|\.(?:creation\.json|json|lock)$|$)/i.exec(name)
    if (!match) return await operation()
    const key = `${this.root}:${match[1]}`, inherited = active.getStore() ?? new Set<string>()
    if (inherited.has(key)) return await operation()
    return await this.acquire(`novels/.${match[1]}.snapshot.lock`, async () =>
      await active.run(new Set([...inherited, key]), operation))
  }

  private async acquire<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const path = await this.path(name)
    try { await mkdir(path, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BookError('busy'); throw error }
    try { return await operation() }
    finally { await this.path(name); await rmdir(path) }
  }
}
