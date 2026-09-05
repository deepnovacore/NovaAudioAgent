import assert from 'node:assert/strict'
import {mkdtemp, rm, realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {prepareKnowledge} from '../src/knowledge/assembly.js'
import {parseCapabilityRegistry} from '../src/capability-registry.js'
import {settingsSchema} from '../src/config.js'
import {buildAssembly} from '../src/assembly.js'
import {frontendInstructions} from '../src/realtime/qwen.js'
import {prepareManagedCodexMcp, managedMcpConfigToml, managedMcpEnvironment} from '../src/executors/codex/managed-mcp.js'

test('knowledge disabled allocates nothing; forced local provider fails before opening a store', async () => {
  assert.ok(!frontendInstructions().includes('mcp__nova_knowledge__recall'))
  assert.ok(frontendInstructions({knowledge: true}).includes('mcp__nova_knowledge__recall'))
  const capabilities = parseCapabilityRegistry({version: 1, modules: {knowledge: {enabled: false}}}, {})
  const settings = settingsSchema.parse({executors: [], embedding_provider: 'local'})
  assert.equal(await prepareKnowledge(settings, capabilities), undefined)
  const enabled = parseCapabilityRegistry({version: 1, modules: {knowledge: {enabled: true}}}, {})
  await assert.rejects(prepareKnowledge(settings, enabled), /embedding_provider_unavailable/)
})

test('prepared knowledge contributes exactly its read-only MCP tool and closes with assembly', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'knowledge-assembly-'))
  const capabilities = parseCapabilityRegistry({version: 1, modules: {search: {enabled: false}, camera: {enabled: false}, coding: {enabled: false}, knowledge: {enabled: true}}}, {})
  const settings = settingsSchema.parse({executors: [], model_api_key: 'test-key', knowledge_path: join(directory, 'private', 'knowledge.sqlite')})
  try {
    const knowledge = await prepareKnowledge(settings, capabilities)
    assert.ok(knowledge)
    try {
      const assembly = buildAssembly({settings, capabilities, knowledge})
      const tools = [...assembly.tools.bindings.keys()]
      assert.ok(tools.includes('mcp__nova_knowledge__recall'))
      assert.ok(!tools.includes('knowledge__recall'))
      assert.ok(!tools.includes('mcp__nova_knowledge__get_chunk'))
      assert.deepEqual(knowledge.codexEntries, {})
      await assembly.start()
      await assembly.stop()
      await assert.rejects(knowledge.service.listSources())
    } finally {await knowledge.close()}
  } finally {await rm(directory, {recursive: true, force: true})}
})

test('Codex knowledge projection contains both resolvers and keeps token out of persisted config', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'knowledge-codex-'))
  const capabilities = parseCapabilityRegistry({version: 1, modules: {knowledge: {enabled: true, exposeToCodex: true}}}, {})
  const settings = settingsSchema.parse({executors: [], model_api_key: 'test-key', knowledge_path: join(directory, 'private', 'knowledge.sqlite')})
  try {
    const knowledge = await prepareKnowledge(settings, capabilities)
    assert.ok(knowledge)
    try {
      const managed = prepareManagedCodexMcp(capabilities, knowledge.codexEntries)
      assert.deepEqual(managed.servers.nova_knowledge?.enabled_tools, ['recall', 'get_chunk'])
      const url = managed.servers.nova_knowledge?.url
      assert.ok(url)
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/u)
      const secret = managedMcpEnvironment(managed).NOVA_MANAGED_MCP_NOVA_KNOWLEDGE_TOKEN
      assert.ok(secret)
      assert.ok(!managedMcpConfigToml(managed).includes(secret))
    } finally {await knowledge.close()}
  } finally {await rm(directory, {recursive: true, force: true})}
})

test('knowledge close failure does not skip camera cleanup', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'knowledge-cleanup-'))
  const capabilities = parseCapabilityRegistry({version: 1, modules: {search: {enabled: false}, coding: {enabled: false}, knowledge: {enabled: true}}}, {})
  const settings = settingsSchema.parse({executors: [], model_api_key: 'test-key', knowledge_path: join(directory, 'private', 'knowledge.sqlite')})
  const knowledge = await prepareKnowledge(settings, capabilities)
  assert.ok(knowledge)
  let stopped = false
  try {
    const assembly = buildAssembly({settings, capabilities,
      knowledge: {...knowledge, close: async () => {await knowledge.close(); throw new Error('close_failed')}},
      frameSource: {start: () => Promise.resolve(), stop: () => {stopped = true; return Promise.resolve()}, snapshot: () => Promise.resolve(null)},
    })
    await assembly.start()
    await assert.rejects(assembly.stop(), /close_failed/)
    assert.equal(stopped, true)
  } finally {await knowledge.close(); await rm(directory, {recursive: true, force: true})}
})
