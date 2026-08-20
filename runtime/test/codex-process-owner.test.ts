/* eslint-disable @typescript-eslint/require-await -- deterministic process fakes implement async owner contracts */
import assert from 'node:assert/strict'
import {spawn, type ChildProcess} from 'node:child_process'
import {EventEmitter} from 'node:events'
import {realpathSync} from 'node:fs'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PassThrough} from 'node:stream'
import {test} from 'node:test'

import * as runtime from '../src/index.js'
import {
  CodexProcessOwnerError,
  PosixCodexProcessOwnerFactory,
  approvedCodexSpawnDetails,
  createApprovedCodexSpawnSpec,
  hostBinaryForTest,
  hostBinaryFromConfig,
  hostCodexHomeForTest,
  hostWorkspaceForTest,
  hostWorkspaceFromConfig,
} from '../src/codex-process-owner.js'
import {
  FAKE_APP_SERVER_PATH,
  FakeAppServerOwnerFactory,
} from './fixtures/codex/fake-app-server-owner.js'

const EXACT_APP_SERVER_ARGV = [
  '-a', 'never',
  '--disable', 'hooks',
  '--disable', 'multi_agent',
  '--disable', 'apps',
  '--disable', 'plugins',
  '--disable', 'remote_plugin',
  '--disable', 'plugin_sharing',
  '--disable', 'tool_suggest',
  '-c', 'web_search="disabled"',
  '-c', 'default_permissions="nova_audio_agent"',
  '-c', 'permissions.nova_audio_agent={ filesystem = { ":root" = "read", ":workspace_roots" = { "." = "write", ".git" = "read", ".agents" = "read", ".codex" = "read" } }, network = { enabled = false } }',
  '-c', 'shell_environment_policy.inherit="core"',
  '-c', 'shell_environment_policy.include_only=["PATH","LANG","LC_ALL","TERM"]',
  '-c', 'mcp_servers={}',
  'app-server', '--strict-config', '--stdio',
] as const

test('the host launch boundary ignores caller argv and parent secrets', () => {
  const module = runtime as unknown as Record<string, unknown>
  const build = typeof module.createApprovedCodexSpawnSpecForTest === 'function'
    ? module.createApprovedCodexSpawnSpecForTest as (input: Record<string, unknown>) => Record<string, unknown>
    : (input: Record<string, unknown>) => ({
      ...input,
      argv: input.argv,
      environment: process.env,
      shell: true,
      detached: false,
      stdio: 'inherit',
    })

  process.env.NOVA_CODEX_PARENT_SECRET_SENTINEL = 'must-not-cross'
  try {
    const spec = build({
      binary: process.execPath,
      workspace: process.cwd(),
      codexHome: process.cwd(),
      argv: ['--unsafe-from-renderer'],
      environment: {
        PATH: '/safe-path',
        HOME: '/safe-home',
        CODEX_HOME: process.cwd(),
        CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
      },
    })

    assert.deepEqual(spec.argv, EXACT_APP_SERVER_ARGV)
    assert.equal(spec.shell, false)
    assert.equal(spec.detached, true)
    assert.deepEqual(spec.stdio, ['pipe', 'pipe', 'pipe'])
    assert.equal(
      Object.hasOwn(spec.environment as Record<string, string>, 'NOVA_CODEX_PARENT_SECRET_SENTINEL'),
      false,
    )
  } finally {
    delete process.env.NOVA_CODEX_PARENT_SECRET_SENTINEL
  }
})

