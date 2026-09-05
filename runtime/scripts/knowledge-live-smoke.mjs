import assert from 'node:assert/strict'
import {mkdtemp, realpath, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {loadSettings} from '../dist/src/config.js'
import {parseCapabilityRegistry} from '../dist/src/capability-registry.js'
import {prepareKnowledge} from '../dist/src/knowledge/assembly.js'
import {RealClock} from '../dist/src/clock.js'

// Live validation sends only this synthetic document and query, never a user's corpus.
const directory = await mkdtemp(join(await realpath(tmpdir()), 'nova-knowledge-smoke-'))
let knowledge
try {
  const settings = {...loadSettings(), knowledge_path: join(directory, 'private', 'knowledge.sqlite')}
  const capabilities = parseCapabilityRegistry({version: 1, modules: {
    search: {enabled: false}, camera: {enabled: false}, coding: {enabled: false}, knowledge: {enabled: true},
  }}, {})
  knowledge = await prepareKnowledge(settings, capabilities)
  assert.ok(knowledge)
  const file = join(directory, 'synthetic-manual.md')
  await writeFile(file, '# Nova synthetic guide\nThe blue indicator means the device is ready. The amber indicator means it is waiting for input.\n')
  const ingest = await knowledge.service.handle('knowledge.ingest', {kind: 'file', locator: file, consent: true})
  assert.equal(ingest?.ok, true)
  const result = await knowledge.adapter.dispatch('recall', {query: 'What does the blue indicator mean?', k: 3}, {
    clock: new RealClock(), delegate: {delegate_id: 'knowledge-live-smoke'}, signal: AbortSignal.timeout(15000), progress: () => undefined,
  })
  assert.equal(result.outcome, 'ok')
  assert.equal(result.trust, 'untrusted_external')
  const hits = await knowledge.service.recall('blue indicator', 1)
  assert.equal(hits.length, 1)
  assert.equal((await knowledge.service.getChunk(hits[0].locator)).status, 'ok')
  assert.ok(!JSON.stringify(result).includes(directory))
  process.stdout.write(`Knowledge MCP PASS: real embedding + Worker retrieval + digest-pinned citation; trust=${result.trust}; Node=${process.version}; platform=${process.platform}\n`)
} catch {
  process.stderr.write('Knowledge MCP FAIL: live_verification_failed\n')
  process.exitCode = 1
} finally {
  await knowledge?.close()
  await rm(directory, {recursive: true, force: true})
}
