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

test('workspace graph factory rejects an unsafe parent with one fixed diagnostic', async () => {
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
