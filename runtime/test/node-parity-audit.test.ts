import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {readFile} from 'node:fs/promises'
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

test('every occurrence names an existing behavior test and a narrow disposition', async () => {
  const manifest = JSON.parse(await readFile(
    resolve(repositoryRoot, 'runtime/node-parity-audit.json'),
    'utf8',
  )) as {
    schema_version: number
    occurrences: readonly {
      kind: string
      disposition: string
      test: string
      behavior: string
    }[]
  }
  assert.equal(manifest.schema_version, 2)
  for (const occurrence of manifest.occurrences) {
    assert.notEqual(occurrence.test, 'runtime/test/node-parity-audit.test.ts')
    assert.notEqual(occurrence.behavior, '')
    const source = await readFile(resolve(repositoryRoot, occurrence.test), 'utf8')
    assert.ok(source.includes(occurrence.behavior), occurrence.test)
    if (occurrence.kind === 'string_length') {
      assert.ok(
        occurrence.disposition === 'byte_length'
          || occurrence.disposition === 'intentional_utf16',
      )
    }
  }
})

test('parity audit cannot bulk-write unaudited dispositions', async () => {
  const manifest = resolve(repositoryRoot, 'runtime/node-parity-audit.json')
  const before = await readFile(manifest, 'utf8')
  await assert.rejects(
    run(process.execPath, ['runtime/scripts/node-parity-audit.mjs', '--write'], {
      cwd: repositoryRoot,
    }),
    failure => {
      assert.equal((failure as {code?: number}).code, 2)
      assert.match((failure as {stderr?: string}).stderr ?? '', /refuses bulk exemptions/u)
      return true
    },
  )
  assert.equal(await readFile(manifest, 'utf8'), before)
})

test('parity inventory is read-only and contains no automatic review decisions', async () => {
  const manifest = resolve(repositoryRoot, 'runtime/node-parity-audit.json')
  const before = await readFile(manifest, 'utf8')
  const result = await run(process.execPath, ['runtime/scripts/node-parity-audit.mjs', '--inventory'], {
    cwd: repositoryRoot,
  })
  const inventory = JSON.parse(result.stdout) as {
    occurrences: readonly Record<string, unknown>[]
  }
  assert.ok(inventory.occurrences.length > 0)
  assert.equal(inventory.occurrences.some(item => 'disposition' in item || 'test' in item), false)
  assert.equal(await readFile(manifest, 'utf8'), before)
})

test('parity inventory detects mixed numeric rendering and Unicode-sensitive regex classes', async () => {
  const result = await run(process.execPath, ['runtime/scripts/node-parity-audit.mjs', '--inventory'], {
    cwd: repositoryRoot,
  })
  const inventory = JSON.parse(result.stdout) as {
    occurrences: readonly {file: string; kind: string}[]
  }
  assert.equal(inventory.occurrences.some(occurrence =>
    occurrence.file === 'runtime/src/config.ts'
      && occurrence.kind === 'numeric_string'), true)
  assert.equal(inventory.occurrences.some(occurrence =>
    occurrence.file === 'runtime/src/realtime/qwen.ts'
      && occurrence.kind === 'regex_unicode_semantics'), true)
})

test('parity helpers pin Python whitespace disagreements and astral code-point length', () => {
  assert.equal(stripLikePython('\u001c\u001d\u001e\u001f\u0085value\u0085'), 'value')
  assert.equal(stripLikePython('\ufeffvalue\ufeff'), '\ufeffvalue\ufeff')
  assert.equal(codePointLengthLikePython('A😀B'), 3)
  assert.equal('A😀B'.length, 4)
  assert.equal(collapsePythonWhitespace('\u001c\u0085\ufeffx\ufeff'), ' \ufeffx\ufeff')
})
