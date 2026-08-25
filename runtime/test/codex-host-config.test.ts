import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test, type TestContext} from 'node:test'

import {
  CodexHostConfigurationError,
  resolveCodexHostConfig,
  type CodexHostCatalog,
} from '../src/codex-host-config.js'
import {hostBinaryPath, hostWorkspacePath} from '../src/codex-process-owner.js'
import {loadSettings} from '../src/config.js'

function hostFixture(t: TestContext): {
  readonly root: string
  readonly binary: string
  readonly workspace: string
  readonly catalog: CodexHostCatalog
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nova-codex-host-')))
  const binary = join(root, 'codex-host')
  const workspace = join(root, 'workspace')
  writeFileSync(binary, '#!/host-only-fixture\n', {mode: 0o700})
  chmodSync(binary, 0o700)
  mkdirSync(workspace, {mode: 0o700})
  t.after(() => { rmSync(root, {recursive: true, force: true}) })
  return {
    root,
    binary,
    workspace,
    catalog: {
      canonicalBinaries: [binary],
      canonicalWorkspaces: [workspace],
      defaultBinary: binary,
      homeDirectory: root,
    },
  }
}

test('host resolver is lazy without Codex and brands one allowlisted launch tuple', t => {
  const fixture = hostFixture(t)
  const inactive = resolveCodexHostConfig(loadSettings({}), fixture.catalog)
  assert.equal(inactive, null)

  const resolved = resolveCodexHostConfig(loadSettings({
    NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
    NOVA_AUDIO_AGENT_CODEX_WORKSPACE: fixture.workspace,
    NOVA_AUDIO_AGENT_CODEX_API_KEY: 'secret-must-remain-opaque',
  }), fixture.catalog)
  assert.ok(resolved !== null)
  assert.equal(hostBinaryPath(resolved.binary), fixture.binary)
  assert.equal(hostWorkspacePath(resolved.workspace), fixture.workspace)
  assert.deepEqual(resolved.binaryPrefixArgs, [])
  assert.deepEqual({
    prewarm: resolved.prewarm,
    projects: resolved.projectsEnabled,
    interval: resolved.workingInterval,
    stateRoot: resolved.stateRoot,
    managedRoot: resolved.managedRoot,
  }, {
    prewarm: true,
    projects: false,
    interval: 30,
    stateRoot: null,
    managedRoot: null,
  })
  assert.equal(Object.hasOwn(resolved, 'apiKey'), false)
  assert.equal(JSON.stringify(resolved).includes('secret-must-remain-opaque'), false)
})

test('host resolver canonicalizes one direct Node launcher script', t => {
  const fixture = hostFixture(t)
  const launcher = join(fixture.root, 'codex.js')
  writeFileSync(launcher, '#!/usr/bin/env node\n')
  const resolved = resolveCodexHostConfig(loadSettings({
    NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
    NOVA_AUDIO_AGENT_CODEX_WORKSPACE: fixture.workspace,
    NOVA_AUDIO_AGENT_CODEX_BIN: fixture.binary,
    NOVA_AUDIO_AGENT_CODEX_PREFIX_ARGS: JSON.stringify([launcher]),
  }), fixture.catalog)
  assert.ok(resolved !== null)
  assert.deepEqual(resolved.binaryPrefixArgs, [realpathSync(launcher)])
})

test('selected Codex fails as host-unavailable when Task 8 has not supplied a catalog', t => {
  const fixture = hostFixture(t)
  assert.throws(
    () => resolveCodexHostConfig(loadSettings({
      NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
      NOVA_AUDIO_AGENT_CODEX_WORKSPACE: fixture.workspace,
      NOVA_AUDIO_AGENT_CODEX_API_KEY: 'secret-never-echo',
    }), {
      canonicalBinaries: [],
      canonicalWorkspaces: [],
      defaultBinary: null,
      homeDirectory: fixture.root,
    }),
    error => error instanceof CodexHostConfigurationError
      && error.code === 'codex_host_unavailable'
      && error.message === 'codex_host_unavailable'
      && !error.message.includes(fixture.workspace)
      && !error.message.includes('secret-never-echo'),
  )
})

test('an explicit allowlisted absolute binary does not require an implicit catalog default', t => {
  const fixture = hostFixture(t)
  const resolved = resolveCodexHostConfig(loadSettings({
    NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
    NOVA_AUDIO_AGENT_CODEX_WORKSPACE: fixture.workspace,
    NOVA_AUDIO_AGENT_CODEX_BIN: fixture.binary,
  }), {...fixture.catalog, defaultBinary: null})
  assert.ok(resolved !== null)
  assert.equal(hostBinaryPath(resolved.binary), fixture.binary)
})
