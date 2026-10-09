import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { BookError, hash, idSchema, json } from '../domain/books.js'
import { directionsSchema, emptyIntent, saveIntentSchema, suggestIntentSchema } from '../domain/intents.js'
import type { ChapterIntent, IntentSuggestion, SaveIntentRequest, SuggestIntentRequest } from '../types.js'
import { BookFiles } from './book-files.js'
import { BookStore } from './book-store.js'
import type { TextGenerator } from './chapter-generator.js'

const recordSchema = z.strictObject({ format: z.literal('super-novel-intent'), version: z.literal(1), request: saveIntentSchema, updatedAt: z.int().nonnegative() })
const suggestionSchema = z.strictObject({ format: z.literal('super-novel-directions'), version: z.literal(1), request: suggestIntentSchema, directions: directionsSchema.shape.directions,
  createdAt: z.int().nonnegative(), elapsedMs: z.int().nonnegative(), usage: z.discriminatedUnion('state', [z.strictObject({ state: z.literal('unknown') }), z.strictObject({ state: z.literal('reported'), inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative(), cacheReadTokens: z.int().nonnegative().optional(), cacheWriteTokens: z.int().nonnegative().optional(), totalTokens: z.int().nonnegative().optional(), reasoningTokens: z.int().nonnegative().optional() })]) })
type Suggestion = z.infer<typeof suggestionSchema>

