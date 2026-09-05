import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, realpath, writeFile, symlink, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {attachKnowledgeReferences} from '../src/knowledge/references.js'

const hit = {locator: 'knowledge://source/chunk?d=0123456789ab', source_id: 'source', title: 'Manual', heading_path: 'Setup', text: 'Evidence only', score: 1}
const backend = {
  recall: () => Promise.resolve([hit]),
  getChunk: () => Promise.resolve({status: 'ok' as const, text: 'Evidence only', title: 'Manual', heading_path: 'Setup', source_id: 'source'}),
  listSources: () => Promise.resolve([{id: 'source', kind: 'url', locator: 'https://example.com'}]),
}
test('knowledge references are resolvable only when Codex MCP is exposed', async () => {
  const enabled = await attachKnowledgeReferences(backend, 'setup', null, true)
  assert.ok(enabled.references?.[0]?.includes(hit.locator))
  const disabled = await attachKnowledgeReferences(backend, 'setup', null, false)
  assert.deepEqual(disabled.references, [])
  assert.deepEqual(disabled.evidence_excerpts, ['"Evidence only"'])
})
test('removed/stale citations are dropped after recall and before rendering', async () => {
  for (const status of ['stale', 'gone'] as const) {
    const attached = await attachKnowledgeReferences({...backend, getChunk: () => Promise.resolve({status})}, 'setup', null, true)
    assert.deepEqual(attached, {references: [], evidence_excerpts: []})
  }
})
test('retrieval failure is evidence unavailable, never a planning failure', async () => {
  const attached = await attachKnowledgeReferences({...backend, recall: () => Promise.reject(Error('private error'))}, 'setup', null, false)
  assert.deepEqual(attached, {references: [], evidence_excerpts: []})
})

test('aborted planning does not wait for an unresponsive evidence resolver', async () => {
  const abort = new AbortController()
  let entered!: () => void
  const started = new Promise<void>(resolve => {entered = resolve})
  const attached = attachKnowledgeReferences({...backend, getChunk: () => {entered(); return new Promise(() => undefined)}}, 'setup', null, true, abort.signal)
  await started; abort.abort()
  assert.deepEqual(await attached, {references: [], evidence_excerpts: []})
})

test('only canonical in-workspace files produce relative references', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'knowledge-reference-'))
  const outside = await mkdtemp(join(await realpath(tmpdir()), 'knowledge-outside-'))
  try {
    await writeFile(join(root, 'manual.md'), 'content')
    await writeFile(join(outside, 'external.md'), 'outside')
    const local = {...backend, listSources: () => Promise.resolve([{id: 'source', kind: 'file', locator: join(root, 'manual.md')}])}
    const result = await attachKnowledgeReferences(local, 'setup', root, false)
    assert.ok(result.references?.[0]?.includes('"manual.md"'))
    assert.ok(!JSON.stringify(result).includes(root))
    let external = join(outside, 'external.md')
    // Windows file symlinks require privileges that the regular test runner need not have.
    if (process.platform !== 'win32') {
      await symlink(external, join(root, 'link.md'))
      external = join(root, 'link.md')
    }
    const escaping = {...backend, listSources: () => Promise.resolve([{id: 'source', kind: 'file', locator: external}])}
    const escaped = await attachKnowledgeReferences(escaping, 'setup', root, false)
    assert.deepEqual(escaped.references, [])
    assert.deepEqual(escaped.evidence_excerpts, ['"Evidence only"'])
  } finally {await rm(root, {recursive: true, force: true}); await rm(outside, {recursive: true, force: true})}
})
