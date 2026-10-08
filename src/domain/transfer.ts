import { z } from 'zod'
import { BookError, contentSchema, documentKindSchema, hash, idSchema, titleSchema } from './books.js'
import type { DocumentKind, ImportRequest } from '../types.js'
export const transferTextSchema = z.string().refine(value => !value.includes('\0') && Buffer.from(value, 'utf8').toString('utf8') === value && Buffer.byteLength(value, 'utf8') <= 8 * 1024 * 1024)
export const importRequestSchema = z.strictObject({ operationId: idSchema, title: titleSchema, text: transferTextSchema, mode: z.enum(['single', 'headings', 'archive']) })
const documentSchema = z.strictObject({ title: titleSchema, content: contentSchema, kind: documentKindSchema.refine(kind => kind !== 'facts' && kind !== 'voice') })
const archiveSchema = z.strictObject({ schemaVersion: z.literal(1), title: titleSchema, sections: z.array(z.strictObject({ title: titleSchema, kind: documentSchema.shape.kind,
  start: z.int().nonnegative(), end: z.int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/) })).min(1).max(10_000) })
export type TransferDocument = z.infer<typeof documentSchema>
export function importDocuments(input: ImportRequest): TransferDocument[] {
  const request = importRequestSchema.parse(input), text = request.text
  let documents: TransferDocument[]
  if (request.mode === 'archive') {
    const at = text.indexOf('\n'), line = text.slice(0, at)
    const prefix = '<!-- dsh-super-novel-export ', suffix = ' -->'
    if (at < 0 || !line.startsWith(prefix) || !line.endsWith(suffix)) throw new BookError('invalid-import')
    let value: unknown
    try { value = JSON.parse(line.slice(prefix.length, -suffix.length)) } catch { throw new BookError('invalid-import') }
    if (typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion !== 1) throw new BookError('unsupported-format')
    const metadata = archiveSchema.safeParse(value)
    if (!metadata.success) throw new BookError('invalid-import')
    const payload = text.slice(at + 1); let previousEnd = 0
    documents = metadata.data.sections.map((section, index) => {
      const content = payload.slice(section.start, section.end)
      if (payload.slice(previousEnd, section.start) !== `${index ? '\n\n' : ''}# ${section.title}\n\n` || section.end < section.start || section.end > payload.length || hash(content) !== section.hash) throw new BookError('invalid-import')
      previousEnd = section.end
      return documentSchema.parse({ title: section.title, kind: section.kind, content })
    })
    if (payload.slice(previousEnd) !== '\n\n') throw new BookError('invalid-import')
  } else if (request.mode === 'headings') {
    // Only level-one headings outside fenced blocks split chapters; preview is mandatory.
    const boundaries: { at: number; title: string }[] = []; let offset = 0, fence = ''
    for (const line of text.split(/(?<=\n)/u)) {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1]
      if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''; }
      if (!fence) { const heading = line.match(/^# +([^\r\n]+)(?:\r?\n)?$/u); if (heading) boundaries.push({ at: offset, title: heading[1]!.replace(/ +#+ *$/u, '') }) }
      offset += line.length
    }
    if (!boundaries.length) documents = [{ title: request.title, kind: 'chapter', content: text }]
    else {
      documents = boundaries.map((item, i) => ({ title: item.title, kind: 'chapter' as const, content: text.slice(item.at, boundaries[i + 1]?.at ?? text.length) }))
      if (boundaries[0]!.at) documents.unshift({ title: request.title, kind: 'chapter', content: text.slice(0, boundaries[0]!.at) })
    }
  } else documents = [{ title: request.title, kind: 'chapter', content: text }]
  if (documents.length > 10_000) throw new BookError('too-large')
  return z.array(documentSchema).min(1).max(10_000).parse(documents)
}
export function exportDocuments(title: string, documents: readonly { title: string; content: string; kind?: DocumentKind }[]): string {
  titleSchema.parse(title)
  if (!documents.length) throw new BookError('invalid-import')
  let payload = ''
  const sections = documents.map(document => {
    const parsed = documentSchema.parse({ ...document, kind: document.kind ?? 'chapter' })
    payload += `# ${parsed.title}\n\n`
    const start = payload.length; payload += parsed.content
    const end = payload.length; payload += '\n\n'
    return { title: parsed.title, kind: parsed.kind, start, end, hash: hash(parsed.content) }
  })
  return transferTextSchema.parse(`<!-- dsh-super-novel-export ${JSON.stringify({ schemaVersion: 1, title, sections })} -->\n${payload}`)
}
