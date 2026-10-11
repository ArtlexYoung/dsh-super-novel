import { readdir } from 'node:fs/promises'
import { z } from 'zod'
import { BookError, hash, idSchema, json, titleSchema } from '../domain/books.js'
import type { MilestoneListing, MilestoneRequest, MilestoneSummary } from '../types.js'
import { BackupStore } from './backup-store.js'
import { BookFiles } from './book-files.js'
import { BookStore } from './book-store.js'

export const milestoneSchema = z.strictObject({ workspaceId: z.string().regex(/^[a-f\d]{64}$/), bookId: idSchema, backupId: idSchema, expectedRevision: z.int().positive(), label: titleSchema })
const recordSchema = z.strictObject({ schemaVersion: z.literal(1), request: milestoneSchema, title: titleSchema, createdAt: z.int().nonnegative(), manifestHash: z.string().regex(/^[a-f\d]{64}$/) })
export interface MilestoneHooks { afterStage?(stage: 'prepared' | 'archived' | 'completed'): Promise<void> }
const summary = (value: z.infer<typeof recordSchema>): MilestoneSummary => ({ bookId: value.request.bookId, backupId: value.request.backupId, label: value.request.label, title: value.title, revision: value.request.expectedRevision, createdAt: value.createdAt, manifestHash: value.manifestHash })

/** A name refers to one complete verified archive, with durable request identity. */
export class MilestoneStore {
  private constructor(private readonly root: string, private readonly books: BookStore, private readonly backups: BackupStore, private readonly files: BookFiles, private readonly hooks: MilestoneHooks) {}
  static async at(root: string, books: BookStore, hooks: MilestoneHooks = {}): Promise<MilestoneStore> {
    const backups = await BackupStore.at(root)
    return new MilestoneStore(root, books, backups, await BookFiles.at((await backups.settings()).root), hooks)
  }
  async create(input: MilestoneRequest, signal: AbortSignal): Promise<MilestoneSummary> {
    const request = milestoneSchema.parse(input)
    if (request.workspaceId !== hash(this.root)) throw new BookError('location-changed')
    if ((await this.backups.settings()).root !== this.files.root) throw new BookError('location-changed')
    signal.throwIfAborted()
    const folder = `.super-novel-backups/${request.bookId}`, base = `${folder}/${request.backupId}`
    await this.files.directory(folder)
    return await this.files.lock(`${folder}/.milestone-${request.backupId}.lock`, async () => {
      const prepared = await this.files.read(`${base}.milestone-request.json`)
      if (prepared.exists) {
        if (json(milestoneSchema.parse(JSON.parse(prepared.text))) !== json(request)) throw new BookError('operation-conflict')
      } else {
        const book = await this.books.readBook(request.bookId)
        if (book.recoveryRequired) throw new BookError('recovery-required')
        if (book.revision !== request.expectedRevision) throw new BookError('revision-conflict')
        await this.files.replace(`${base}.milestone-request.json`, json(request), prepared)
      }
      await this.hooks.afterStage?.('prepared')
      const completed = await this.files.read(`${base}.milestone.json`)
      if (completed.exists) {
        const value = recordSchema.parse(JSON.parse(completed.text))
        if (json(value.request) !== json(request)) throw new BookError('operation-conflict')
        const verified = await this.backups.inspect(request.bookId, request.backupId, signal)
        if (verified.manifestHash !== value.manifestHash) throw new BookError('invalid-backup')
        if ((await this.backups.settings()).root !== this.files.root) throw new BookError('location-changed')
        return summary(value)
      }
      const archive = await this.backups.create(request.bookId, request.backupId, signal)
      if (archive.recoveryRequired || archive.revision !== request.expectedRevision) throw new BookError('revision-conflict')
      const verified = await this.backups.inspect(request.bookId, request.backupId, signal)
      if (verified.sourceWorkspaceId !== request.workspaceId) throw new BookError('location-changed')
      if ((await this.backups.settings()).root !== this.files.root) throw new BookError('location-changed')
      await this.hooks.afterStage?.('archived')
      const value = recordSchema.parse({ schemaVersion: 1, request, title: archive.title, createdAt: archive.createdAt, manifestHash: verified.manifestHash })
      signal.throwIfAborted()
      await this.files.replace(`${base}.milestone.json`, json(value), completed)
      await this.hooks.afterStage?.('completed')
      return summary(value)
    })
  }
  async list(bookId: string, signal: AbortSignal): Promise<MilestoneListing> {
    idSchema.parse(bookId); signal.throwIfAborted()
    const folder = `.super-novel-backups/${bookId}`
    let names: string[]
    try { names = await readdir(await this.files.path(folder)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], unreadable: 0, complete: true }; throw error }
    const candidates = names.filter(name => /^[a-f0-9-]{36}\.milestone\.json$/.test(name)), items: MilestoneSummary[] = []; let unreadable = 0
    for (const name of candidates.sort().slice(0, 100)) {
      signal.throwIfAborted()
      try {
        const value = recordSchema.parse(JSON.parse((await this.files.read(`${folder}/${name}`)).text))
        if (value.request.workspaceId !== hash(this.root) || value.request.bookId !== bookId || name !== `${value.request.backupId}.milestone.json`) throw new BookError('invalid-format')
        items.push(summary(value))
      } catch { signal.throwIfAborted(); unreadable++ }
    }
    return { items: items.sort((a, b) => b.createdAt - a.createdAt), unreadable, complete: !unreadable && candidates.length <= 100 }
  }
}
