import assert from 'node:assert/strict'
import test from 'node:test'

import { parseStrictJson, StrictJsonError } from '../scripts/strict-json.mjs'

test('strict release JSON rejects duplicate decoded keys at any depth', () => {
  for (const text of [
    '{"target":"a","target":"b"}',
    '{"nested":{"resource":1,"resource":2}}',
    '{"target":1,"\\u0074arget":2}',
  ]) assert.throws(() => parseStrictJson(text), StrictJsonError)
})

test('strict release JSON preserves ordinary JSON values without prototype mutation', () => {
  const parsed = parseStrictJson('{"text":"猫\\ud83d\\udcf7","number":1.25,"array":[true,false,null],"__proto__":{"unsafe":true}}')
  assert.equal(parsed.text, '猫📷')
  assert.deepEqual(parsed.array, [true, false, null])
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype)
  assert.equal(Object.hasOwn(parsed, '__proto__'), true)
  assert.equal({}.unsafe, undefined)
})
