import test from 'node:test'
import assert from 'node:assert/strict'
import { WritingPositions, captureWritingPosition, restoreWritingPosition, positionToken } from '../src/client/writing-position.ts'

test('saved and retained draft identities restore selection, direction and scroll after reopening', () => {
  const data = new Map(), storage = () => ({ getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) } })
  const identity = 'library:book:chapter', text = '🌙林舟把钥匙交给她。', token = positionToken({ content: text, diskContent: text, diskHash: 'a'.repeat(64), operationId: 'new' })
  const positions = new WritingPositions(storage), record = captureWritingPosition(text, token, 2, 8, 'backward', 320)
  positions.remember(identity, record); assert(positions.flush().saved)
  const reopened = new WritingPositions(storage), saved = reopened.get(identity)
  assert.equal(saved.kind, 'found')
  if (saved.kind === 'found') assert.deepEqual(restoreWritingPosition(saved.value, text, token), { kind: 'exact', start: 2, end: 8, direction: 'backward', scroll: 320 })
  assert.equal(reopened.get('other:book:chapter').kind, 'absent')
  assert.equal(positionToken({ content: '改稿', diskContent: text, diskHash: 'a'.repeat(64), operationId: 'retained' }), 'draft:retained')
})

test('changed text relocates only a unique anchor and collapses old selections', () => {
  const text = '原稿里的林舟走向渡口。', record = captureWritingPosition(text, 'old', 5, 8, 'forward', 100)
  assert.deepEqual(restoreWritingPosition(record, '新增一段。' + text, 'new'), { kind: 'relocated', start: 10, end: 10, direction: 'none', scroll: 0 })
  assert.deepEqual(restoreWritingPosition(record, text + text, 'new'), { kind: 'changed', start: 0, end: 0, direction: 'none', scroll: 0 })
  assert.equal(restoreWritingPosition(record, '', 'new').kind, 'changed')
})

test('invalid preferences are ignored and rejected storage retains in-memory position for retry', () => {
  let denied = true, stored = ''
  const storage = () => ({ getItem: () => stored, setItem: (_key, value) => { if (denied) throw new Error('quota'); stored = value } })
  const positions = new WritingPositions(storage), record = captureWritingPosition('正文', 'token', 1, 2, 'none', 0)
  positions.remember('one', record); assert.equal(positions.flush().saved, false)
  assert.equal(positions.get('one').kind, 'found')
  denied = false; assert(positions.flush().saved)
  assert.equal(new WritingPositions(storage).get('one').kind, 'found')
  for (const bad of ['not json', JSON.stringify({ ...record, start: -1 }), JSON.stringify({ ...record, end: 9e9 }), JSON.stringify({ ...record, anchor: 'x'.repeat(129) })]) {
    stored = bad; assert.equal(new WritingPositions(storage).get('one').kind, 'absent')
  }
})
