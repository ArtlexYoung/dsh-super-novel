import { readdir, mkdir, rename, rm, open, lstat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { BookError, hash, idSchema, json, parseBook } from '../domain/books.js'
import type { BackupSettings, BackupSummary, BackupPreview, BackupHealth } from '../types.js'
import { BookFiles } from './book-files.js'
import { BookStore } from './book-store.js'
import { StorageLocations, inside } from './storage-location.js'
import { syncDirectory } from './file-publication.js'
import { MAX_FILES, MAX_TOTAL, packArchive, unpackArchive } from './backup-archive.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const manifestSchema = z.strictObject({ format: z.literal('super-novel-backup'), version: z.literal(1), backupId: idSchema,
  bookId: idSchema, sourceWorkspaceId: digest, title: z.string().max(200), createdAt: z.int().nonnegative(), revision: z.int().positive(),
  recoveryRequired: z.boolean(), files: z.array(z.strictObject({ path: z.string().max(255), bytes: z.int().nonnegative(), hash: digest })).min(1).max(MAX_FILES) })
const configSchema = z.strictObject({ version: z.literal(1), root: z.string().max(4096), automatic: z.boolean() })
const CONFIG = '.super-novel/backup.json'
const sections = new Set(['chapters', 'drafts', 'transactions', 'proposals', 'fact-proposals', 'reviews', 'conflicts', 'recoveries', 'migrations', 'intents', 'intent-proposals', 'story-state', 'story-proposals'])
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')

function allowed(path: string, bookId: string): boolean {
  const pieces = path.split('/')
  if (pieces[0] !== 'novels' || pieces.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) return false
  if (pieces.length === 2) return pieces[1] === `${bookId}.creation.json`
  if (pieces[1] === 'imports') return pieces.length === 3 && pieces[2] === `${bookId}.json`
  return pieces[1] === bookId && (pieces.length === 3 && ['project.json', 'pending.json', 'migration.json'].includes(pieces[2]!) ||
    pieces.length >= 4 && sections.has(pieces[2]!) && !pieces.slice(3).some(part => part.startsWith('.')) && /\.(md|json)$/.test(pieces.at(-1)!))
}

/** Complete local project backups. No host configuration, credentials or chat. */
export class BackupStore {
  private constructor(private readonly files: BookFiles) {}
  static async at(root: string): Promise<BackupStore> { return new BackupStore(await BookFiles.at(root)) }

  async settings(): Promise<BackupSettings> {
    const file = await this.files.read(CONFIG)
    if (!file.exists) return { root: this.files.root, path: join(this.files.root, '.super-novel-backups'), automatic: true, intervalMinutes: 15 }
    const value = configSchema.parse(JSON.parse(file.text))
    return { root: value.root, path: join(value.root, '.super-novel-backups'), automatic: value.automatic, intervalMinutes: 15 }
  }

  async configure(root: string, automatic: boolean, mode: string): Promise<BackupSettings> {
    z.boolean().parse(automatic)
    if (inside(join(this.files.root, 'novels'), root)) throw new BookError('backup-inside-library')
    await (await StorageLocations.at(this.files.root)).validate(root, mode)
    if (inside(join(this.files.root, 'novels'), root)) throw new BookError('backup-inside-library')
    await this.files.directory('.super-novel')
    await this.files.lock('.super-novel/.backup-config.lock', async () => {
      const before = await this.files.read(CONFIG)
      await this.files.replace(CONFIG, json({ version: 1, root, automatic }), before)
    })
    return await this.settings()
  }

  private async destination(): Promise<BookFiles> { return await BookFiles.at((await this.settings()).root) }
  private name(bookId: string, backupId: string): string { return `.super-novel-backups/${idSchema.parse(bookId)}/${idSchema.parse(backupId)}.tar.gz` }