test('host brands reject noncanonical paths, scripts, and values outside the allowlist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-host-brand-'))
  const workspace = join(root, 'workspace')
  const script = join(root, 'guardian.cmd')
  await mkdir(workspace, {mode: 0o700})
  await writeFile(script, 'not-native', {mode: 0o700})
  try {
    assert.throws(
      () => hostWorkspaceFromConfig(`${realpathSync(workspace)}/.`, [realpathSync(workspace)]),
      (error: unknown) => error instanceof CodexProcessOwnerError && error.code === 'workspace_invalid',
    )
    assert.throws(
      () => hostWorkspaceFromConfig(realpathSync(workspace), [process.cwd()]),
      (error: unknown) => error instanceof CodexProcessOwnerError && error.code === 'workspace_invalid',
    )
    assert.throws(
      () => hostBinaryFromConfig(realpathSync(script), [realpathSync(script)]),
      (error: unknown) => error instanceof CodexProcessOwnerError && error.code === 'spawn_failed',
    )
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('approved specs reject leaked keys, missing remote disable, and mismatched CODEX_HOME', () => {
  const workspace = process.cwd()
  const input = {
    binary: hostBinaryForTest(process.execPath),
    workspace: hostWorkspaceForTest(workspace),
    codexHome: hostCodexHomeForTest(workspace, {ephemeral: true}),
  }
  for (const environment of [
    {PATH: '/safe', HOME: '/home', CODEX_HOME: workspace,
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1', PARENT_SECRET: 'leak'},
    {PATH: '/safe', HOME: '/home', CODEX_HOME: workspace},
    {PATH: '/safe', HOME: '/home', CODEX_HOME: '/wrong',
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1'},
  ]) {
    assert.throws(
      () => createApprovedCodexSpawnSpec({...input, environment}),
      (error: unknown) => error instanceof CodexProcessOwnerError && error.code === 'spawn_failed',
    )
  }
})

test('the POSIX factory performs the exact direct detached spawn', {
  skip: process.platform === 'win32',
}, async () => {
  const child = fakeChild(4242)
  let observed: {binary: string; argv: readonly string[]; options: Record<string, unknown>} | null = null
  const fakeSpawn = ((binary: string, argv: readonly string[], options: Record<string, unknown>) => {
    observed = {binary, argv, options}
    return child
  }) as unknown as typeof spawn
  const workspace = process.cwd()
  const spec = createApprovedCodexSpawnSpec({
    binary: hostBinaryForTest(process.execPath),
    workspace: hostWorkspaceForTest(workspace),
    codexHome: hostCodexHomeForTest(workspace, {ephemeral: true}),
    environment: {
      PATH: '/safe', HOME: '/home', CODEX_HOME: workspace,
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
    },
  })
  const factory = new PosixCodexProcessOwnerFactory({
    spawn: fakeSpawn,
    groupOperations: {
      signal: () => undefined,
      wait: async () => undefined,
      now: () => 0,
    },
  })
  const owner = await factory.spawn(spec)
  assert.deepEqual(observed, {
    binary: process.execPath,
    argv: [...EXACT_APP_SERVER_ARGV],
    options: {
      cwd: workspace,
      env: {
        PATH: '/safe', HOME: '/home', CODEX_HOME: workspace,
        CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
      },
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  })
  assert.deepEqual(approvedCodexSpawnDetails(spec).argv, EXACT_APP_SERVER_ARGV)
  child.emit('exit', 0)
  assert.equal(await owner.exit, 0)
})

test('POSIX group supervision treats EPERM as alive and never substitutes the leader pid', {
  skip: process.platform === 'win32',
}, async () => {
  const child = fakeChild(5151)
  let now = 0
  const probes: number[] = []
  const factory = new PosixCodexProcessOwnerFactory({
    spawn: (() => child) as unknown as typeof spawn,
    groupOperations: {
      signal: (target, selected) => {
        assert.equal(selected, 0)
        probes.push(target)
        const error = new Error('private errno') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      },
      wait: async milliseconds => { now += milliseconds },
      now: () => now,
    },
  })
  const workspace = process.cwd()
  const owner = await factory.spawn(createApprovedCodexSpawnSpec({
    binary: hostBinaryForTest(process.execPath),
    workspace: hostWorkspaceForTest(workspace),
    codexHome: hostCodexHomeForTest(workspace, {ephemeral: true}),
    environment: {
      PATH: '/safe', HOME: '/home', CODEX_HOME: workspace,
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
    },
  }))
  child.emit('exit', 0)
  assert.equal(await owner.waitTreeGone(25), false)
  assert.ok(probes.length >= 2)
  assert.equal(probes.every(target => target === -5151), true)
})

test('POSIX spawn fails closed when negative-PGID supervision cannot be established', {
  skip: process.platform === 'win32',
}, async () => {
  const child = fakeChild(6161)
  let killed = false
  child.kill = () => { killed = true; child.emit('exit', null); return true }
  const error = new Error('private supervision failure') as NodeJS.ErrnoException
  error.code = 'EINVAL'
  const factory = new PosixCodexProcessOwnerFactory({
    spawn: (() => child) as unknown as typeof spawn,
    groupOperations: {
      signal: () => { throw error },
      wait: async () => undefined,
      now: () => 0,
    },
  })
  const workspace = process.cwd()
  await assert.rejects(factory.spawn(createApprovedCodexSpawnSpec({
    binary: hostBinaryForTest(process.execPath),
    workspace: hostWorkspaceForTest(workspace),
    codexHome: hostCodexHomeForTest(workspace, {ephemeral: true}),
    environment: {
      PATH: '/safe', HOME: '/home', CODEX_HOME: workspace,
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
    },
  })), (caught: unknown) => (
    caught instanceof CodexProcessOwnerError && caught.code === 'spawn_failed'
  ))
  assert.equal(killed, true)
})

function fakeChild(pid: number): EventEmitter & Record<string, unknown> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.pid = pid
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  return child
}

test('a real POSIX leader exit does not hide its SIGTERM-ignoring descendant', {
  skip: process.platform === 'win32',
}, async () => {
  const workspace = process.cwd()
  const spec = createApprovedCodexSpawnSpec({
    binary: hostBinaryForTest(process.execPath),
    workspace: hostWorkspaceForTest(workspace),
    codexHome: hostCodexHomeForTest(workspace, {ephemeral: true}),
    environment: {
      PATH: '/safe', HOME: '/home', CODEX_HOME: workspace,
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
    },
  })
  const factory = new FakeAppServerOwnerFactory('descendant-ignore-term')
  const owner = await factory.spawn(spec)
  try {
    await bounded(owner.waitForBarrier('descendant_started'), 5000, 'descendant barrier')
    owner.release('leader_exit')
    assert.equal(await bounded(owner.exit, 5000, 'leader exit'), 0)
    assert.equal(await owner.waitTreeGone(50), false)
    await owner.terminateTree()
    assert.equal(await owner.waitTreeGone(100), false)
    await owner.killTree()
    assert.equal(await owner.waitTreeGone(5000), true)
  } finally {
    await owner.killTree().catch(() => undefined)
    await owner.dispose()
  }
})

test('the production POSIX owner reaps a real leader-first process group through KILL', {
  skip: process.platform === 'win32',
}, async () => {
  let resolveBarrier!: () => void
  const barrier = new Promise<void>(resolve => { resolveBarrier = resolve })
  let child: ChildProcess | null = null
  const injectedSpawn = ((
    _binary: string,
    _argv: readonly string[],
    options: Record<string, unknown>,
  ) => {
    child = spawn(process.execPath, [FAKE_APP_SERVER_PATH, 'descendant-ignore-term'], {
      ...options,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    })
    child.on('message', message => {
      if (
        typeof message === 'object'
        && message !== null
        && Reflect.get(message, 'type') === 'barrier'
        && Reflect.get(message, 'name') === 'descendant_started'
      ) resolveBarrier()
    })
    return child
  }) as unknown as typeof spawn
  const workspace = process.cwd()
  const owner = await new PosixCodexProcessOwnerFactory({spawn: injectedSpawn}).spawn(
    createApprovedCodexSpawnSpec({
      binary: hostBinaryForTest(process.execPath),
      workspace: hostWorkspaceForTest(workspace),
      codexHome: hostCodexHomeForTest(workspace, {ephemeral: true}),
      environment: {
        PATH: '/safe', HOME: '/home', CODEX_HOME: workspace,
        CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
      },
    }),
  )
  await bounded(barrier, 5000, 'production owner descendant barrier')
  try {
    child!.send?.({type: 'release', name: 'leader_exit'})
    assert.equal(await bounded(owner.exit, 5000, 'production owner leader exit'), 0)
    assert.equal(await owner.waitTreeGone(50), false)
    await owner.terminateTree()
    assert.equal(await owner.waitTreeGone(100), false)
    await owner.killTree()
    assert.equal(await owner.waitTreeGone(5000), true)
  } finally {
    await owner.killTree().catch(() => undefined)
    await owner.dispose()
  }
})

async function bounded<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`${label} timed out`)) }, milliseconds)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
