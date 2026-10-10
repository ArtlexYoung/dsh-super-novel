import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorHistory } from '../src/client/editor-history.ts'
const at = (start, end = start) => ({ start, end, direction: 'none' })

test('manuscript undo survives unrelated inputs and redo; a new edit discards the redo branch', () => {
  const history = new EditorHistory('原稿')
  history.record('原稿新增一句。', at(2), at(7), 'insertFromPaste')
  history.breakGroup(); history.synchronize('原稿新增一句。')
  assert.deepEqual(history.undo(), { kind: 'changed', content: '原稿', selection: at(2) })
  assert.equal(history.redo().content, '原稿新增一句。')
  history.undo(); history.record('新原稿', at(0), at(1), 'insertText')
  assert.equal(history.redo().kind, 'unavailable')
  assert.equal(history.undo().content, '原稿')
})

test('adjacent typing groups, tool visits and pauses form separate undo steps', () => {
  const history = new EditorHistory('')
  history.record('a', at(0), at(1), 'insertText', '', 100)
  history.record('ab', at(1), at(2), 'insertText', '', 200)
  history.breakGroup()
  history.record('abc', at(2), at(3), 'insertText', '', 250)
  assert.equal(history.undo().content, 'ab'); assert.equal(history.undo().content, '')
  assert.equal(history.redo().content, 'ab')
  history.record('abd', at(2), at(3), 'insertText', '', 2000)
  assert.equal(history.undo().content, 'ab')
})

test('Chinese composition and selected replacements preserve Unicode and surrounding text', () => {
  const history = new EditorHistory('🌙旧词，保留。')
  history.record('🌙l，保留。', at(2, 4), at(3), 'insertCompositionText', 'ime-1', 100)
  history.record('🌙林，保留。', at(3), at(3), 'insertCompositionText', 'ime-1', 1000)
  history.record('🌙林舟，保留。', at(3), at(4), 'insertCompositionText', 'ime-1', 2000)
  assert.deepEqual(history.undo(), { kind: 'changed', content: '🌙旧词，保留。', selection: at(2, 4) })
  assert.equal(history.redo().content, '🌙林舟，保留。')
})

test('changed source resets history; byte and step limits keep the remaining edits valid', () => {
  const history = new EditorHistory('a', { bytes: 10, steps: 2 })
  history.record('ab', at(1), at(2), 'insertFromPaste')
  history.record('abc', at(2), at(3), 'insertFromPaste')
  history.record('abcd', at(3), at(4), 'insertFromPaste')
  assert.equal(history.undo().content, 'abc'); assert.equal(history.undo().content, 'ab'); assert.equal(history.undo().kind, 'unavailable')
  history.synchronize('外部新稿'); assert.equal(history.redo().kind, 'unavailable')
  history.record('长'.repeat(100), at(0), at(100), 'insertFromPaste')
  assert.equal(history.undo().kind, 'unavailable')
})
