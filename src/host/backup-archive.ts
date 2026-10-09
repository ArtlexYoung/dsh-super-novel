import { createReadStream, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip, createGunzip } from 'node:zlib'
import { BookError } from '../domain/books.js'

export const MAX_FILE = 32 * 1024 * 1024
export const MAX_TOTAL = 1024 * 1024 * 1024
export const MAX_FILES = 50_000
export interface ArchiveEntry { path: string; data: Buffer }

function header(path: string, bytes: number): Buffer {
  let name = path, prefix = ''
  if (Buffer.byteLength(name) > 100) { const at = path.lastIndexOf('/'); prefix = path.slice(0, at); name = path.slice(at + 1) }
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new BookError('unsafe-path')
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8'); block.write(prefix, 345, 155, 'utf8')
  const octal = (value: number, at: number, size: number) => block.write(value.toString(8).padStart(size - 1, '0') + '\0', at, size, 'ascii')
  octal(0o600, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(bytes, 124, 12); octal(0, 136, 12)
  block.fill(32, 148, 156); block[156] = 48; block.write('ustar\0', 257); block.write('00', 263)
  octal(block.reduce((sum, byte) => sum + byte, 0), 148, 8)
  return block
}

/** Standard ustar + gzip; at most one bounded file is held in memory. */
export async function packArchive(entries: AsyncIterable<ArchiveEntry>, path: string, signal: AbortSignal): Promise<void> {
  async function* blocks() {
    for await (const entry of entries) {
      signal.throwIfAborted()
      if (entry.data.length > MAX_FILE) throw new BookError('too-large')
      yield header(entry.path, entry.data.length); yield entry.data
      if (entry.data.length % 512) yield Buffer.alloc(512 - entry.data.length % 512)
    }
    yield Buffer.alloc(1024)
  }
  await pipeline(Readable.from(blocks()), createGzip(), createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal })
}

/** No links, directories, extensions, duplicate paths or unbounded decompression. */
export async function* unpackArchive(path: string, signal: AbortSignal): AsyncGenerator<ArchiveEntry, void> {
  const input = createReadStream(path), stream = input.pipe(createGunzip()), iterator = stream[Symbol.asyncIterator]()
  input.on('error', error => stream.destroy(error))
  let pending = Buffer.alloc(0), total = 0, count = 0
  const next = async (size: number): Promise<Buffer> => {
    const parts: Buffer[] = []
    let used = 0
    while (used < size) {
      signal.throwIfAborted()
      if (!pending.length) {
        const chunk = await iterator.next()
        if (chunk.done) throw new BookError('invalid-backup')
        total += chunk.value.length
        if (total > MAX_TOTAL + MAX_FILES * 1024) throw new BookError('too-large')
        pending = chunk.value
      }
      const take = Math.min(size - used, pending.length)
      parts.push(pending.subarray(0, take)); pending = pending.subarray(take); used += take
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, size)
  }
  try {
    while (true) {
      const block = await next(512)
      if (block.every(byte => byte === 0)) {
        const second = await next(512)
        if (!second.every(byte => byte === 0)) throw new BookError('invalid-backup')
        // Drain to validate the gzip trailer and reject additional archives/data.
        if (pending.some(byte => byte !== 0)) throw new BookError('invalid-backup')
        for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
          total += chunk.length
          if (total > MAX_TOTAL + MAX_FILES * 1024 || chunk.some((byte: number) => byte !== 0)) throw new BookError('invalid-backup')
        }
        return
      }
      const field = (at: number, size: number) => block.subarray(at, at + size).toString('utf8').replace(/\0.*$/s, '')
      const number = (at: number, size: number) => { const text = field(at, size).trim(); if (!/^[0-7]+$/.test(text)) throw new BookError('invalid-backup'); return parseInt(text, 8) }
      const checksum = number(148, 8), actual = block.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0)
      const prefix = field(345, 155), name = (prefix ? prefix + '/' : '') + field(0, 100), bytes = number(124, 12)
      if (checksum !== actual || field(257, 6) !== 'ustar' || ![0, 48].includes(block[156]!) || !Number.isSafeInteger(bytes) || bytes > MAX_FILE || ++count > MAX_FILES) throw new BookError('invalid-backup')
      if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').some(piece => !piece || piece === '.' || piece === '..')) throw new BookError('unsafe-path')
      const data = Buffer.from(await next(bytes))
      const padding = bytes % 512 ? await next(512 - bytes % 512) : Buffer.alloc(0)
      if (padding.some(byte => byte !== 0)) throw new BookError('invalid-backup')
      yield { path: name, data }
    }
  } finally { input.destroy(); stream.destroy() }
}
