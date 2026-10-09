/** Serializes one editor branch; every receipt is associated with the captured input. */
export class DraftWriter {
  constructor(identity, services) {
    this.identity = identity
    this.services = services
    this.sequence = 0
    this.confirmed = new Map()
    this.pending = new Map()
    this.tail = Promise.resolve()
    this.composing = false
    this.state = { kind: 'formal', savedAt: 0 }
  }
  emit(state) { this.state = state; this.services.changed(state) }
  update(entry) {
    if (this.latest?.operationId === entry.operationId && this.latest.baseHash === entry.baseHash && this.latest.bookRevision === entry.bookRevision && this.latest.content === entry.content) return
    const request = { ...this.identity, sequence: ++this.sequence, baseHash: entry.baseHash, bookRevision: entry.bookRevision, content: entry.content, operationId: entry.operationId }
    this.latest = request
    this.emit({ kind: 'saving', savedAt: this.state.savedAt })
    this.services.cache(request).then(() => {
      if (this.latest === request && !this.confirmed.has(request.sequence) && this.state.kind !== 'failed') this.emit({ kind: 'browser', savedAt: this.state.savedAt })
    }).catch(() => {
      if (this.latest === request && !this.confirmed.has(request.sequence)) this.emit({ kind: 'browser-failed', savedAt: this.state.savedAt })
    })
    clearTimeout(this.debounce)
    this.debounce = setTimeout(() => this.attempt(), 1000)
    if (!this.maximum) this.maximum = setTimeout(() => { this.maximum = undefined; this.attempt() }, 5000)
  }
  attempt() { if (!this.composing) this.flush().catch(() => {}) }
  clearTimers() { clearTimeout(this.debounce); clearTimeout(this.maximum); this.maximum = undefined }
  async flush() {
    this.clearTimers()
    const request = this.latest
    if (!request) return { available: false }
    if (this.composing) throw new Error('draft-composing')
    if (this.confirmed.has(request.sequence)) return { available: true, request, receipt: this.confirmed.get(request.sequence) }
    if (!this.pending.has(request.sequence)) {
      const task = this.tail.catch(() => {}).then(async () => {
        const receipt = await this.services.checkpoint(request)
        if (receipt.branchId !== request.branchId || receipt.sequence !== request.sequence || receipt.operationId !== request.operationId || receipt.workspaceId !== request.workspaceId) throw new Error('invalid-draft-receipt')
        this.confirmed.set(request.sequence, receipt)
        if (this.latest === request) this.emit({ kind: 'disk', savedAt: receipt.savedAt })
        return { available: true, request, receipt }
      }).catch(error => {
        if (this.latest === request) this.emit({ kind: 'failed', reason: error.reason ?? 'storage-failed', savedAt: this.state.savedAt })
        throw error
      }).finally(() => this.pending.delete(request.sequence))
      this.tail = task
      this.pending.set(request.sequence, task)
    }
    return await this.pending.get(request.sequence)
  }
  async settle(entry, action) {
    const receipt = [...this.confirmed.values()].findLast(item => item.operationId === entry.operationId)
    if (receipt) await this.services.settle({ ...this.identity, sequence: receipt.sequence, contentHash: receipt.contentHash, action })
    // This deletion is conditional; a newer input with another operation ID survives.
    if (this.latest?.operationId === entry.operationId) {
      const request = this.latest
      this.latest = undefined
      this.clearTimers()
      await this.services.forget(request)
      this.emit({ kind: 'formal', savedAt: Date.now() })
    }
  }
}
