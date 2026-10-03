import assert from 'node:assert/strict'
import {rm, readdir} from 'node:fs/promises'
import {join} from 'node:path'
import {test} from 'node:test'
import {fixture, run} from './fixtures/codex/project-adapter-fixture.js'
import type {CodingBackendId} from '../src/config/coding-backends.js'

test('default changes affect only new sessions and non-Codex runs need no Codex home', async () => {
  let backend: CodingBackendId = 'opencode'
  const value = await fixture({defaultBackend: () => ({backend_id: backend, backend_profile_id: `${backend}:default`})})
  const presented: string[] = []
  value.adapter.observeProjectView(view => {
    const running = view.roster?.flatMap(entry => entry.running).find(work => work.backend_id !== undefined)?.backend_id
    if (running !== undefined) presented.push(running)
  })
  try {
    assert.equal((await run(value, 'first', {session: 'new'})).outcome, 'ok')
    assert.equal(presented.at(-1), 'opencode')
    backend = 'deepseek'
    assert.equal((await run(value, 'continue')).outcome, 'ok')
    assert.equal(presented.at(-1), 'opencode', 'resumed task keeps its bound backend despite the new default')
    assert.equal((await run(value, 'second', {session: 'new'})).outcome, 'ok')
    assert.equal(presented.at(-1), 'deepseek')
    assert.deepEqual(value.factory.bindings.map(binding => [binding.backend_id, binding.backend_profile_id]), [
      ['opencode', 'opencode:default'], ['opencode', 'opencode:default'], ['deepseek', 'deepseek:default'],
    ])
    assert.equal(value.factory.bindings[1]?.resumeThreadId, value.factory.transports[0]?.threadId)
    assert.ok(value.factory.bindings.every(binding => binding.codexHome === null))
    assert.equal(await value.adapter.codingBackendFor(null), 'deepseek')
    const sessions = await value.store.listSessions((await value.store.snapshot()).workspaces[0]!)
    for (const session of sessions) assert.equal(await value.adapter.codingBackendFor(session.session_id), session.backend_id)
    const homes = await readdir(join(value.root, 'state', 'codex-homes')).catch(() => [])
    assert.deepEqual(homes, [])
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('without a configured default every session stays on the legacy Codex binding', async () => {
  const value = await fixture()
  try {
    assert.equal((await run(value, 'first', {session: 'new'})).outcome, 'ok')
    assert.deepEqual(value.factory.bindings.map(binding => [binding.backend_id, binding.backend_profile_id]), [['codex', 'codex:legacy']])
    assert.notEqual(value.factory.bindings[0]?.codexHome, null)
    const session = (await value.store.snapshot()).sessions[0]!
    assert.equal(session.codex_thread_id, session.backend_session_id)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})
