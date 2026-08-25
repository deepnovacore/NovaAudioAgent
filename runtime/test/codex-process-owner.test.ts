/* eslint-disable @typescript-eslint/require-await -- deterministic process fakes implement async owner contracts */
import assert from 'node:assert/strict'
import {spawn, type ChildProcess} from 'node:child_process'
import {EventEmitter} from 'node:events'
import {existsSync, realpathSync} from 'node:fs'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PassThrough} from 'node:stream'
import {test} from 'node:test'

import {
  CodexProcessOwnerError,
  PosixCodexProcessOwnerFactory,
  approvedCodexSpawnDetails,
  createApprovedCodexSpawnSpec,
  createApprovedCodexSpawnSpecForTest,
  hostBinaryForTest,
  hostBinaryFromConfig,
  hostEphemeralCodexHomeFromConfig,
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
  process.env.NOVA_CODEX_PARENT_SECRET_SENTINEL = 'must-not-cross'
  try {
    const spec = createApprovedCodexSpawnSpecForTest({
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
    assert.throws(
      () => hostEphemeralCodexHomeFromConfig(realpathSync(workspace), [process.cwd()]),
      (error: unknown) => error instanceof CodexProcessOwnerError && error.code === 'workspace_invalid',
    )
    assert.equal(
      hostEphemeralCodexHomeFromConfig(realpathSync(workspace), [realpathSync(workspace)]) !== undefined,
      true,
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

test('approved specs prepend one canonical JavaScript launcher without a shell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-prefix-'))
  const launcher = join(root, 'codex.js')
  await writeFile(launcher, '#!/usr/bin/env node\n')
  try {
    const workspace = process.cwd()
    const spec = createApprovedCodexSpawnSpec({
      binary: hostBinaryForTest(process.execPath),
      prefixArgs: [realpathSync(launcher)],
      workspace: hostWorkspaceForTest(workspace),
      codexHome: hostCodexHomeForTest(workspace, {ephemeral: true}),
      environment: {
        PATH: '/safe', HOME: '/home', CODEX_HOME: workspace,
        CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
      },
    })
    const details = approvedCodexSpawnDetails(spec)
    assert.deepEqual(details.argv, [realpathSync(launcher), ...EXACT_APP_SERVER_ARGV])
    assert.equal(details.shell, false)
  } finally {
    await rm(root, {recursive: true, force: true})
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
  const owner = await factory.spawn(spec, spawnControl())
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
  }), spawnControl())
  child.emit('exit', 0)
  assert.equal(await owner.waitTreeGone(25), false)
  assert.ok(probes.length >= 2)
  assert.equal(probes.every(target => target === -5151), true)
})

test('POSIX group liveness propagates non-ESRCH and non-EPERM probe failures', {
  skip: process.platform === 'win32',
}, async () => {
  const child = fakeChild(5252)
  let probeCount = 0
  const failure = new Error('private probe failure') as NodeJS.ErrnoException
  failure.code = 'EIO'
  const factory = new PosixCodexProcessOwnerFactory({
    spawn: (() => child) as unknown as typeof spawn,
    groupOperations: {
      signal: (_target, selected) => {
        probeCount += 1
        if (probeCount === 1) return
        assert.equal(selected, 0)
        throw failure
      },
      wait: async () => undefined,
      now: () => 0,
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
  }), spawnControl())
  await assert.rejects(
    owner.waitTreeGone(25),
    (error: unknown) => error instanceof CodexProcessOwnerError && error.code === 'spawn_failed',
  )
  child.emit('exit', null)
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
  }), spawnControl()), (caught: unknown) => (
    caught instanceof CodexProcessOwnerError && caught.code === 'spawn_failed'
  ))
  assert.equal(killed, true)
})

test('failed POSIX supervision confirms the whole group is gone before spawn rejects', {
  skip: process.platform === 'win32',
}, async () => {
  const child = fakeChild(6262)
  child.kill = () => { child.emit('exit', null); return true }
  let firstProbe = true
  let waitCalls = 0
  let groupGone = false
  const factory = new PosixCodexProcessOwnerFactory({
    spawn: (() => child) as unknown as typeof spawn,
    groupOperations: {
      signal: (_target, selected) => {
        if (firstProbe && selected === 0) {
          firstProbe = false
          const error = new Error('private supervision failure') as NodeJS.ErrnoException
          error.code = 'EINVAL'
          throw error
        }
        if (selected !== 0) return
        if (waitCalls < 2) return
        groupGone = true
        const error = new Error('group gone') as NodeJS.ErrnoException
        error.code = 'ESRCH'
        throw error
      },
      wait: async () => { waitCalls += 1 },
      now: () => waitCalls * 10,
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
  }), spawnControl()))
  assert.equal(groupGone, true)
  assert.equal(waitCalls >= 2, true)
})

