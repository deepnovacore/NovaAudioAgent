import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {resolve} from 'node:path'
import {test} from 'node:test'

import {
  codePointLengthLikePython,
  collapsePythonWhitespace,
  stripLikePython,
} from '../src/python-text.js'

const run = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../../..')

test('typed Node parity audit accepts only reviewed hashed occurrences', async () => {
  const result = await run(process.execPath, ['runtime/scripts/node-parity-audit.mjs', '--check'], {
    cwd: repositoryRoot,
  })
  assert.match(result.stdout, /Node parity audit passed/u)
  assert.equal(result.stderr, '')
})

test('parity helpers pin Python whitespace disagreements and astral code-point length', () => {
  assert.equal(stripLikePython('\u001c\u001d\u001e\u001f\u0085value\u0085'), 'value')
  assert.equal(stripLikePython('\ufeffvalue\ufeff'), '\ufeffvalue\ufeff')
  assert.equal(codePointLengthLikePython('A😀B'), 3)
  assert.equal('A😀B'.length, 4)
  assert.equal(collapsePythonWhitespace('\u001c\u0085\ufeffx\ufeff'), ' \ufeffx\ufeff')
})
