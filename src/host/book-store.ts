import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { BookError, contentSchema, documentKindSchema, hash, idSchema, json, parseBook, snapshot, titleSchema, transactionSchema, transactionSourceSchema } from '../domain/books.js'
import type { Book, Transaction } from '../domain/books.js'
import type { BookSnapshot, ChapterMutationRequest, ChapterText, CreateBookRequest, InterruptedChapterSave, SettleInterruptedSaveRequest } from '../types.js'
import { BookFiles } from './book-files.js'

const ROOT = 'novels'
const mutationSchema = z.strictObject({
  operationId: idSchema, bookId: idSchema, expectedRevision: z.int().positive(),
  action: z.enum(['create', 'rename', 'move', 'save']), chapterId: idSchema,
  title: z.string().max(200), beforeChapterId: z.union([idSchema, z.literal('')]),
  content: contentSchema, expectedHash: z.string().max(64),
  kind: documentKindSchema.optional(), linkedChapterId: idSchema.optional(),
})
export type CommitStage = 'creation' | 'prepared' | 'chapter' | 'manifest' | 'completed'
export interface StoreHooks { afterStage?(stage: CommitStage): Promise<void> }

/** Journals precede every publication; read-only views never run recovery. */
export class BookStore {
  private constructor(private readonly files: BookFiles, private readonly hooks: StoreHooks) {}

  static async at(workspace: string, hooks: StoreHooks = {}): Promise<BookStore> {
    return new BookStore(await BookFiles.at(workspace), hooks)
  }

  private folder(bookId: string): string { return join(ROOT, idSchema.parse(bookId)) }
  private manifest(bookId: string): string { return join(this.folder(bookId), 'project.json') }
  private chapterPath(bookId: string, chapterId: string): string { return join(this.folder(bookId), 'chapters', `${idSchema.parse(chapterId)}.md`) }
  private transactionPath(bookId: string, operationId: string): string { return join(this.folder(bookId), 'transactions', `${idSchema.parse(operationId)}.json`) }
  private pendingPath(bookId: string): string { return join(this.folder(bookId), 'pending.json') }
  private creationPath(bookId: string): string { return join(ROOT, `${idSchema.parse(bookId)}.creation.json`) }

  private async creation(bookId: string): Promise<Transaction[]> {
    const file = await this.files.read(this.creationPath(bookId))
    if (!file.exists) return []
    const transaction = this.parseTransaction(file.text, bookId)
    if (transaction.before || transaction.changes.length || transaction.after.revision !== 1 || transaction.after.chapters.length || transaction.operationId !== bookId) throw new BookError('invalid-format')
    return [transaction]
  }

  private async transactions(bookId: string): Promise<Transaction[]> {
    const file = await this.files.read(this.pendingPath(bookId), 32 * 1024 * 1024)
    if (!file.exists) return []
    const transaction = this.parseTransaction(file.text, bookId)
    if (transaction.state !== 'prepared') throw new BookError('invalid-format')
    return [transaction]
  }

  private parseTransaction(text: string, bookId: string): Transaction {
    let value: unknown
    try { value = JSON.parse(text) } catch { throw new BookError('invalid-format') }
    if (typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion !== 1) throw new BookError('unsupported-format')
    let transaction: Transaction
    try { transaction = transactionSchema.parse(value) } catch { throw new BookError('invalid-format') }
    if (transaction.bookId !== bookId || transaction.after.bookId !== bookId) throw new BookError('invalid-format')
    for (const change of transaction.changes) {
      if (transaction.after.chapters.find(chapter => chapter.chapterId === change.chapterId)?.hash !== hash(change.after)) throw new BookError('invalid-format')
    }
    if (transaction.before) parseBook(transaction.before, bookId)
    return transaction
  }

