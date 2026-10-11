const memory = new Map<string, any>()
const uuid = (value: unknown): boolean => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)
const text = (value: unknown, max: number): boolean => typeof value === 'string' && value.length <= max && !value.includes('\0')
const ids = (value: unknown): boolean => Array.isArray(value) && value.length <= 1000 && value.every(uuid)
export function materialForm(item): { tags: string; aliases: string; favorite: boolean; status: string; linkedChapterIds: string[]; relatedMaterialIds: string[] } {
  return { tags: (item.tags ?? []).join(', '), aliases: (item.aliases ?? []).join(', '), favorite: !!item.favorite, status: item.status ?? 'active',
    linkedChapterIds: [...new Set<string>([...(item.linkedChapterIds ?? []), ...(item.linkedChapterId ? [item.linkedChapterId] : [])])], relatedMaterialIds: [...(item.relatedMaterialIds ?? [])] }
}
function material(value): boolean {
  return !!value && text(value.tags, 4096) && text(value.aliases, 8000) && typeof value.favorite === 'boolean' &&
    ['active', 'inbox', 'archived', 'trashed'].includes(value.status) && ids(value.linkedChapterIds) && ids(value.relatedMaterialIds)
}
function evidence(value): boolean {
  return !!value && uuid(value.chapterId) && Number.isSafeInteger(value.revision) && value.revision > 0 && /^[a-f\d]{64}$/.test(value.hash) &&
    Number.isSafeInteger(value.start) && value.start >= 0 && Number.isSafeInteger(value.end) && value.end > value.start && text(value.quote, 8000) && value.quote.length === value.end - value.start
}
function story(value): boolean {
  if (!value || !text(value.title, 200)) return false
  if (value.kind === 'foreshadow') return uuid(value.foreshadowId) && text(value.note, 8000) && ['planned', 'planted', 'unresolved', 'resolved'].includes(value.status) &&
    (!value.planted || evidence(value.planted)) && (!value.resolved || evidence(value.resolved))
  return value.kind === 'event' && uuid(value.eventId) && evidence(value.evidence) &&
    (value.time?.kind === 'unknown' || value.time?.kind === 'known' && text(value.time.label, 200) && Number.isFinite(value.time.order) && Math.abs(value.time.order) <= 1_000_000) &&
    Array.isArray(value.changes) && value.changes.length <= 100 && value.changes.every(change => (change.characterId === '' || uuid(change.characterId)) && ['location', 'injury', 'item', 'knowledge'].includes(change.kind) && text(change.value, 2000))
}
export function readFormEnvelope(content: string, kind: string): { kind: 'found'; value: any } | { kind: 'absent' } {
  try {
    if (new TextEncoder().encode(content).length > 1024 * 1024) return { kind: 'absent' }
    const value = JSON.parse(content)
    if (value?.schemaVersion !== 1 || value.kind !== kind) return { kind: 'absent' }
    if (kind === 'material' ? material(value.base) && material(value.form) : kind === 'story' && Number.isSafeInteger(value.base) && value.base >= 0 && (!value.sourceProposalId || uuid(value.sourceProposalId)) && story(value.form)) return { kind: 'found', value }
  } catch { /* Invalid cache data is never restored as a form. */ }
  return { kind: 'absent' }
}

/** Form cache has a separate key space; manuscripts never enumerate these records. */
export class FormDraftCache {
  private readonly kind: string
  private readonly identity: { workspaceId: string; bookId: string; chapterId: string }
  private readonly storage: () => Storage
  constructor(kind: string, identity: { workspaceId: string; bookId: string; chapterId: string }, storage: () => Storage) { this.kind = kind; this.identity = identity; this.storage = storage }
  private prefix(): string { return `super-novel.form:${this.kind}:${this.identity.workspaceId}:${this.identity.bookId}:${this.identity.chapterId}:` }
  private key(request): string { return this.prefix() + request.branchId }
  private valid(request): boolean {
    return !!request && Object.entries(this.identity).every(([key, value]) => request[key] === value) && uuid(request.branchId) && uuid(request.operationId) &&
      Number.isSafeInteger(request.sequence) && request.sequence > 0 && Number.isSafeInteger(request.bookRevision) && request.bookRevision > 0 &&
      typeof request.baseHash === 'string' && /^[a-f\d]{64}$/.test(request.baseHash) && typeof request.content === 'string' && readFormEnvelope(request.content, this.kind).kind === 'found'
  }
  read(branchId: string): { kind: 'found'; value: any } | { kind: 'absent' } {
    const key = this.prefix() + branchId
    if (memory.has(key)) return { kind: 'found', value: memory.get(key) }
    try {
      const raw = this.storage().getItem(key)
      if (raw && raw.length <= 2 * 1024 * 1024) {
        const value = JSON.parse(raw)
        if (this.valid(value)) { memory.set(key, value); return { kind: 'found', value } }
      }
    } catch { /* A failed browser read leaves disk recovery available. */ }
    return { kind: 'absent' }
  }
  list(): any[] {
    try {
      const storage = this.storage()
      for (let at = 0; at < storage.length; at++) {
        const key = storage.key(at)
        if (key?.startsWith(this.prefix())) this.read(key.slice(this.prefix().length))
      }
    } catch { /* Return the scoped in-memory copies. */ }
    return [...memory.entries()].filter(([key]) => key.startsWith(this.prefix())).map(([, value]) => value).filter(value => this.valid(value))
  }
  async write(request): Promise<boolean> {
    if (!this.valid(request)) throw new Error('invalid-form-draft')
    const key = this.key(request), prior = memory.get(key)
    if (prior && prior.sequence > request.sequence) return false
    memory.set(key, request)
    this.storage().setItem(key, JSON.stringify(request))
    return true
  }
  async forget(request): Promise<boolean> {
    const key = this.key(request)
    if (memory.get(key)?.operationId === request.operationId) memory.delete(key)
    const raw = this.storage().getItem(key)
    if (raw && JSON.parse(raw).operationId === request.operationId) this.storage().removeItem(key)
    return true
  }
}
