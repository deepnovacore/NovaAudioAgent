import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {readFile} from 'node:fs/promises'
import {promisify} from 'node:util'
import {resolve} from 'node:path'
import {test} from 'node:test'
import {pathToFileURL} from 'node:url'

import {
  codePointLengthLikePython,
  collapsePythonWhitespace,
  stripLikePython,
} from '../src/python-text.js'

const run = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../../..')
interface NodeParityPathHelpers {
  readonly canonicalAuditPath: (value: string) => string
  readonly isAuditedSource: (value: string) => boolean
}

function isCanonicalAuditPath(value: unknown): value is NodeParityPathHelpers['canonicalAuditPath'] {
  return typeof value === 'function'
}

function isAuditedSourceHelper(value: unknown): value is NodeParityPathHelpers['isAuditedSource'] {
  return typeof value === 'function'
}

function nodeParityPathHelpersFrom(value: unknown): NodeParityPathHelpers {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('invalid node parity path helper exports')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const canonicalAuditPath: unknown = descriptors.canonicalAuditPath?.value
  const isAuditedSource: unknown = descriptors.isAuditedSource?.value
  if (!isCanonicalAuditPath(canonicalAuditPath) || !isAuditedSourceHelper(isAuditedSource)) {
    throw new TypeError('invalid node parity path helper exports')
  }
  return {canonicalAuditPath, isAuditedSource}
}

const nodeParityPathHelperModule: unknown = await import(
  pathToFileURL(resolve(repositoryRoot, 'runtime/scripts/node-parity-paths.mjs')).href
)
const nodeParityPathHelpers = nodeParityPathHelpersFrom(nodeParityPathHelperModule)
const {canonicalAuditPath, isAuditedSource} = nodeParityPathHelpers

test('parity helper converts a Windows absolute path into an ESM file URL', () => {
  assert.equal(
    pathToFileURL('C:\\nova audio\\node-parity-paths.mjs', {windows: true}).href,
    'file:///C:/nova%20audio/node-parity-paths.mjs',
  )
})

test('parity path helper boundary rejects non-callable source exports', () => {
  assert.throws(
    () => nodeParityPathHelpersFrom({
      canonicalAuditPath: 'not a function',
      isAuditedSource: () => true,
    }),
    /invalid node parity path helper exports/u,
  )
})

test('platform-independent source inventory', () => {
  assert.equal(canonicalAuditPath('runtime\\src\\config.ts'), 'runtime/src/config.ts')
  assert.equal(isAuditedSource('runtime\\src\\unicode-tables.ts'), false)
  assert.equal(isAuditedSource('runtime/src/unicode-tables.ts'), false)
  assert.equal(isAuditedSource('runtime\\src\\config.ts'), true)
})

test('typed Node parity audit accepts only reviewed hashed occurrences', async () => {
  const result = await run(process.execPath, ['runtime/scripts/node-parity-audit.mjs', '--check'], {
    cwd: repositoryRoot,
  })
  assert.match(result.stdout, /Node parity audit passed/u)
  assert.equal(result.stderr, '')
})

test('parity inventory names the final pipeline units and settings controller', async () => {
  const manifest = JSON.parse(await readFile(
    resolve(repositoryRoot, 'runtime/node-parity-audit.json'),
    'utf8',
  )) as {files: readonly string[]}
  const finalUnits = [
    'desktop/ambient-orb/src/renderer/secret-revisions.mjs',
    'desktop/ambient-orb/src/renderer/settings-controller.mjs',
    'runtime/src/cascaded-realtime-assembly.ts',
    'runtime/src/cascaded-realtime-config.ts',
    'runtime/src/integrated-realtime-assembly.ts',
    'runtime/src/realtime/cascaded/adapter.ts',
    'runtime/src/realtime/cascaded/ark-llm.ts',
    'runtime/src/realtime/cascaded/llm.ts',
    'runtime/src/realtime/cascaded/ports.ts',
    'runtime/src/realtime/cascaded/provider.ts',
    'runtime/src/realtime/cascaded/qwen-llm.ts',
  ]
  for (const file of finalUnits) assert.ok(manifest.files.includes(file), file)
  for (const retired of [
    'runtime/src/realtime/volcengine/adapter.ts',
    'runtime/src/realtime/volcengine/provider.ts',
    'runtime/src/volcengine-realtime-assembly.ts',
  ]) assert.equal(manifest.files.includes(retired), false, retired)
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
