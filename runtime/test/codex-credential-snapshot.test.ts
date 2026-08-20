import assert from 'node:assert/strict'
import {chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import * as runtime from '../src/index.js'
import {
  CredentialSnapshotter,
  credentialSnapshotEnvironment,
  MAX_CREDENTIAL_BYTES,
  MAX_CREDENTIAL_MARKER_BYTES,
} from '../src/codex-credential-snapshot.js'
import {hostCodexHomeForTest} from '../src/codex-process-owner.js'

test('saved login is copied privately and the child environment is an exact allowlist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-credential-'))
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  await mkdir(source, {mode: 0o700})
  await mkdir(destination, {mode: 0o700})
  await writeFile(join(source, 'auth.json'), '{"token":"credential-sentinel"}', {mode: 0o600})
  await chmod(join(source, 'auth.json'), 0o600)
  try {
    const module = runtime as unknown as Record<string, unknown>
    const prepare = typeof module.prepareCodexCredentialSnapshotForTest === 'function'
      ? module.prepareCodexCredentialSnapshotForTest as (
        input: Readonly<Record<string, unknown>>,
      ) => Promise<Record<string, unknown>>
      : (input: Readonly<Record<string, unknown>>) => {
        void input
        return Promise.resolve({environment: {...process.env}})
      }
    process.env.NOVA_PARENT_CREDENTIAL_SENTINEL = 'must-not-cross'

    const result = await prepare({
      sourceHome: await realpath(source),
      destinationHome: await realpath(destination),
      apiKey: null,
      environment: {
        PATH: '/safe-path',
        HOME: '/safe-home',
        LANG: 'C.UTF-8',
        NOVA_PARENT_CREDENTIAL_SENTINEL: 'must-not-cross',
      },
    })

    assert.equal(await readFile(join(destination, 'auth.json'), 'utf8'), '{"token":"credential-sentinel"}')
    assert.equal((await lstat(join(destination, 'auth.json'))).mode & 0o777, 0o600)
    const marker = JSON.parse(await readFile(
      join(destination, '.nova-credential-source-v1.json'),
      'utf8',
    )) as Record<string, unknown>
    assert.match(marker['auth.json'] as string, /^[0-9a-f]{64}$/u)
    assert.deepEqual(Object.keys(result.environment as Record<string, string>).sort(), [
      'CODEX_HOME',
      'CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED',
      'HOME',
      'LANG',
      'PATH',
    ])
  } finally {
    delete process.env.NOVA_PARENT_CREDENTIAL_SENTINEL
    await rm(root, {recursive: true, force: true})
  }
})