  async catalog(): Promise<BackupSummary[]> {
    const files = await this.destination()
    let names: string[]
    try { names = await readdir(await files.path('.super-novel-backups')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const result: BackupSummary[] = []
    for (const bookId of names.filter(name => idSchema.safeParse(name).success).slice(0, 10_000)) result.push(...await this.list(bookId))
    return result.sort((a, b) => b.createdAt - a.createdAt).slice(0, 1000)
  }

  async list(bookId: string): Promise<BackupSummary[]> {
    const files = await this.destination(), folder = `.super-novel-backups/${idSchema.parse(bookId)}`
    let names: string[]
    try { names = await readdir(await files.path(folder)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const result: BackupSummary[] = []
    for (const name of names.filter(name => /^[a-f0-9-]{36}\.summary\.json$/.test(name)).sort().reverse().slice(0, 100)) {
      try {
        const file = await files.read(`${folder}/${name}`), value = JSON.parse(file.text) as BackupSummary
        if (value.bookId === bookId && idSchema.safeParse(value.backupId).success && (await lstat(await files.path(this.name(bookId, value.backupId)))).isFile()) result.push(value)
      } catch { /* An unfinished/invalid sidecar is never shown as verified. */ }
    }
    return result.sort((a, b) => b.createdAt - a.createdAt)
  }

  async health(bookId: string): Promise<BackupHealth> {
    const file = await this.files.read(`.super-novel/backup-state/${idSchema.parse(bookId)}.json`)
    if (!file.exists) return { state: 'none', attemptedAt: 0, reason: '' }
    return z.strictObject({ state: z.enum(['verified', 'failed', 'none']), attemptedAt: z.int().nonnegative(), reason: z.string().max(200) }).parse(JSON.parse(file.text))
  }

  async create(bookId: string, backupId: string, signal: AbortSignal): Promise<BackupSummary> {
    idSchema.parse(bookId); idSchema.parse(backupId)
    const remember = async (state: BackupHealth): Promise<void> => {
      await this.files.directory('.super-novel/backup-state')
      const path = `.super-novel/backup-state/${bookId}.json`
      await this.files.replace(path, json(state), await this.files.read(path))
    }
    try {
      const result = await this.build(bookId, backupId, signal)
      await remember({ state: 'verified', attemptedAt: Date.now(), reason: '' }).catch(() => {})
      return result
    } catch (error) {
      await remember({ state: 'failed', attemptedAt: Date.now(), reason: error instanceof BookError ? error.code : 'storage-failed' }).catch(() => {})
      throw error
    }
  }

  private async build(bookId: string, backupId: string, signal: AbortSignal): Promise<BackupSummary> {
    idSchema.parse(bookId); idSchema.parse(backupId)
    const target = await this.destination(), folder = `.super-novel-backups/${bookId}`, name = this.name(bookId, backupId)
    await target.directory(folder)
    return await target.lock(`${folder}/.${backupId}.lock`, async () => {
      try { await lstat(await target.path(name)); return (await this.inspect(bookId, backupId, signal)).summary }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const staging = `${folder}/.stage-${backupId}`, temporary = `${name}.tmp-${randomUUID()}`
      await target.directory(staging, true)
      try {
        const manifest = await this.files.freeze(bookId, async () => {
          const book = await (await BookStore.at(this.files.root)).readBook(bookId), paths: string[] = []
          const walk = async (name: string): Promise<void> => {
            for (const entry of await readdir(await this.files.path(name), { withFileTypes: true })) {
              if (entry.name.startsWith('.') || entry.name.includes('.tmp-')) continue
              const child = `${name}/${entry.name}`
              await this.files.path(child)
              if (entry.isDirectory()) { if (name === `novels/${bookId}` && !sections.has(entry.name)) throw new BookError('unsupported-backup-file'); await walk(child) }
              else if (allowed(child, bookId)) paths.push(child)
              else throw new BookError('unsupported-backup-file')
            }
          }
          await walk(`novels/${bookId}`)
          for (const name of [`novels/${bookId}.creation.json`, `novels/imports/${bookId}.json`]) if ((await this.files.read(name, 32 * 1024 * 1024)).exists) paths.push(name)
          let inFlight = false
          const entries: { path: string; bytes: number; hash: string }[] = [], limit = MAX_FILES - 1
          let bytes = 0
          for (const path of paths.sort()) {
            signal.throwIfAborted()
            const file = await this.files.read(path, 32 * 1024 * 1024)
            if (!file.exists) throw new BookError('revision-conflict')
            if (path.includes('/proposals/') && JSON.parse(file.text).state === 'generating') inFlight = true
            const data = Buffer.from(file.text)
            bytes += data.length
            if (bytes > MAX_TOTAL || entries.length >= limit) throw new BookError('too-large')
            await target.directory(dirname(`${staging}/${path}`))
            await target.replace(`${staging}/${path}`, file.text, { exists: false, text: '' })
            entries.push({ path, bytes: data.length, hash: sha(data) })
          }
          // External editors do not share the barrier. Detect any change during capture.
          for (const entry of entries) if (hash((await this.files.read(entry.path, 32 * 1024 * 1024)).text) !== entry.hash) throw new BookError('revision-conflict')
          const check: string[] = [], previous = [...paths].sort()
          paths.length = 0; await walk(`novels/${bookId}`); check.push(...paths)
          if (json(check.sort()) !== json(previous.filter(path => path.startsWith(`novels/${bookId}/`)))) throw new BookError('revision-conflict')
          return manifestSchema.parse({ format: 'super-novel-backup', version: 1, backupId, bookId, sourceWorkspaceId: hash(this.files.root), title: book.title,
            revision: book.revision, createdAt: Date.now(), recoveryRequired: book.recoveryRequired || inFlight || entries.some(item => item.path.includes('/conflicts/')) || book.chapters.some(chapter => entries.find(item => item.path === `novels/${bookId}/chapters/${chapter.chapterId}.md`)?.hash !== chapter.hash), files: entries })
        })
        async function* entries() {
          yield { path: 'backup.json', data: Buffer.from(json(manifest)) }
          for (const entry of manifest.files) yield { path: entry.path, data: Buffer.from((await target.read(`${staging}/${entry.path}`, 32 * 1024 * 1024)).text) }
        }
        await packArchive(entries(), await target.path(temporary), signal)
        const preview = await this.validate(await target.path(temporary), signal)
        const handle = await open(await target.path(temporary), 'r')
        try { await handle.sync() } finally { await handle.close() }
        signal.throwIfAborted()
        await rename(await target.path(temporary), await target.path(name)); await syncDirectory(dirname(await target.path(name)))
        const summary = { ...preview.summary, path: await target.path(name) }
        await target.replace(`${folder}/${backupId}.summary.json`, json(summary), { exists: false, text: '' })
        return summary
      } finally { await rm(await target.path(staging), { recursive: true, force: true }); await rm(await target.path(temporary), { force: true }) }
    })
  }

  private async validate(path: string, signal: AbortSignal, output?: BookFiles): Promise<BackupPreview> {
    let manifest: z.infer<typeof manifestSchema> | undefined, count = 0, total = 0
    const seen = new Set<string>()
    for await (const entry of unpackArchive(path, signal)) {
      if (!manifest) {
        if (entry.path !== 'backup.json') throw new BookError('invalid-backup')
        try { manifest = manifestSchema.parse(JSON.parse(entry.data.toString('utf8'))) } catch { throw new BookError('invalid-backup') }
        if (new Set(manifest.files.map(file => file.path)).size !== manifest.files.length || manifest.files.some(file => !allowed(file.path, manifest!.bookId))) throw new BookError('invalid-backup')
        continue
      }
      const expected = manifest.files[count++]
      if (!expected || seen.has(entry.path) || entry.path !== expected.path || entry.data.length !== expected.bytes || sha(entry.data) !== expected.hash) throw new BookError('invalid-backup')
      seen.add(entry.path); total += entry.data.length
      if (total > MAX_TOTAL) throw new BookError('too-large')
      const text = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(entry.data)
      if (text.includes('\0')) throw new BookError('invalid-text')
      if (entry.path === `novels/${manifest.bookId}/project.json`) parseBook(text, manifest.bookId)
      if (output) { await output.directory(dirname(entry.path)); await output.replace(entry.path, text, { exists: false, text: '' }) }
    }
    if (!manifest || count !== manifest.files.length || !seen.has(`novels/${manifest.bookId}/project.json`)) throw new BookError('invalid-backup')
    return { summary: { backupId: manifest.backupId, bookId: manifest.bookId, title: manifest.title, revision: manifest.revision, createdAt: manifest.createdAt,
      verifiedAt: Date.now(), bytes: total, fileCount: count, recoveryRequired: manifest.recoveryRequired, path }, sourceWorkspaceId: manifest.sourceWorkspaceId,
      foreign: manifest.sourceWorkspaceId !== hash(this.files.root), manifestHash: hash(json(manifest)), files: manifest.files.map(file => file.path) }
  }

  async inspect(bookId: string, backupId: string, signal: AbortSignal): Promise<BackupPreview> {
    const target = await this.destination(), path = await target.path(this.name(bookId, backupId))
    const preview = await this.validate(path, signal)
    if (preview.summary.bookId !== bookId || preview.summary.backupId !== backupId) throw new BookError('invalid-backup')
    return preview
  }

  async restore(bookId: string, backupId: string, expectedManifestHash: string, signal: AbortSignal): Promise<{ root: string; bookId: string }> {
    digest.parse(expectedManifestHash)
    const preview = await this.inspect(bookId, backupId, signal)
    if (preview.manifestHash !== expectedManifestHash) throw new BookError('revision-conflict')
    const parent = '.super-novel/restored'
    await this.files.directory(parent)
    const staging = `${parent}/.restore-${randomUUID()}`, root = `${parent}/${randomUUID()}`
    await this.files.directory(staging, true)
    try {
      const output = await BookFiles.at(await this.files.path(staging))
      await output.directory('novels')
      await this.validate(preview.summary.path, signal, output)
      await output.directory('.super-novel')
      await output.replace('.super-novel/restored-from.json', json({ version: 1, backupId, sourceWorkspaceId: preview.sourceWorkspaceId, restoredAt: Date.now(), boundRecords: 'source-only' }), { exists: false, text: '' })
      signal.throwIfAborted()
      await rename(await this.files.path(staging), await this.files.path(root)); await syncDirectory(await this.files.path(parent))
      return { root: await this.files.path(root), bookId }
    } finally { await rm(await this.files.path(staging), { recursive: true, force: true }) }
  }
}
