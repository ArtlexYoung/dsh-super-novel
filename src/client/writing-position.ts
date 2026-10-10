export interface PositionRecord {
  readonly schemaVersion: 1; readonly token: string; readonly start: number; readonly end: number
  readonly direction: 'forward' | 'backward' | 'none'; readonly scroll: number
  readonly anchor: string; readonly anchorOffset: number
}
export interface RestoredPosition {
  readonly kind: 'exact' | 'relocated' | 'changed'; readonly start: number; readonly end: number
  readonly direction: 'forward' | 'backward' | 'none'; readonly scroll: number
}
type Lookup = { readonly kind: 'found'; readonly value: PositionRecord } | { readonly kind: 'absent' }
interface PositionStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const positionToken = (entry: { content: string; diskContent: string; diskHash: string; operationId: string }): string =>
  entry.content === entry.diskContent ? `saved:${entry.diskHash}` : `draft:${entry.operationId}`

export function captureWritingPosition(text: string, token: string, start: number, end: number, direction: string, scroll: number): PositionRecord {
  const from = Math.max(0, Math.min(start, text.length)), to = Math.max(from, Math.min(end, text.length)), left = Math.max(0, from - 48)
  return { schemaVersion: 1, token, start: from, end: to, direction: direction === 'forward' || direction === 'backward' ? direction : 'none',
    scroll: Math.max(0, scroll), anchor: text.slice(left, from + 80), anchorOffset: from - left }
}

/** Changed content never inherits an old selection or an ambiguous text anchor. */
export function restoreWritingPosition(record: PositionRecord, text: string, token: string): RestoredPosition {
  if (record.token === token) return { kind: 'exact', start: Math.min(record.start, text.length), end: Math.min(record.end, text.length), direction: record.direction, scroll: record.scroll }
  const at = record.anchor.length ? text.indexOf(record.anchor) : -1
  if (at >= 0 && text.indexOf(record.anchor, at + 1) < 0) {
    const start = Math.min(at + record.anchorOffset, text.length)
    return { kind: 'relocated', start, end: start, direction: 'none', scroll: 0 }
  }
  return { kind: 'changed', start: 0, end: 0, direction: 'none', scroll: 0 }
}

function valid(value: unknown): value is PositionRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as PositionRecord
  return record.schemaVersion === 1 && typeof record.token === 'string' && record.token.length <= 100 &&
    Number.isSafeInteger(record.start) && Number.isSafeInteger(record.end) && record.start >= 0 && record.end >= record.start && record.end <= 4 * 1024 * 1024 &&
    ['forward', 'backward', 'none'].includes(record.direction) && Number.isFinite(record.scroll) && record.scroll >= 0 && record.scroll < 1e9 &&
    typeof record.anchor === 'string' && record.anchor.length <= 128 && Number.isSafeInteger(record.anchorOffset) && record.anchorOffset >= 0 && record.anchorOffset <= record.anchor.length
}

/** Local preference only. Storage failure cannot prevent manuscript saving. */
export class WritingPositions {
  private readonly records = new Map<string, PositionRecord>()
  private readonly pending = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly storage: () => PositionStorage
  constructor(storage: () => PositionStorage) { this.storage = storage }

  get(identity: string): Lookup {
    const cached = this.records.get(identity)
    if (cached) return { kind: 'found', value: cached }
    try {
      const raw = this.storage().getItem(`super-novel.position:${identity}`)
      if (raw && raw.length <= 2048) {
        const value: unknown = JSON.parse(raw)
        if (valid(value)) { this.records.set(identity, value); return { kind: 'found', value } }
      }
    } catch { /* A damaged preference is ignored, never interpreted as a draft. */ }
    return { kind: 'absent' }
  }

  remember(identity: string, record: PositionRecord): void {
    this.records.set(identity, record); this.pending.add(identity)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.flush() }, 400)
  }

  flush(): { readonly saved: boolean } {
    clearTimeout(this.timer)
    let saved = true
    for (const identity of this.pending) {
      try { this.storage().setItem(`super-novel.position:${identity}`, JSON.stringify(this.records.get(identity))); this.pending.delete(identity) }
      catch { saved = false }
    }
    return { saved }
  }
}
