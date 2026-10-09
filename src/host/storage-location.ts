import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { BookError, hash, json } from '../domain/books.js'
import { BookFiles } from './book-files.js'

const CONFIG = '.super-novel/storage.json'
const schema = z.strictObject({ schemaVersion: z.literal(1), root: z.string().min(1).max(4096), previousRoots: z.array(z.string().min(1).max(4096)).max(50) })

/** Workspace-local preference; switching never moves, deletes or merges libraries. */
export class StorageLocations {
  private constructor(private readonly files: BookFiles) {}
  static async at(workspace: string): Promise<StorageLocations> { return new StorageLocations(await BookFiles.at(workspace)) }

  async read(): Promise<{ root: string; previousRoots: string[] }> {
    const file = await this.files.read(CONFIG, 512 * 1024)
    if (!file.exists) return { root: this.files.root, previousRoots: [] }
    let value
    try { value = schema.parse(JSON.parse(file.text)) } catch { throw new BookError('invalid-format') }
    if (![value.root, ...value.previousRoots].every(isAbsolute)) throw new BookError('unsafe-path')
    return { root: value.root, previousRoots: value.previousRoots }
  }

  async validate(root: string, mode: string): Promise<string> {
    if (mode === 'read-only') throw new BookError('read-only')
    if (!isAbsolute(root) || root.length > 4096 || root.includes('\0')) throw new BookError('invalid-location')
    // Do not canonicalize a selected link into an approved target silently.
    let target
    try { target = await BookFiles.at(root) }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new BookError('invalid-location'); throw error }
    if (target.root !== root) throw new BookError('unsafe-path')
    if (mode !== 'danger-full-access' && !inside(this.files.root, root)) throw new BookError('location-outside-workspace')
    return root
  }

  async change(root: string, expectedWorkspaceId: string, mode: string, signal: AbortSignal): Promise<{ root: string; previousRoots: string[] }> {
    await this.validate(root, mode)
    signal.throwIfAborted()
    await this.files.directory('.super-novel')
    return await this.files.lock('.super-novel/.location.lock', async () => {
      const before = await this.files.read(CONFIG, 512 * 1024)
      const current = await this.read()
      if (hash(current.root) !== expectedWorkspaceId) throw new BookError('location-changed')
      if (current.root === root) return current
      const previousRoots = [...new Set([current.root, ...current.previousRoots])].filter(item => item !== root).slice(0, 50)
      signal.throwIfAborted()
      await this.files.replace(CONFIG, json({ schemaVersion: 1, root, previousRoots }), before)
      return { root, previousRoots }
    })
  }
}

export function inside(workspace: string, target: string): boolean {
  const child = relative(workspace, target)
  return !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)
}

export function libraryPath(root: string): string { return join(root, 'novels') }
