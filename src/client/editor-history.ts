export interface EditorSelection { readonly start: number; readonly end: number; readonly direction: string }
interface Edit {
  readonly start: number; readonly before: string; readonly after: string
  readonly selectionBefore: EditorSelection; readonly selectionAfter: EditorSelection
  readonly type: string; readonly group: string; readonly time: number
}
type Change = { readonly kind: 'changed'; readonly content: string; readonly selection: EditorSelection } | { readonly kind: 'unavailable' }
const size = (edit: Edit): number => 2 * (edit.before.length + edit.after.length)
function difference(before: string, after: string): { start: number; before: string; after: string } {
  let start = 0, endBefore = before.length, endAfter = after.length
  while (start < endBefore && start < endAfter && before[start] === after[start]) start++
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter-- }
  return { start, before: before.slice(start, endBefore), after: after.slice(start, endAfter) }
}

/** Browser undo is shared with other inputs. Keep manuscript edits in their own bounded ledger. */
export class EditorHistory {
  private content: string
  private readonly past: Edit[] = []
  private readonly future: Edit[] = []
  private boundary = false
  private readonly limits: { readonly bytes: number; readonly steps: number }
  constructor(content: string, limits = { bytes: 16 * 1024 * 1024, steps: 100 }) {
    if (!Number.isSafeInteger(limits.bytes) || limits.bytes <= 0 || !Number.isSafeInteger(limits.steps) || limits.steps <= 0) throw new Error('invalid-history-limits')
    this.content = content; this.limits = limits
  }
  bytes(): number { return [...this.past, ...this.future].reduce((total, item) => total + size(item), 0) }

  synchronize(content: string): void {
    if (content === this.content) return
    this.content = content; this.past.length = 0; this.future.length = 0; this.boundary = true
  }
  breakGroup(): void { this.boundary = true }

  record(content: string, selectionBefore: EditorSelection, selectionAfter: EditorSelection, type: string, group = '', time = Date.now()): void {
    if (content === this.content) return
    let edit: Edit = { ...difference(this.content, content), selectionBefore, selectionAfter, type, group, time }
    const last = this.past.at(-1)
    const composition = !!group && group === last?.group
    const typing = type === 'insertText' && last?.type === 'insertText' && !edit.before && !last.before && edit.start === last.start + last.after.length && time - last.time < 700
    if (last && !this.boundary && (composition || typing)) {
      const original = this.content.slice(0, last.start) + last.before + this.content.slice(last.start + last.after.length)
      edit = { ...edit, ...difference(original, content), selectionBefore: last.selectionBefore }
      this.past.pop()
    }
    this.content = content; this.future.length = 0; this.boundary = false; this.past.push(edit)
    let bytes = this.past.reduce((total, item) => total + size(item), 0)
    while (this.past.length > this.limits.steps || bytes > this.limits.bytes) bytes -= size(this.past.shift()!)
  }

  undo(): Change {
    const edit = this.past.pop()
    if (!edit) return { kind: 'unavailable' }
    this.content = this.content.slice(0, edit.start) + edit.before + this.content.slice(edit.start + edit.after.length)
    this.future.push(edit); this.boundary = true
    return { kind: 'changed', content: this.content, selection: edit.selectionBefore }
  }
  redo(): Change {
    const edit = this.future.pop()
    if (!edit) return { kind: 'unavailable' }
    this.content = this.content.slice(0, edit.start) + edit.after + this.content.slice(edit.start + edit.before.length)
    this.past.push(edit); this.boundary = true
    return { kind: 'changed', content: this.content, selection: edit.selectionAfter }
  }
}
