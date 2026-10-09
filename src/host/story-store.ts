import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { BookError, hash, idSchema, json, availableDocument } from '../domain/books.js'
import { eventSchema, foreshadowSchema, saveStorySchema, storyOutputSchema, suggestStorySchema } from '../domain/story-state.js'
import type { BookSnapshot, ChapterText, StoryEvidence, StoryEvent, Foreshadow, StoryState, SaveStoryStateRequest, StoryContext, SuggestStoryStateRequest, StoryStateSuggestion } from '../types.js'
import { BookFiles } from './book-files.js'
import { BookStore } from './book-store.js'
import type { TextGenerator } from './chapter-generator.js'

const recordSchema = z.strictObject({ format: z.literal('super-novel-story-state'), version: z.literal(1), request: saveStorySchema, events: z.array(eventSchema).max(1000), foreshadows: z.array(foreshadowSchema).max(1000), updatedAt: z.int().nonnegative() })
const suggestionSchema = z.strictObject({ format: z.literal('super-novel-story-suggestion'), version: z.literal(1), request: suggestStorySchema, sourceRevision: z.int().positive(), events: z.array(eventSchema).max(50), foreshadows: z.array(foreshadowSchema).max(50), createdAt: z.int().nonnegative(), elapsedMs: z.int().nonnegative(), usage: z.discriminatedUnion('state', [z.strictObject({ state: z.literal('unknown') }), z.strictObject({ state: z.literal('reported'), inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative(), cacheReadTokens: z.int().nonnegative().optional(), cacheWriteTokens: z.int().nonnegative().optional(), totalTokens: z.int().nonnegative().optional(), reasoningTokens: z.int().nonnegative().optional() })]) })
type Ledger = { version: number; events: StoryEvent[]; foreshadows: Foreshadow[] }
type Suggestion = z.infer<typeof suggestionSchema>

