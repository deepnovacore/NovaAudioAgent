import assert from 'node:assert/strict'
import fs, {
  fchmodSync,
  renameSync,
} from 'node:fs'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
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
  assert.deepEqual({
    prewarm: resolved.prewarm,
    interval: resolved.workingInterval,
  }, {
    prewarm: true,
    interval: 30,
  })
  assert.equal(Object.hasOwn(resolved, 'projectsEnabled'), false)
  assert.ok(resolved.stateRoot !== null)
  assert.ok(resolved.managedRoot !== null)
  const stateRoot = join(fixture.root, '.nova-audio-agent')
  const managedRoot = join(stateRoot, 'workspaces')
  assert.equal(existsSync(stateRoot), true)
  assert.equal(existsSync(managedRoot), true)
  assert.equal(lstatSync(stateRoot).mode & 0o777, 0o700)
  assert.equal(lstatSync(managedRoot).mode & 0o777, 0o700)
  assert.equal(Object.hasOwn(resolved, 'apiKey'), false)
  assert.equal(JSON.stringify(resolved).includes('secret-must-remain-opaque'), false)
})

test('host resolver expands a leading tilde in the selected Codex workspace', t => {
  const fixture = hostFixture(t)
  const resolved = resolveCodexHostConfig(loadSettings({
    NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
    NOVA_AUDIO_AGENT_CODEX_WORKSPACE: '~/workspace',
  }), fixture.catalog)

  assert.ok(resolved !== null)
  assert.equal(hostWorkspacePath(resolved.workspace), fixture.workspace)
})

test('host resolver never chmods a replacement for a newly created private root', t => {
  const fixture = hostFixture(t)
  const stateRoot = join(fixture.root, 'state')
  const retainedRoot = join(fixture.root, 'state-created-away')
  const managedRoot = join(fixture.root, 'managed')
  const originalFchmod = fchmodSync
  let replaced = false
  t.mock.method(fs, 'fchmodSync', (descriptor: number, mode: number) => {
    if (!replaced) {
      renameSync(stateRoot, retainedRoot)
      mkdirSync(stateRoot, {mode: 0o755})
      chmodSync(stateRoot, 0o755)
      replaced = true
    }
    originalFchmod(descriptor, mode)
  })
  syncBuiltinESMExports()
  try {
    assert.throws(
      () => resolveCodexHostConfig(loadSettings({
        NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
        NOVA_AUDIO_AGENT_CODEX_WORKSPACE: fixture.workspace,
        NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT: stateRoot,
        NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT: managedRoot,
      }), fixture.catalog),
      error => error instanceof CodexHostConfigurationError
        && error.code === 'codex_project_state_invalid',
    )
    assert.equal(replaced, true)
    assert.equal(lstatSync(stateRoot).mode & 0o7777, 0o755)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
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