test('an API key skips hostile saved-login files and remains process-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-key-'))
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  const outside = join(root, 'outside-auth')
  await mkdir(source, {mode: 0o700})
  await mkdir(destination, {mode: 0o700})
  await writeFile(outside, 'saved-login-secret', {mode: 0o600})
  await symlink(outside, join(source, 'auth.json'))
  try {
    const home = hostCodexHomeForTest(await realpath(destination), {ephemeral: true})
    const snapshotter = new CredentialSnapshotter({
      sourceHome: await realpath(source),
      environment: {PATH: '/safe-path', HOME: '/safe-home', SECRET_SENTINEL: 'drop-me'},
    })
    const snapshot = await snapshotter.prepare({codexHome: home, apiKey: 'api-key-process-only'})
    assert.deepEqual(credentialSnapshotEnvironment(snapshot), {
      PATH: '/safe-path',
      HOME: '/safe-home',
      CODEX_HOME: await realpath(destination),
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
      CODEX_API_KEY: 'api-key-process-only',
    })
    await assert.rejects(readFile(join(destination, 'auth.json')), {code: 'ENOENT'})
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('credential no-follow, mode, and exact byte bounds fail with only credential_missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-bound-'))
  try {
    for (const scenario of ['symlink', 'group-write', 'over-limit'] as const) {
      const source = join(root, `${scenario}-source`)
      const destination = join(root, `${scenario}-destination`)
      await mkdir(source, {mode: 0o700})
      await mkdir(destination, {mode: 0o700})
      const auth = join(source, 'auth.json')
      if (scenario === 'symlink') {
        const outside = join(root, `${scenario}-outside`)
        await writeFile(outside, 'credential-secret', {mode: 0o600})
        await symlink(outside, auth)
      } else {
        await writeFile(
          auth,
          scenario === 'over-limit'
            ? new Uint8Array(MAX_CREDENTIAL_BYTES + 1)
            : 'credential-secret',
          {mode: scenario === 'group-write' ? 0o620 : 0o600},
        )
        await chmod(auth, scenario === 'group-write' ? 0o620 : 0o600)
      }
      const snapshotter = new CredentialSnapshotter({
        sourceHome: await realpath(source),
        environment: {PATH: '/safe-path', HOME: '/safe-home'},
      })
      const home = hostCodexHomeForTest(await realpath(destination), {ephemeral: true})
      await assert.rejects(
        snapshotter.prepare({codexHome: home, apiKey: null}),
        (error: unknown) => {
          assert.equal(String(error), 'CodexCredentialError: credential_missing')
          assert.equal(String(error).includes(root), false)
          assert.equal(String(error).includes('credential-secret'), false)
          return true
        },
      )
    }
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('the exact 1 MiB credential is accepted and unchanged-source preserves destination edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-refresh-'))
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  await mkdir(source, {mode: 0o700})
  await mkdir(destination, {mode: 0o700})
  const exact = new Uint8Array(MAX_CREDENTIAL_BYTES)
  exact.fill(0x61)
  await writeFile(join(source, 'auth.json'), exact, {mode: 0o600})
  try {
    const snapshotter = new CredentialSnapshotter({
      sourceHome: await realpath(source),
      environment: {PATH: '/safe-path', HOME: '/safe-home'},
    })
    const home = hostCodexHomeForTest(await realpath(destination), {ephemeral: true})
    await snapshotter.prepare({codexHome: home, apiKey: null})
    assert.equal((await readFile(join(destination, 'auth.json'))).byteLength, MAX_CREDENTIAL_BYTES)

    await writeFile(join(destination, 'auth.json'), 'destination-only-edit', {mode: 0o600})
    await chmod(join(destination, 'auth.json'), 0o600)
    await snapshotter.prepare({codexHome: home, apiKey: null})
    assert.equal(await readFile(join(destination, 'auth.json'), 'utf8'), 'destination-only-edit')

    await writeFile(join(source, 'auth.json'), 'new-source-value', {mode: 0o600})
    await chmod(join(source, 'auth.json'), 0o600)
    await snapshotter.prepare({codexHome: home, apiKey: null})
    assert.equal(await readFile(join(destination, 'auth.json'), 'utf8'), 'new-source-value')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('credential marker exact byte bound is accepted and over-bound or hostile destination fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-marker-'))
  const source = join(root, 'source')
  const exactDestination = join(root, 'exact-destination')
  const overDestination = join(root, 'over-destination')
  const hostileDestination = join(root, 'hostile-destination')
  await mkdir(source, {mode: 0o700})
  await mkdir(exactDestination, {mode: 0o700})
  await mkdir(overDestination, {mode: 0o700})
  await mkdir(hostileDestination, {mode: 0o700})
  const markerBody = `{"auth.json":"${'a'.repeat(64)}"}`
  const exactMarker = `${markerBody}${' '.repeat(MAX_CREDENTIAL_MARKER_BYTES - Buffer.byteLength(markerBody))}`
  await writeFile(
    join(exactDestination, '.nova-credential-source-v1.json'),
    exactMarker,
    {mode: 0o600},
  )
  await writeFile(
    join(overDestination, '.nova-credential-source-v1.json'),
    `${exactMarker} `,
    {mode: 0o600},
  )
  await writeFile(join(source, 'auth.json'), 'new-source', {mode: 0o600})
  const outside = join(root, 'outside-destination')
  await writeFile(outside, 'destination-secret', {mode: 0o600})
  await symlink(outside, join(hostileDestination, 'auth.json'))
  try {
    const snapshotter = new CredentialSnapshotter({
      sourceHome: await realpath(source),
      environment: {PATH: '/safe-path', HOME: '/safe-home'},
    })
    await snapshotter.prepare({
      codexHome: hostCodexHomeForTest(await realpath(exactDestination), {ephemeral: true}),
      apiKey: null,
    })
    assert.equal((await lstat(join(exactDestination, 'auth.json'))).mode & 0o777, 0o600)
    assert.equal(
      (await lstat(join(exactDestination, '.nova-credential-source-v1.json'))).mode & 0o777,
      0o600,
    )
    for (const destination of [overDestination, hostileDestination]) {
      await assert.rejects(
        snapshotter.prepare({
          codexHome: hostCodexHomeForTest(await realpath(destination), {ephemeral: true}),
          apiKey: null,
        }),
        (error: unknown) => String(error) === 'CodexCredentialError: credential_missing',
      )
    }
    assert.equal(await readFile(outside, 'utf8'), 'destination-secret')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('ephemeral cleanup is exact and idempotent while persistent homes remain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-clean-home-'))
  const ephemeralPath = join(root, 'ephemeral')
  const persistentPath = join(root, 'persistent')
  await mkdir(ephemeralPath, {mode: 0o700})
  await mkdir(persistentPath, {mode: 0o700})
  try {
    const snapshotter = new CredentialSnapshotter({environment: {PATH: '/safe', HOME: '/home'}})
    const ephemeral = hostCodexHomeForTest(await realpath(ephemeralPath), {ephemeral: true})
    const persistent = hostCodexHomeForTest(await realpath(persistentPath), {ephemeral: false})
    await snapshotter.removeEphemeralHome(ephemeral)
    await snapshotter.removeEphemeralHome(ephemeral)
    await assert.rejects(lstat(ephemeralPath), {code: 'ENOENT'})
    await snapshotter.removeEphemeralHome(persistent)
    assert.equal((await lstat(persistentPath)).isDirectory(), true)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})
