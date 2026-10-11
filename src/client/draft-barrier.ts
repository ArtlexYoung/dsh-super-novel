export function assertDraftReceipts(writers: Iterable<any>): void {
  for (const writer of writers) if (writer.latest && !writer.confirmed.has(writer.latest.sequence)) throw Object.assign(new Error('draft-changed'), { reason: 'draft-changed' })
}

/** Keep departed form writers until their captured input has a disk receipt. */
export class DraftBarrier {
  private readonly writers = new Set<any>()
  register(writer): void { this.writers.add(writer) }
  async flush(): Promise<{ flushed: number }> {
    let flushed = 0
    for (const writer of [...this.writers]) {
      await writer.flush(); flushed++
    }
    // An input can change, or another form can register, while a receipt is awaited.
    // The caller must retry rather than switch libraries after confirming old input.
    assertDraftReceipts(this.writers)
    this.writers.clear()
    return { flushed }
  }
}