test('persistent POSIX supervision failure retains the first owner and blocks a second spawn', {
  skip: process.platform === 'win32',
}, async () => {
  const child = fakeChild(6363)
  let streamDestroyCalls = 0
  for (const stream of [child.stdin, child.stdout, child.stderr] as PassThrough[]) {
    const destroy = stream.destroy.bind(stream)
    stream.destroy = error => {
      streamDestroyCalls += 1
      return destroy(error)
    }
  }
  let leaderKillCalls = 0
  child.kill = () => {
    leaderKillCalls += 1
    if (leaderKillCalls === 1) child.emit('exit', null)
    return true
  }
  let spawnCalls = 0
  const error = new Error('persistent private supervision failure') as NodeJS.ErrnoException
  error.code = 'EIO'
  const factory = new PosixCodexProcessOwnerFactory({
    spawn: (() => {
      spawnCalls += 1
      return child
    }) as unknown as typeof spawn,
    groupOperations: {
      signal: () => { throw error },
      wait: async () => undefined,
      now: () => 0,
    },
  })
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

  await assert.rejects(factory.spawn(spec, spawnControl()))
  assert.equal(streamDestroyCalls, 3, 'pipe shutdown must not final-dispose retained tree authority')
  await assert.rejects(factory.spawn(spec, spawnControl()))
  assert.equal(spawnCalls, 1)
  assert.equal(leaderKillCalls >= 2, true)
})

test('failed POSIX supervision kills an acknowledged real descendant group', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-supervision-fail-'))
  const readyFile = join(root, 'descendant-ready')
  let child: ChildProcess | null = null
  let childPid = 0
  let failedInitialProbe = false
  const injectedSpawn = ((
    _binary: string,
    _argv: readonly string[],
    options: Record<string, unknown>,
  ) => {
    child = spawn(process.execPath, [FAKE_APP_SERVER_PATH, 'descendant-ignore-term'], {
      ...options,
      env: {...options.env as Record<string, string>, NOVA_FAKE_DESCENDANT_READY_FILE: readyFile},
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    })
    childPid = child.pid ?? 0
    const deadline = Date.now() + 5000
    const waiter = new Int32Array(new SharedArrayBuffer(4))
    while (!existsSync(readyFile) && Date.now() < deadline) Atomics.wait(waiter, 0, 0, 10)
    assert.equal(existsSync(readyFile), true, 'grandchild must acknowledge before supervision fails')
    return child
  }) as unknown as typeof spawn
  let groupPid = 0
  try {
    const workspace = process.cwd()
    await assert.rejects(
      new PosixCodexProcessOwnerFactory({
        spawn: injectedSpawn,
        groupOperations: {
          signal: (target, signal) => {
            groupPid = target
            if (!failedInitialProbe && signal === 0) {
              failedInitialProbe = true
              const error = new Error('private supervision failure') as NodeJS.ErrnoException
              error.code = 'EINVAL'
              throw error
            }
            process.kill(target, signal)
          },
          wait: async milliseconds => { await new Promise(resolve => setTimeout(resolve, milliseconds)) },
          now: () => Date.now(),
        },
      }).spawn(createApprovedCodexSpawnSpec({
        binary: hostBinaryForTest(process.execPath),
        workspace: hostWorkspaceForTest(workspace),
        codexHome: hostCodexHomeForTest(workspace, {ephemeral: true}),
        environment: {
          PATH: '/safe', HOME: '/home', CODEX_HOME: workspace,
          CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
        },
      }), spawnControl()),
      (error: unknown) => error instanceof CodexProcessOwnerError && error.code === 'spawn_failed',
    )
    assert.equal(groupPid < 0, true)
    assert.throws(
      () => { process.kill(groupPid, 0) },
      (error: unknown) => (
        typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ESRCH'
      ),
    )
  } finally {
    if (childPid > 0) {
      try { process.kill(-childPid, 'SIGKILL') } catch { /* already gone */ }
    }
    await rm(root, {recursive: true, force: true})
  }
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

function spawnControl(): {readonly signal: AbortSignal; readonly expiresAtMs: number} {
  return {signal: new AbortController().signal, expiresAtMs: Date.now() + 5000}
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
  const owner = await factory.spawn(spec, spawnControl())
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
    spawnControl(),
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
