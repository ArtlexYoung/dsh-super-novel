/** Mechanical checks are narrow signals, never a literary-quality score. */
export function measureOutput(item, output) {
  const text = output.trim()
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length
  return {
    han, lengthWithinRange: han >= item.minHan && han <= item.maxHan,
    forbiddenFound: (item.forbidden ?? []).filter(phrase => text.includes(phrase)),
    ...(item.prefix ? { prefixPreserved: text.startsWith(item.prefix), suffixPreserved: text.endsWith(item.suffix), paragraphs: text.split(/\n\s*\n|\n/).filter(line => line.trim()).length } : {}),
  }
}

/** Count settled attempts once and keep absent usage explicit. */
export function measureEvents(events) {
  const attempts = events.filter(event => ['assistant/message', 'assistant/attempt'].includes(event.type))
  const messages = attempts.filter(event => event.type === 'assistant/message')
  const output = messages.flatMap(event => event.data.message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
  const uses = attempts.map(event => event.data.usage ?? (event.data.stream ?? []).map(row => row.chunk ?? row).filter(chunk => chunk.type === 'usage').at(-1)?.usage)
  const usage = uses.length && uses.every(Boolean)
    ? { status: 'reported', ...Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'].map(key => [key, uses.every(value => Number.isFinite(value[key])) ? uses.reduce((sum, value) => sum + value[key], 0) : 'unreported'])) }
    : { status: 'unreported' }
  const end = events.filter(event => event.type === 'turn/end').at(-1)
  return {
    output, requestCount: attempts.length, usage,
    completed: end?.data.reason?.kind === 'completed', end: end?.data ?? { status: 'missing' },
    toolCalls: messages.flatMap(event => event.data.message.content).filter(block => block.type === 'tool-call').length,
    errors: events.filter(event => /error|failed/.test(event.type)).map(event => ({ type: event.type, data: event.data })),
  }
}
