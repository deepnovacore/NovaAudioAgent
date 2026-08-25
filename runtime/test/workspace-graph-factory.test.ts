import assert from 'node:assert/strict'
import {chmod, mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {loadSettings} from '../src/config.js'
import {
  workspaceGraphServiceFromSettings,
} from '../src/workspace-graph/factory.js'

test('workspace graph factory is disabled by default and accepts only an owner-only parent', async () => {
  assert.equal(workspaceGraphServiceFromSettings(loadSettings({})), undefined)

  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-workspace-graph-factory-')))
  try {
    await chmod(root, 0o700)
    const graph = workspaceGraphServiceFromSettings(loadSettings({
      NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_ENABLED: 'true',
      NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_PATH: join(root, 'graph.sqlite'),
    }))
    assert.ok(graph !== undefined)
    await graph.open()
    await graph.close()
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('workspace graph factory rejects an unsafe parent with one fixed diagnostic', {
  skip: process.platform === 'win32' && 'Windows parent privacy is ACL-based, not mode-based',
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-workspace-graph-unsafe-')))
  const diagnostics: string[] = []
  try {
    await chmod(root, 0o755)
    const graph = workspaceGraphServiceFromSettings(loadSettings({
      NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_ENABLED: 'true',
      NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_PATH: join(root, 'sensitive-name.sqlite'),
    }), code => { diagnostics.push(code) })
    assert.equal(graph, undefined)
    assert.deepEqual(diagnostics, ['workspace_graph_configuration_invalid'])
    assert.equal(diagnostics.join('\n').includes(root), false)
    assert.equal(diagnostics.join('\n').includes('sensitive-name'), false)
  } finally {
    await chmod(root, 0o700)
    await rm(root, {recursive: true, force: true})
  }
})

test('factory constructs MyContext only when graph and endpoint are configured and never fetches eagerly', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-workspace-graph-provider-')))
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = () => {
    fetchCalls += 1
    return Promise.resolve(new Response(JSON.stringify({schema_version: 2, commands: {ask: {enabled: true}}}), {
      headers: {'content-type': 'application/json'},
    }))
  }
  try {
    await chmod(root, 0o700)
    const withoutProvider = workspaceGraphServiceFromSettings(loadSettings({
      NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_ENABLED: 'true',
      NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_PATH: join(root, 'without.sqlite'),
    }))
    assert.ok(withoutProvider !== undefined)
    await withoutProvider.open()
    const withoutCurrent = await withoutProvider.openWorkspace({
      path: '/safe/without', repository_fingerprint: 'host-without', now: 1,
    })
    assert.equal(withoutCurrent.kind, 'resolved')
    assert.equal((await withoutProvider.enrichAfterExplicitRecall({
      workspace_instance_id: withoutCurrent.instance.instance_id,
      query: 'why?',
      limit: 1,
    })).diagnostic, 'unavailable')
    assert.equal(fetchCalls, 0)
    await withoutProvider.close()

    const withProvider = workspaceGraphServiceFromSettings(loadSettings({
      NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_ENABLED: 'true',
      NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_PATH: join(root, 'with.sqlite'),
      NOVA_AUDIO_AGENT_MYCONTEXT_PROVIDER_URL: 'http://127.0.0.1:7412/v1',
    }))
    assert.ok(withProvider !== undefined)
    assert.equal(fetchCalls, 0)
    await withProvider.open()
    const current = await withProvider.openWorkspace({
      path: '/safe/with', repository_fingerprint: 'host-with', now: 2,
    })
    assert.equal(current.kind, 'resolved')
    withProvider.contextForTurn({
      session_epoch: 1,
      workspace_instance_id: current.instance.instance_id,
      utterance: 'why?',
      preferences: [],
    })
    JSON.stringify(withProvider.publishedSnapshot)
    assert.equal(fetchCalls, 0)
    assert.equal((await withProvider.enrichAfterExplicitRecall({
      workspace_instance_id: current.instance.instance_id,
      query: 'why?',
      limit: 1,
    })).diagnostic, 'unavailable')
    assert.equal(fetchCalls, 1, 'raw MyContext capabilities v2 must not reach lookup')
    await withProvider.close()
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, {recursive: true, force: true})
  }
})

test('factory rejects provider URLs with base-path tricks without exposing the endpoint', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nova-workspace-graph-provider-url-')))
  const diagnostics: string[] = []
  try {
    await chmod(root, 0o700)
    const graph = workspaceGraphServiceFromSettings(loadSettings({
      NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_ENABLED: 'true',
      NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_PATH: join(root, 'graph.sqlite'),
      NOVA_AUDIO_AGENT_MYCONTEXT_PROVIDER_URL: 'http://127.0.0.1:7412/v1/%2fprivate',
    }), code => { diagnostics.push(code) })
    assert.equal(graph, undefined)
    assert.deepEqual(diagnostics, ['workspace_graph_configuration_invalid'])
    assert.equal(diagnostics.join('\n').includes('127.0.0.1'), false)
    assert.equal(diagnostics.join('\n').includes('private'), false)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})
