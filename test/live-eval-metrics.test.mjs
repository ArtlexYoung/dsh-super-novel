import test from 'node:test'
import assert from 'node:assert/strict'
import { measureEvents, measureOutput } from '../scripts/live-eval-metrics.mjs'
const message = (text, usage) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] }, ...(usage ? { usage } : {}) } })
test('a truncated or empty session is not a completed generation; missing usage stays unknown', () => {
  assert.equal(measureEvents([]).completed, false)
  const result = measureEvents([message('草稿'), { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }])
  assert.equal(result.completed, false)
  assert.equal(result.usage.status, 'unreported')
  assert.equal(result.requestCount, 1)
})
test('usage preserves provider total and unavailable fields rather than double counting cache', () => {
  const result = measureEvents([message('正文', { inputTokens: 20, cacheReadTokens: 80, outputTokens: 10, totalTokens: 110 }), { type: 'turn/end', data: { reason: { kind: 'completed' } } }])
  assert.equal(result.usage.totalTokens, 110)
  assert.equal(result.usage.cacheWriteTokens, 'unreported')
  assert.equal(result.output, '正文')
  assert.equal(result.completed, true)
})
test('mechanical checks flag fixed-text edits, disallowed phrases and Unicode length', () => {
  const item = { minHan: 4, maxHan: 8, prefix: '开头。', suffix: '结尾。', forbidden: ['县令'] }
  const result = measureOutput(item, '错字。县令结尾。')
  assert.equal(result.prefixPreserved, false)
  assert.deepEqual(result.forbiddenFound, ['县令'])
  assert.equal(result.han, 6)
})