/** Author-confirmed evidence ledger, independent from character cards and prose. */
export class StoryStore {
  private constructor(private readonly files: BookFiles, private readonly books: BookStore, private readonly workspaceId: string) {}
  static async at(root: string, workspaceId: string, books: BookStore): Promise<StoryStore> { return new StoryStore(await BookFiles.at(root), books, workspaceId) }
  private folder(bookId: string): string { return join('novels', idSchema.parse(bookId), 'story-state') }
  private parse(text: string, bookId: string, version: number): Ledger {
    let raw: unknown
    try { raw = JSON.parse(text) } catch { throw new BookError('invalid-format') }
    if (raw && typeof raw === 'object' && 'version' in raw && raw.version !== 1) throw new BookError('unsupported-format')
    const result = recordSchema.safeParse(raw)
    if (!result.success) throw new BookError('invalid-format')
    const value = result.data
    if (value.request.workspaceId !== this.workspaceId || value.request.bookId !== bookId || value.request.expectedVersion + 1 !== version ||
      new Set(value.events.map(item => item.eventId)).size !== value.events.length || new Set(value.foreshadows.map(item => item.foreshadowId)).size !== value.foreshadows.length ||
      value.request.event && !value.events.some(item => json(item) === json(value.request.event)) ||
      value.request.foreshadow && !value.foreshadows.some(item => json(item) === json(value.request.foreshadow))) throw new BookError('invalid-format')
    return { version, events: value.events, foreshadows: value.foreshadows }
  }
  private async ledger(bookId: string): Promise<Ledger> {
    await this.books.readBook(bookId)
    let names: string[]
    try { names = await readdir(await this.files.path(this.folder(bookId))) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 0, events: [], foreshadows: [] }; throw error }
    const versions = names.filter(name => /^\d{8}\.json$/.test(name)).sort()
    if (!versions.length) return { version: 0, events: [], foreshadows: [] }
    const last = versions.at(-1)!, version = Number(last.slice(0, 8))
    if (versions.length > 100_000) throw new BookError('too-large')
    if (versions.some((name, index) => name !== `${String(index + 1).padStart(8, '0')}.json`)) throw new BookError('invalid-format')
    return this.parse((await this.files.read(join(this.folder(bookId), last))).text, bookId, version)
  }
  private async validEvidence(bookId: string, evidence: StoryEvidence, sources = new Map<string, ChapterText>()): Promise<boolean> {
    let source = sources.get(evidence.chapterId)
    if (!source) {
      source = await this.books.readChapter(bookId, evidence.chapterId)
      // Repeated quotes share a source snapshot; at most eight full chapters stay
      // in memory. This cache never outlives a single read operation.
      if (sources.size < 8) sources.set(evidence.chapterId, source)
    }
    const document = source.book.chapters.find(item => item.chapterId === evidence.chapterId)!
    return (!document.kind || document.kind === 'chapter') && source.hash === evidence.hash && document.revision === evidence.revision && !source.externallyModified &&
      evidence.end <= source.content.length && source.content.slice(evidence.start, evidence.end) === evidence.quote
  }
  private async requireEvidence(bookId: string, evidence: StoryEvidence): Promise<void> { if (!await this.validEvidence(bookId, evidence)) throw new BookError('invalid-evidence') }
  async read(bookId: string): Promise<StoryState> {
    const book = await this.books.readBook(bookId)
    if (book.recoveryRequired) throw new BookError('recovery-required')
    const value = await this.ledger(bookId), events: StoryState['events'][number][] = [], foreshadows: StoryState['foreshadows'][number][] = []
    const prose = book.chapters.filter(item => !item.kind || item.kind === 'chapter')
    const sources = new Map<string, ChapterText>()
    for (const event of value.events) events.push({ ...event, state: await this.validEvidence(bookId, event.evidence, sources) && event.changes.every(change => book.chapters.some(item => item.chapterId === change.characterId && item.kind === 'character' && availableDocument(item))) ? 'valid' : 'expired', narrativeOrder: prose.findIndex(item => item.chapterId === event.evidence.chapterId) })
    for (const item of value.foreshadows) {
      const ordered = !item.resolved || prose.findIndex(chapter => chapter.chapterId === item.resolved!.chapterId) > prose.findIndex(chapter => chapter.chapterId === item.planted!.chapterId) ||
        item.resolved.chapterId === item.planted!.chapterId && item.resolved.start >= item.planted!.start
      foreshadows.push({ ...item, state: ordered && (!item.planted || await this.validEvidence(bookId, item.planted, sources)) && (!item.resolved || await this.validEvidence(bookId, item.resolved, sources)) ? 'valid' : 'expired' })
    }
    if ((await this.books.readBook(bookId)).revision !== book.revision) throw new BookError('revision-conflict')
    return { bookId, version: value.version, events: events.sort((a, b) => a.narrativeOrder - b.narrativeOrder || a.evidence.start - b.evidence.start || a.eventId.localeCompare(b.eventId)), foreshadows }
  }
  private validateCharacters(book: BookSnapshot, event: StoryEvent): void {
    if (event.changes.some(change => !book.chapters.some(item => item.chapterId === change.characterId && item.kind === 'character' && availableDocument(item)))) throw new BookError('invalid-material')
  }
  async save(input: SaveStoryStateRequest, signal: AbortSignal): Promise<StoryState> {
    const request = saveStorySchema.parse(input)
    if (request.workspaceId !== this.workspaceId) throw new BookError('location-changed')
    return await this.files.lock(join('novels', request.bookId, '.story.lock'), async () => {
      signal.throwIfAborted()
      const path = join(this.folder(request.bookId), `${String(request.expectedVersion + 1).padStart(8, '0')}.json`), before = await this.files.read(path)
      if (before.exists) {
        const previous = recordSchema.parse(JSON.parse(before.text))
        if (previous.request.operationId !== request.operationId) throw new BookError('revision-conflict')
        if (json(previous.request) !== json(request)) throw new BookError('operation-conflict')
        return await this.read(request.bookId)
      }
      const book = await this.books.readBook(request.bookId), current = await this.ledger(request.bookId)
      if (book.recoveryRequired) throw new BookError('recovery-required')
      if (book.revision !== request.expectedRevision || current.version !== request.expectedVersion) throw new BookError('revision-conflict')
      if (current.version >= 100_000) throw new BookError('too-large')
      if (request.event) { await this.requireEvidence(request.bookId, request.event.evidence); this.validateCharacters(book, request.event); current.events = [...current.events.filter(item => item.eventId !== request.event!.eventId), request.event] }
      if (request.foreshadow) {
        const item = request.foreshadow
        if (item.planted) await this.requireEvidence(request.bookId, item.planted)
        if (item.resolved) {
          await this.requireEvidence(request.bookId, item.resolved)
          const plantedAt = book.chapters.findIndex(chapter => chapter.chapterId === item.planted!.chapterId), resolvedAt = book.chapters.findIndex(chapter => chapter.chapterId === item.resolved!.chapterId)
          if (resolvedAt < plantedAt || resolvedAt === plantedAt && item.resolved.start < item.planted!.start) throw new BookError('invalid-evidence')
        }
        current.foreshadows = [...current.foreshadows.filter(previous => previous.foreshadowId !== item.foreshadowId), item]
      }
      const record = recordSchema.parse({ format: 'super-novel-story-state', version: 1, request, events: current.events, foreshadows: current.foreshadows, updatedAt: Date.now() }), text = json(record)
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new BookError('too-large')
      signal.throwIfAborted(); await this.files.directory(this.folder(request.bookId)); await this.files.replace(path, text, before)
      return await this.read(request.bookId)
    })
  }
  async context(bookId: string, chapterId: string, scope: string): Promise<StoryContext> {
    const book = await this.books.readBook(bookId), at = book.chapters.findIndex(item => item.chapterId === idSchema.parse(chapterId))
    if (at < 0 || book.chapters[at]!.kind && book.chapters[at]!.kind !== 'chapter') throw new BookError('invalid-material')
    if (scope !== 'reader' && !book.chapters.some(item => item.chapterId === scope && item.kind === 'character' && availableDocument(item))) throw new BookError('invalid-material')
    const state = await this.read(bookId), prior = new Set(book.chapters.slice(0, at).filter(item => !item.kind || item.kind === 'chapter').map(item => item.chapterId))
    const relevant = state.events.filter(item => prior.has(item.evidence.chapterId) && (scope === 'reader' || item.changes.some(change => change.characterId === scope)))
    const foreshadows = scope === 'reader' ? state.foreshadows.filter(item => item.planted && prior.has(item.planted.chapterId)) : []
    // Character-scoped input contains only confirmed values for that character. Quotes
    // and mixed event titles remain available in the author's evidence panel, not here.
    const events = relevant.map(item => scope === 'reader' ? { eventId: item.eventId, title: item.title, time: item.time, evidence: item.evidence, changes: item.changes } :
      { eventId: item.eventId, time: item.time, source: { chapterId: item.evidence.chapterId, revision: item.evidence.revision, hash: item.evidence.hash, start: item.evidence.start, end: item.evidence.end }, changes: item.changes.filter(change => change.characterId === scope) })
    const threads = foreshadows.map(item => ({ foreshadowId: item.foreshadowId, title: item.title, status: item.resolved && !prior.has(item.resolved.chapterId) ? 'unresolved' : item.status,
      planted: item.planted, ...(item.resolved && prior.has(item.resolved.chapterId) ? { resolved: item.resolved } : {}) }))
    const content = json({ events, foreshadows: threads, boundary: 'Author-confirmed changes with exact prose sources. Unknown time stays unknown. Chronology and semantic meaning still require author judgment. Planned foreshadows and future resolutions are excluded.' }), bytes = Buffer.byteLength(content)
    let expired = relevant.some(item => item.state === 'expired')
    const sources = new Map<string, ChapterText>()
    for (const item of foreshadows) if (!await this.validEvidence(bookId, item.planted!, sources) || item.resolved && prior.has(item.resolved.chapterId) && item.state === 'expired') expired = true
    if ((await this.books.readBook(bookId)).revision !== book.revision) throw new BookError('revision-conflict')
    return { content, hash: hash(content), bytes, state: expired ? 'expired' : bytes > 128 * 1024 ? 'over-budget' : 'ready' }
  }
  private suggestionPath(bookId: string, id: string): string { return join('novels', idSchema.parse(bookId), 'story-proposals', `${idSchema.parse(id)}.json`) }
  private parseSuggestion(text: string, bookId: string, id: string): Suggestion {
    let raw: unknown
    try { raw = JSON.parse(text) } catch { throw new BookError('invalid-format') }
    if (raw && typeof raw === 'object' && 'version' in raw && raw.version !== 1) throw new BookError('unsupported-format')
    const result = suggestionSchema.safeParse(raw)
    if (!result.success) throw new BookError('invalid-format')
    const value = result.data
    if (value.request.workspaceId !== this.workspaceId || value.request.bookId !== bookId || value.request.proposalId !== id) throw new BookError('invalid-format')
    const sources = [...value.events.map(item => item.evidence), ...value.foreshadows.map(item => item.planted!)]
    if (value.events.some(item => item.time.kind !== 'unknown') || value.foreshadows.some(item => item.status !== 'planted') ||
      sources.some(item => item.chapterId !== value.request.chapterId || item.hash !== value.request.expectedHash || item.revision !== value.sourceRevision)) throw new BookError('invalid-format')
    return value
  }
  private async suggestionView(value: Suggestion): Promise<StoryStateSuggestion> {
    const source = await this.books.readChapter(value.request.bookId, value.request.chapterId)
    return { proposalId: value.request.proposalId, bookId: value.request.bookId, chapterId: value.request.chapterId, sourceHash: value.request.expectedHash, events: value.events, foreshadows: value.foreshadows, createdAt: value.createdAt, usage: value.usage, elapsedMs: value.elapsedMs,
      state: source.hash === value.request.expectedHash && !source.externallyModified && !source.book.recoveryRequired && value.sourceRevision === source.book.chapters.find(chapter => chapter.chapterId === value.request.chapterId)!.revision &&
        value.events.every(item => item.evidence.quote === source.content.slice(item.evidence.start, item.evidence.end) && item.changes.every(change => source.book.chapters.some(chapter => chapter.chapterId === change.characterId && chapter.kind === 'character' && availableDocument(chapter)))) &&
        value.foreshadows.every(item => item.planted!.quote === source.content.slice(item.planted!.start, item.planted!.end)) ? 'review' : 'expired' }
  }
  async suggestions(bookId: string, chapterId: string): Promise<StoryStateSuggestion[]> {
    await this.books.readChapter(bookId, chapterId); const folder = join('novels', idSchema.parse(bookId), 'story-proposals'); let names: string[]
    try { names = await readdir(await this.files.path(folder)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    if (names.length > 10_000) throw new BookError('too-large')
    const results: StoryStateSuggestion[] = []
    for (const name of names) if (name.endsWith('.json') && idSchema.safeParse(name.slice(0, -5)).success) {
      const value = this.parseSuggestion((await this.files.read(join(folder, name))).text, bookId, name.slice(0, -5))
      if (value.request.chapterId === chapterId) results.push(await this.suggestionView(value))
    }
    return results.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
  }
  async suggest(input: SuggestStoryStateRequest, generate: TextGenerator, signal: AbortSignal): Promise<StoryStateSuggestion> {
    const request = suggestStorySchema.parse(input)
    if (request.workspaceId !== this.workspaceId) throw new BookError('location-changed')
    const path = this.suggestionPath(request.bookId, request.proposalId), before = await this.files.read(path)
    if (before.exists) {
      const value = this.parseSuggestion(before.text, request.bookId, request.proposalId)
      if (json(value.request) !== json(request)) throw new BookError('operation-conflict')
      return await this.suggestionView(value)
    }
    const source = await this.books.readChapter(request.bookId, request.chapterId), document = source.book.chapters.find(item => item.chapterId === request.chapterId)!
    if (source.book.recoveryRequired) throw new BookError('recovery-required')
    if (document.kind && document.kind !== 'chapter') throw new BookError('invalid-material')
    if (source.book.revision !== request.expectedRevision || source.hash !== request.expectedHash || source.externallyModified) throw new BookError('revision-conflict')
    const prompt = json({ task: 'suggest-chapter-state', chapter: source.content, characters: source.book.chapters.filter(item => item.kind === 'character' && availableDocument(item)).map(item => ({ characterId: item.chapterId, title: item.title })), format: { events: [{ title: 'Event', evidence: { start: 0, end: 1, quote: 'Exact substring' }, changes: [{ characterId: 'supplied UUID', kind: 'location | injury | item | knowledge', value: 'Explicit change' }] }], foreshadows: [{ title: 'Possible planted clue', note: 'Author should check', evidence: { start: 0, end: 1, quote: 'Exact substring' } }] } })
    if (Buffer.byteLength(prompt) > 256 * 1024) throw new BookError('context-too-large')
    const started = Date.now(), result = await generate(prompt, 'Return only strict JSON matching format in the chapter language. Suggest explicit events and character changes supported by exact UTF-16 quote ranges in saved prose. Use supplied character IDs only. Do not invent dates, off-page events, knowledge or resources. Omit unknown changes. Foreshadows are suggestions for author confirmation, never automatically resolved. No tools or code fences.', signal, async () => {})
    if (!result.complete) throw new BookError(result.reason || 'generation-failed')
    let raw: unknown
    try { raw = JSON.parse(result.replacement) } catch { throw new BookError('invalid-output') }
    const parsed = storyOutputSchema.safeParse(raw)
    if (!parsed.success) throw new BookError('invalid-output')
    const output = parsed.data, evidence = (item: { start: number; end: number; quote: string }): StoryEvidence => ({ ...item, chapterId: request.chapterId, revision: document.revision, hash: source.hash })
    const events = output.events.map(item => ({ ...item, eventId: randomUUID(), time: { kind: 'unknown' as const }, evidence: evidence(item.evidence) })), foreshadows = output.foreshadows.map(item => ({ foreshadowId: randomUUID(), title: item.title, note: item.note, status: 'planted' as const, planted: evidence(item.evidence) }))
    for (const item of events) { this.validateCharacters(source.book, item); if (source.content.slice(item.evidence.start, item.evidence.end) !== item.evidence.quote) throw new BookError('invalid-evidence') }
    for (const item of foreshadows) if (source.content.slice(item.planted.start, item.planted.end) !== item.planted.quote) throw new BookError('invalid-evidence')
    const value = suggestionSchema.parse({ format: 'super-novel-story-suggestion', version: 1, request, sourceRevision: document.revision, events, foreshadows, createdAt: Date.now(), elapsedMs: Date.now() - started, usage: result.usage })
    const text = json(value)
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new BookError('too-large')
    return await this.files.lock(join('novels', request.bookId, '.story.lock'), async () => {
      signal.throwIfAborted(); const file = await this.files.read(path)
      if (file.exists) { const previous = this.parseSuggestion(file.text, request.bookId, request.proposalId); if (json(previous.request) !== json(request)) throw new BookError('operation-conflict'); return await this.suggestionView(previous) }
      await this.files.directory(join('novels', request.bookId, 'story-proposals')); await this.files.replace(path, text, file)
      return await this.suggestionView(value)
    })
  }
}
