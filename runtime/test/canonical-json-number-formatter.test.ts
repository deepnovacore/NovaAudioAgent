import assert from 'node:assert/strict'
import {test} from 'node:test'

import {canonicalJsonWithNumberFormatter} from '../src/canonical-json.js'
import {pythonFloat} from '../src/python-number.js'

test('path-aware canonical number formatting preserves ordinary numbers and Python float bytes', () => {
  const visited: (readonly (string | number)[])[] = []
  const rendered = canonicalJsonWithNumberFormatter({
    version: 1,
    records: [{created_at: -0, last_used_at: 1e-7, ordinary: 2}],
    high: 1e16,
    positional: 1e15,
  }, (value, path) => {
    visited.push(path)
    const field = path.at(-1)
    return field === 'created_at' || field === 'last_used_at' ? pythonFloat(value) : undefined
  })
  assert.equal(rendered,
    '{"high":10000000000000000,"positional":1000000000000000,"records":[{"created_at":-0.0,"last_used_at":1e-07,"ordinary":2}],"version":1}',
  )
  assert.deepEqual(visited, [
    ['high'], ['positional'], ['records', 0, 'created_at'],
    ['records', 0, 'last_used_at'], ['records', 0, 'ordinary'], ['version'],
  ])
})

test('canonical number formatter tokens cannot inject JSON or change binary64 identity', () => {
  for (const token of ['0,"injected":1', '01', 'NaN', 'Infinity', '1e999', '2']) {
    assert.throws(
      () => canonicalJsonWithNumberFormatter({value: 1}, () => token),
      /unsafe token/u,
      token,
    )
  }
  assert.throws(
    () => canonicalJsonWithNumberFormatter({value: -0}, () => '0.0'),
    /unsafe token/u,
  )
  assert.throws(
    () => canonicalJsonWithNumberFormatter({value: 0}, () => '-0.0'),
    /unsafe token/u,
  )
  assert.equal(canonicalJsonWithNumberFormatter({value: 1}, () => '1.000'), '{"value":1.000}')
})

test('canonical input validation runs before a number formatter', () => {
  let called = false
  assert.throws(
    () => canonicalJsonWithNumberFormatter({value: Number.POSITIVE_INFINITY}, () => {
      called = true
      return '0'
    }),
  )
  assert.equal(called, false)
})