  async list(): Promise<BookSnapshot[]> {
    const root = await this.files.path(ROOT)
    let names: string[]
    try { names = await readdir(root) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const books: BookSnapshot[] = []
    const ids = new Set(names.map(name => name.endsWith('.creation.json') ? name.slice(0, -14) : name).filter(name => idSchema.safeParse(name).success))
    for (const name of [...ids].sort()) books.push(await this.readBook(name))
    return books
  }

  async readBook(bookId: string): Promise<BookSnapshot> {
    const file = await this.files.read(this.manifest(bookId))
    const pending = (await this.transactions(bookId)).find(item => item.state === 'prepared')
    const creating = (await this.creation(bookId))[0]
    if (!file.exists) {
      if (pending || creating) return snapshot((pending ?? creating)!.after, true)
      throw new BookError('book-not-found')
    }
    return snapshot(parseBook(file.text, bookId), !!pending || !!creating)
  }

  async readChapter(bookId: string, chapterId: string): Promise<ChapterText> {
    const book = await this.readBook(bookId)
    if (book.recoveryRequired) throw new BookError('recovery-required')
    const chapter = book.chapters.find(item => item.chapterId === idSchema.parse(chapterId))
    if (!chapter) throw new BookError('chapter-not-found')
    const file = await this.files.read(this.chapterPath(bookId, chapterId))
    if (!file.exists) throw new BookError('chapter-not-found')
    const digest = hash(file.text)
    const latest = await this.readBook(bookId)
    if (latest.recoveryRequired) throw new BookError('recovery-required')
    if (latest.revision !== book.revision) throw new BookError('revision-conflict')
    return { book, chapterId, content: file.text, hash: digest, externallyModified: digest !== chapter.hash }
  }

  async createBook(input: CreateBookRequest, signal: AbortSignal): Promise<BookSnapshot> {
    const request = z.strictObject({ operationId: idSchema, title: titleSchema }).parse(input)
    signal.throwIfAborted()
    await this.files.directory(ROOT)
    return await this.files.lock(join(ROOT, '.create.lock'), async () => {
      const bookId = request.operationId
      const requestHash = hash(json(request))
      const intent = (await this.creation(bookId))[0]
      if (intent) {
        if (intent.requestHash !== requestHash) throw new BookError('operation-conflict')
        throw new BookError('recovery-required')
      }
      const existing = await this.files.read(this.manifest(bookId))
      if (existing.exists || (await this.transactions(bookId)).length) return await this.replay(bookId, request.operationId, requestHash)
      const folder = await this.files.path(this.folder(bookId))
      try { await readdir(folder); throw new BookError('operation-conflict') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const book: Book = { schemaVersion: 1, bookId, title: request.title, revision: 1, chapters: [] }
      const transaction: Transaction = { schemaVersion: 1, operationId: request.operationId, bookId, requestHash, state: 'prepared', before: '', after: book, changes: [] }
      await this.files.replace(this.creationPath(bookId), json(transaction), { exists: false, text: '' })
      await this.hooks.afterStage?.('creation')
      return await this.initialize(transaction, signal)
    })
  }

  private async initialize(transaction: Transaction, signal: AbortSignal): Promise<BookSnapshot> {
    const bookId = transaction.bookId
    await this.files.directory(this.folder(bookId))
    return await this.files.lock(join(this.folder(bookId), '.write.lock'), async () => {
      await this.prepareDirectories(bookId)
      const pending = (await this.transactions(bookId))[0]
      const receipt = await this.files.read(this.transactionPath(bookId, transaction.operationId), 32 * 1024 * 1024)
      if (pending) await this.publish(pending)
      else if (!receipt.exists) await this.commit(transaction, signal)
      else if (receipt.text !== json({ ...transaction, state: 'completed' })) throw new BookError('operation-conflict')
      await this.files.remove(this.creationPath(bookId), { exists: true, text: json(transaction) })
      return await this.readBook(bookId)
    })
  }

  private async prepareDirectories(bookId: string): Promise<void> {
    await this.files.directory(join(this.folder(bookId), 'chapters'))
    await this.files.directory(join(this.folder(bookId), 'transactions'))
  }

  private async replay(bookId: string, operationId: string, requestHash: string): Promise<BookSnapshot> {
    const file = await this.files.read(this.transactionPath(bookId, operationId), 32 * 1024 * 1024)
    const pending = (await this.transactions(bookId)).find(item => item.operationId === operationId)
    if (pending) throw new BookError(pending.requestHash === requestHash ? 'recovery-required' : 'operation-conflict')
    if (!file.exists) throw new BookError('operation-conflict')
    const previous = this.parseTransaction(file.text, bookId)
    if (previous.operationId !== operationId || previous.requestHash !== requestHash) throw new BookError('operation-conflict')
    if (previous.state !== 'completed') throw new BookError('recovery-required')
    return snapshot(previous.after)
  }

  /** Pure receipt lookup used to reconcile a proposal after an interrupted adoption. */
  async receipt(bookId: string, operationId: string): Promise<Transaction[]> {
    const file = await this.files.read(this.transactionPath(bookId, operationId), 32 * 1024 * 1024)
    if (!file.exists) return []
    const receipt = this.parseTransaction(file.text, bookId)
    if (receipt.operationId !== operationId || receipt.state !== 'completed') throw new BookError('invalid-format')
    return [receipt]
  }

  async mutate(input: ChapterMutationRequest, signal: AbortSignal, source?: Transaction['source']): Promise<BookSnapshot> {
    const request = mutationSchema.parse(input)
    if (request.action !== 'create' && (request.kind !== undefined || request.linkedChapterId !== undefined)) throw new BookError('invalid-request')
    const origin = source ? transactionSourceSchema.parse(source) : undefined
    return await this.files.lock(join(this.folder(request.bookId), '.write.lock'), async () => {
      signal.throwIfAborted()
      const items = await this.transactions(request.bookId)
      if ((await this.creation(request.bookId)).length) throw new BookError('recovery-required')
      const requestHash = origin ? hash(json({ request, source: origin })) : hash(json(request))
      if (items.some(item => item.operationId === request.operationId) || (await this.files.read(this.transactionPath(request.bookId, request.operationId), 32 * 1024 * 1024)).exists) return await this.replay(request.bookId, request.operationId, requestHash)
      if (items.some(item => item.state === 'prepared')) throw new BookError('recovery-required')
      const file = await this.files.read(this.manifest(request.bookId))
      if (!file.exists) throw new BookError('book-not-found')
      const book = parseBook(file.text, request.bookId)
      if (book.revision !== request.expectedRevision) throw new BookError('revision-conflict')
      const next = structuredClone(book)
      next.revision++
      const changes: Transaction['changes'] = []
      const chapter = next.chapters.find(item => item.chapterId === request.chapterId)
      if (request.action === 'create') {
        if (chapter) throw new BookError('operation-conflict')
        const before = await this.files.read(this.chapterPath(book.bookId, request.chapterId))
        if (before.exists) throw new BookError('revision-conflict')
        next.chapters.push({ chapterId: request.chapterId, title: titleSchema.parse(request.title), revision: 1, hash: hash(request.content),
          ...(request.kind ? { kind: request.kind } : {}), ...(request.linkedChapterId ? { linkedChapterId: request.linkedChapterId } : {}) })
        changes.push({ chapterId: request.chapterId, before, after: request.content })
      } else {
        if (!chapter) throw new BookError('chapter-not-found')
        if (request.action === 'rename') chapter.title = titleSchema.parse(request.title)
        if (request.action === 'move') {
          if (request.beforeChapterId === request.chapterId) throw new BookError('invalid-request')
          next.chapters = next.chapters.filter(item => item.chapterId !== request.chapterId)
          const at = request.beforeChapterId ? next.chapters.findIndex(item => item.chapterId === request.beforeChapterId) : next.chapters.length
          if (at < 0) throw new BookError('chapter-not-found')
          next.chapters.splice(at, 0, chapter)
        }
        if (request.action === 'save') {
          const before = await this.files.read(this.chapterPath(book.bookId, chapter.chapterId))
          if (!before.exists || hash(before.text) !== request.expectedHash) throw new BookError('revision-conflict')
          changes.push({ chapterId: chapter.chapterId, before, after: request.content })
          chapter.hash = hash(request.content)
          chapter.revision++
        }
      }
      // Revalidate generated data too: limits are enforced before a journal is published.
      parseBook(json(next), book.bookId)
      return await this.commit({ schemaVersion: 1, operationId: request.operationId, bookId: book.bookId, requestHash, state: 'prepared', before: file.text, after: next, changes, ...(origin ? { source: origin } : {}) }, signal)
    })
  }

  private async commit(transaction: Transaction, signal: AbortSignal): Promise<BookSnapshot> {
    signal.throwIfAborted()
    if (Buffer.byteLength(json(transaction.after), 'utf8') > 4 * 1024 * 1024 ||
      Buffer.byteLength(json({ ...transaction, state: 'completed' }), 'utf8') > 32 * 1024 * 1024) throw new BookError('too-large')
    const path = this.pendingPath(transaction.bookId)
    await this.files.replace(path, json(transaction), { exists: false, text: '' })
    await this.hooks.afterStage?.('prepared')
    // After preparation, finish or leave a recoverable journal before honoring cancellation.
    await this.publish(transaction)
    return snapshot(transaction.after)
  }

  private async publish(transaction: Transaction): Promise<void> {
    const states = []
    for (const change of transaction.changes) {
      const current = await this.files.read(this.chapterPath(transaction.bookId, change.chapterId))
      if (!(current.exists === change.before.exists && current.text === change.before.text) && !(current.exists && current.text === change.after)) throw new BookError('recovery-conflict')
      states.push({ change, current })
    }
    const manifest = await this.files.read(this.manifest(transaction.bookId))
    const after = json(transaction.after)
    if (!(manifest.exists === (transaction.before !== '') && manifest.text === transaction.before) && !(manifest.exists && manifest.text === after)) throw new BookError('recovery-conflict')
    for (const { change, current } of states) {
      if (!current.exists || current.text !== change.after) await this.files.replace(this.chapterPath(transaction.bookId, change.chapterId), change.after, current)
      await this.hooks.afterStage?.('chapter')
    }
    for (const { change } of states) {
      const current = await this.files.read(this.chapterPath(transaction.bookId, change.chapterId))
      if (!current.exists || current.text !== change.after) throw new BookError('recovery-conflict')
    }
    if (!manifest.exists || manifest.text !== after) await this.files.replace(this.manifest(transaction.bookId), after, manifest)
    await this.hooks.afterStage?.('manifest')
    const path = this.transactionPath(transaction.bookId, transaction.operationId)
    const completed = json({ ...transaction, state: 'completed' })
    const receipt = await this.files.read(path, 32 * 1024 * 1024)
    if (receipt.exists && receipt.text !== completed) throw new BookError('operation-conflict')
    if (!receipt.exists) await this.files.replace(path, completed, receipt)
    await this.files.remove(this.pendingPath(transaction.bookId), { exists: true, text: json(transaction) })
    await this.hooks.afterStage?.('completed')
  }

  async recover(bookId: string, signal: AbortSignal): Promise<BookSnapshot> {
    const creating = (await this.creation(bookId))[0]
    if (creating) return await this.files.lock(join(ROOT, '.create.lock'), async () => {
      const current = (await this.creation(bookId))[0]
      return current ? await this.initialize(current, signal) : await this.readBook(bookId)
    })
    return await this.files.lock(join(this.folder(bookId), '.write.lock'), async () => {
      signal.throwIfAborted()
      const transaction = (await this.transactions(bookId)).find(item => item.state === 'prepared')
      if (transaction) await this.publish(transaction)
      return await this.readBook(bookId)
    })
  }

  /** Explicit recovery only; the interrupted intention stays in an immutable archive. */
  async interrupted(bookId: string): Promise<InterruptedChapterSave> {
    const pending = await this.files.read(this.pendingPath(bookId), 32 * 1024 * 1024)
    if (!pending.exists) throw new BookError('recovery-not-found')
    const transaction = this.parseTransaction(pending.text, bookId)
    if (transaction.changes.length !== 1 || (await this.creation(bookId)).length) throw new BookError('recovery-manual')
    const change = transaction.changes[0]!
    const file = await this.files.read(this.chapterPath(bookId, change.chapterId))
    if (!file.exists) throw new BookError('chapter-not-found')
    return { bookId, chapterId: change.chapterId, pendingHash: hash(pending.text), diskHash: hash(file.text), diskContent: file.text, preparedContent: change.after }
  }

  async settleInterrupted(input: SettleInterruptedSaveRequest, signal: AbortSignal): Promise<BookSnapshot> {
    const digest = z.string().regex(/^[a-f0-9]{64}$/)
    const request = z.strictObject({ operationId: idSchema, bookId: idSchema, pendingHash: digest, diskHash: digest, content: contentSchema }).parse(input)
    return await this.files.lock(join(this.folder(request.bookId), '.write.lock'), async () => {
      signal.throwIfAborted()
      const requestHash = hash(json(request))
      const pending = await this.files.read(this.pendingPath(request.bookId), 32 * 1024 * 1024)
      const receipt = await this.files.read(this.transactionPath(request.bookId, request.operationId), 32 * 1024 * 1024)
      if (receipt.exists) return await this.replay(request.bookId, request.operationId, requestHash)
      if (!pending.exists) throw new BookError('recovery-not-found')
      const original = this.parseTransaction(pending.text, request.bookId)
      if (original.operationId === request.operationId) {
        if (original.requestHash !== requestHash) throw new BookError('operation-conflict')
        await this.publish(original)
        return snapshot(original.after)
      }
      if (hash(pending.text) !== request.pendingHash) throw new BookError('revision-conflict')
      if (original.changes.length !== 1 || (await this.creation(request.bookId)).length) throw new BookError('recovery-manual')
      const manifest = await this.files.read(this.manifest(request.bookId))
      if (!manifest.exists || (manifest.text !== original.before && manifest.text !== json(original.after))) throw new BookError('recovery-conflict')
      const chapterId = original.changes[0]!.chapterId
      const disk = await this.files.read(this.chapterPath(request.bookId, chapterId))
      if (!disk.exists || hash(disk.text) !== request.diskHash) throw new BookError('revision-conflict')
      const next = parseBook(manifest.text, request.bookId)
      next.revision = Math.max(next.revision, original.after.revision) + 1
      let chapter = next.chapters.find(item => item.chapterId === chapterId)
      const prepared = original.after.chapters.find(item => item.chapterId === chapterId)!
      if (!chapter) { chapter = { ...prepared }; next.chapters.push(chapter) }
      chapter.revision = Math.max(chapter.revision, prepared.revision) + 1
      chapter.hash = hash(request.content)
      parseBook(json(next), request.bookId)
      const replacement: Transaction = { schemaVersion: 1, operationId: request.operationId, bookId: request.bookId,
        requestHash, state: 'prepared', before: manifest.text, after: next, changes: [{ chapterId, before: disk, after: request.content }] }
      const text = json(replacement)
      if (Buffer.byteLength(text, 'utf8') > 32 * 1024 * 1024 || Buffer.byteLength(json(next), 'utf8') > 4 * 1024 * 1024) throw new BookError('too-large')
      const folder = join(this.folder(request.bookId), 'recoveries')
      await this.files.directory(folder)
      const archive = join(folder, `${original.operationId}.json`)
      const retained = await this.files.read(archive, 32 * 1024 * 1024)
      if (retained.exists && retained.text !== pending.text) throw new BookError('operation-conflict')
      if (!retained.exists) await this.files.replace(archive, pending.text, retained)
      // Replacing the pending journal is the only transition; interruption on either side is recoverable.
      await this.files.replace(this.pendingPath(request.bookId), text, pending)
      await this.hooks.afterStage?.('prepared')
      await this.publish(replacement)
      return snapshot(next)
    })
  }

  /** Existing receipts form the immutable history; no secondary history write is required. */
  async *receipts(bookId: string): AsyncGenerator<Transaction, void> {
    const folder = await this.files.path(join(this.folder(bookId), 'transactions'))
    let names: string[]
    try { names = await readdir(folder) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const name of names) {
      if (name.endsWith('.json') && idSchema.safeParse(name.slice(0, -5)).success) {
        for (const receipt of await this.receipt(bookId, name.slice(0, -5))) yield receipt
      }
    }
  }
}
