import { BookError, hash, idSchema, json } from '../domain/books.js'
import { authorizeVoiceSchema, parseVoice } from '../domain/voice.js'
import type { AuthorizeVoiceRequest, BookSnapshot, VoiceSample } from '../types.js'
import { BookStore } from './book-store.js'
export class VoiceStore {
  constructor(private readonly books: BookStore) {}
  async read(bookId: string, voiceId: string): Promise<VoiceSample> {
    const stored = await this.books.readChapter(bookId, voiceId)
    if (stored.book.chapters.find(item => item.chapterId === voiceId)?.kind !== 'voice') throw new BookError('invalid-material')
    const document = parseVoice(stored.content)
    if (document.voiceId !== voiceId) throw new BookError('invalid-format')
    const source = await this.books.readChapter(bookId, document.sourceChapterId)
    if (source.hash === document.sourceHash && source.content.slice(document.start, document.end) !== document.sample) throw new BookError('invalid-evidence')
    const state = !document.authorized ? 'revoked' : stored.externallyModified || source.externallyModified || source.hash !== document.sourceHash || source.book.chapters.find(item => item.chapterId === document.sourceChapterId)?.revision !== document.sourceRevision ? 'expired' : 'active'
    return { ...document, state, hash: stored.hash }
  }
  async list(bookId: string): Promise<VoiceSample[]> {
    const book = await this.books.readBook(bookId), result: VoiceSample[] = []
    for (const item of book.chapters.filter(item => item.kind === 'voice')) result.push(await this.read(bookId, item.chapterId))
    return result
  }
  async authorize(input: AuthorizeVoiceRequest, signal: AbortSignal): Promise<BookSnapshot> {
    const request = authorizeVoiceSchema.parse(input)
    const source = await this.books.readChapter(request.bookId, request.sourceChapterId)
    const metadata = source.book.chapters.find(item => item.chapterId === request.sourceChapterId)!
    if (metadata.kind && metadata.kind !== 'chapter' || source.externallyModified || source.hash !== request.expectedHash) throw new BookError('revision-conflict')
    if (request.channel === 'dialogue' && !source.book.chapters.some(item => item.chapterId === request.characterId && item.kind === 'character')) throw new BookError('invalid-material')
    const receipt = (await this.books.receipt(request.bookId, request.operationId))[0]
    const authorizedAt = receipt ? parseVoice(receipt.changes[0]!.after).authorizedAt : Date.now()
    const document = { schemaVersion: 1, voiceId: request.operationId, sourceChapterId: request.sourceChapterId, sourceRevision: metadata.revision, sourceHash: source.hash,
      channel: request.channel, characterId: request.characterId, sourceDescription: request.sourceDescription, sample: source.content.slice(request.start, request.end), start: request.start, end: request.end, authorized: true, authorizedAt }
    parseVoice(json(document))
    return await this.books.mutate({ operationId: request.operationId, bookId: request.bookId, chapterId: request.operationId, expectedRevision: request.expectedRevision,
      action: 'create', title: request.sourceDescription, content: json(document), expectedHash: '', beforeChapterId: '', kind: 'voice' }, signal)
  }
  async revoke(bookId: string, voiceId: string, expectedRevision: number, expectedHash: string, operationId: string, signal: AbortSignal): Promise<BookSnapshot> {
    idSchema.parse(operationId)
    const stored = await this.books.readChapter(bookId, voiceId)
    if (stored.book.chapters.find(item => item.chapterId === voiceId)?.kind !== 'voice') throw new BookError('invalid-material')
    const document = parseVoice(stored.content)
    return await this.books.mutate({ operationId, bookId, chapterId: voiceId, expectedRevision, action: 'save', title: '', content: json({ ...document, authorized: false }), expectedHash, beforeChapterId: '' }, signal)
  }
  async selected(bookId: string, ids: readonly string[]): Promise<VoiceSample[]> {
    const result: VoiceSample[] = []
    for (const id of ids) {
      const voice = await this.read(bookId, id)
      if (voice.state !== 'active') throw new BookError('voice-unavailable')
      result.push(voice)
    }
    return result
  }
}