/** Optional author plans: immutable versions, never prose or established facts. */
export class IntentStore {
  private constructor(private readonly files: BookFiles, private readonly books: BookStore, private readonly workspaceId: string) {}
  static async at(root: string, workspaceId: string, books: BookStore): Promise<IntentStore> { return new IntentStore(await BookFiles.at(root), books, workspaceId) }
  private folder(bookId: string, chapterId: string): string { return join('novels', idSchema.parse(bookId), 'intents', idSchema.parse(chapterId)) }
  private async chapter(bookId: string, chapterId: string) {
    const chapter = await this.books.readChapter(bookId, chapterId)
    const kind = chapter.book.chapters.find(item => item.chapterId === chapterId)!.kind
    if (kind && kind !== 'chapter') throw new BookError('invalid-material')
    return chapter
  }
  private parse(text: string, bookId: string, chapterId: string, version: number): ChapterIntent {
    const record = recordSchema.parse(JSON.parse(text)), request = record.request
    if (request.workspaceId !== this.workspaceId || request.bookId !== bookId || request.chapterId !== chapterId || request.expectedVersion + 1 !== version) throw new BookError('invalid-format')
    return { bookId, chapterId, version, intent: request.intent, hash: hash(json(request.intent)), updatedAt: record.updatedAt }
  }
  async read(bookId: string, chapterId: string): Promise<ChapterIntent> {
    await this.chapter(bookId, chapterId)
    let names: string[]
    try { names = await readdir(await this.files.path(this.folder(bookId, chapterId))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = []; else throw error }
    const versions = names.filter(name => /^\d{8}\.json$/.test(name)).sort()
    if (!versions.length) { const intent = emptyIntent(); return { bookId, chapterId, version: 0, intent, hash: hash(json(intent)), updatedAt: 0 } }
    if (versions.length > 100_000) throw new BookError('too-large')
    const last = versions.at(-1)!, version = Number(last.slice(0, 8))
    if (version !== versions.length) throw new BookError('invalid-format')
    return this.parse((await this.files.read(join(this.folder(bookId, chapterId), last))).text, bookId, chapterId, version)
  }
  async save(input: SaveIntentRequest, signal: AbortSignal): Promise<ChapterIntent> {
    const request = saveIntentSchema.parse(input)
    if (request.workspaceId !== this.workspaceId) throw new BookError('location-changed')
    return await this.files.lock(join('novels', request.bookId, '.intent.lock'), async () => {
      signal.throwIfAborted()
      const name = join(this.folder(request.bookId, request.chapterId), `${String(request.expectedVersion + 1).padStart(8, '0')}.json`)
      const before = await this.files.read(name)
      if (before.exists) {
        const previous = recordSchema.parse(JSON.parse(before.text))
        if (previous.request.operationId === request.operationId) {
          if (json(previous.request) !== json(request)) throw new BookError('operation-conflict')
          return this.parse(before.text, request.bookId, request.chapterId, request.expectedVersion + 1)
        }
        throw new BookError('revision-conflict')
      }
      await this.validateSource(request)
      if (request.expectedVersion >= 100_000) throw new BookError('too-large')
      await this.files.directory(this.folder(request.bookId, request.chapterId))
      const text = json({ format: 'super-novel-intent', version: 1, request, updatedAt: Date.now() })
      signal.throwIfAborted()
      await this.files.replace(name, text, before)
      return this.parse(text, request.bookId, request.chapterId, request.expectedVersion + 1)
    })
  }
  private async validateSource(request: SaveIntentRequest | SuggestIntentRequest): Promise<void> {
    const chapter = await this.chapter(request.bookId, request.chapterId)
    if (chapter.book.recoveryRequired) throw new BookError('recovery-required')
    if (chapter.book.revision !== request.expectedRevision || chapter.hash !== request.expectedHash || chapter.externallyModified || (await this.read(request.bookId, request.chapterId)).version !== request.expectedVersion) throw new BookError('revision-conflict')
  }
  private suggestionPath(bookId: string, proposalId: string): string { return join('novels', idSchema.parse(bookId), 'intent-proposals', `${idSchema.parse(proposalId)}.json`) }
  private parseSuggestion(text: string, bookId: string, proposalId: string): Suggestion {
    const value = suggestionSchema.parse(JSON.parse(text))
    if (value.request.workspaceId !== this.workspaceId || value.request.bookId !== bookId || value.request.proposalId !== proposalId) throw new BookError('invalid-format')
    return value
  }
  private async suggestionView(value: Suggestion): Promise<IntentSuggestion> {
    const { request } = value, source = await this.chapter(request.bookId, request.chapterId), intent = await this.read(request.bookId, request.chapterId)
    return { proposalId: request.proposalId, bookId: request.bookId, chapterId: request.chapterId, sourceHash: request.expectedHash, intentVersion: request.expectedVersion,
      directions: value.directions, createdAt: value.createdAt, usage: value.usage, elapsedMs: value.elapsedMs,
      state: source.hash === request.expectedHash && !source.externallyModified && intent.version === request.expectedVersion && !source.book.recoveryRequired ? 'review' : 'expired' }
  }
  async list(bookId: string, chapterId: string): Promise<IntentSuggestion[]> {
    await this.chapter(bookId, chapterId)
    const folder = join('novels', idSchema.parse(bookId), 'intent-proposals'); let names: string[]
    try { names = await readdir(await this.files.path(folder)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const results: IntentSuggestion[] = []
    if (names.length > 10_000) throw new BookError('too-large')
    for (const name of names) if (name.endsWith('.json') && idSchema.safeParse(name.slice(0, -5)).success) {
      const value = this.parseSuggestion((await this.files.read(join(folder, name))).text, bookId, name.slice(0, -5))
      if (value.request.chapterId === chapterId) results.push(await this.suggestionView(value))
    }
    return results.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
  }
  async suggest(input: SuggestIntentRequest, generate: TextGenerator, signal: AbortSignal): Promise<IntentSuggestion> {
    const request = suggestIntentSchema.parse(input)
    if (request.workspaceId !== this.workspaceId) throw new BookError('location-changed')
    // Only capture/publish under the barrier; the paid call does not block writing or backups.
    const before = await this.files.read(this.suggestionPath(request.bookId, request.proposalId))
    if (before.exists) {
      const previous = this.parseSuggestion(before.text, request.bookId, request.proposalId)
      if (json(previous.request) !== json(request)) throw new BookError('operation-conflict')
      return await this.suggestionView(previous)
    }
    await this.validateSource(request)
    const source = await this.chapter(request.bookId, request.chapterId), intent = await this.read(request.bookId, request.chapterId)
    if (source.hash !== request.expectedHash || source.book.revision !== request.expectedRevision || source.externallyModified || intent.version !== request.expectedVersion) throw new BookError('revision-conflict')
    const prompt = json({ task: 'suggest-scene-intent', instruction: request.instruction, chapter: source.content, currentIntent: intent.intent, format: { directions: [emptyIntent()] } })
    if (Buffer.byteLength(prompt) > 256 * 1024) throw new BookError('context-too-large')
    const start = Date.now()
    const result = await generate(prompt, 'Suggest one to three distinct editable directions in the author language. Return only strict JSON matching format. The scene card is optional author planning, not established facts. Preserve all current hardConstraints verbatim in each direction. Do not force conflict into a scene, invent evidence or rewrite saved prose. No tools or code fences.', signal, async () => {})
    if (!result.complete) throw new BookError(result.reason || 'generation-failed')
    const directions = directionsSchema.parse(JSON.parse(result.replacement)).directions
    if (directions.some(direction => direction.hardConstraints !== intent.intent.hardConstraints)) throw new BookError('invalid-output')
    const value = suggestionSchema.parse({ format: 'super-novel-directions', version: 1, request, directions, createdAt: Date.now(), elapsedMs: Date.now() - start, usage: result.usage })
    return await this.files.lock(join('novels', request.bookId, '.intent.lock'), async () => {
      signal.throwIfAborted()
      const path = this.suggestionPath(request.bookId, request.proposalId), file = await this.files.read(path)
      if (file.exists) {
        const previous = this.parseSuggestion(file.text, request.bookId, request.proposalId)
        if (json(previous.request) !== json(request)) throw new BookError('operation-conflict')
        return await this.suggestionView(previous)
      }
      await this.files.directory(join('novels', request.bookId, 'intent-proposals'))
      await this.files.replace(path, json(value), file)
      return await this.suggestionView(value)
    })
  }
}
