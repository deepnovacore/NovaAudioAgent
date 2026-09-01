import assert from 'node:assert/strict'
import {chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {
  CredentialSnapshotter,
  credentialSnapshotEnvironment,
  MAX_CREDENTIAL_BYTES,
  MAX_CREDENTIAL_MARKER_BYTES,
  prepareCodexCredentialSnapshotForTest,
  removeEphemeralHomeWithRaceHookForTest,
  splitCredentialAtomicTargetForTest,
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
    process.env.NOVA_PARENT_CREDENTIAL_SENTINEL = 'must-not-cross'

    const result = await prepareCodexCredentialSnapshotForTest({
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
    if (process.platform !== 'win32') {
      assert.equal((await lstat(join(destination, 'auth.json'))).mode & 0o777, 0o600)
    }
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
  await mkdir(source, {mode: 0o700})
  await mkdir(destination, {mode: 0o700})
  if (process.platform === 'win32') {
    await writeFile(join(source, 'auth.json'), 'saved-login-secret', {mode: 0o600})
  } else {
    const outside = join(root, 'outside-auth')
    await writeFile(outside, 'saved-login-secret', {mode: 0o600})
    await symlink(outside, join(source, 'auth.json'))
  }
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

test('Windows environment aliases are canonicalized for the credential child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-windows-env-'))
  const destination = join(root, 'destination')
  await mkdir(destination, {mode: 0o700})
  try {
    const home = hostCodexHomeForTest(await realpath(destination), {ephemeral: true})
    const snapshotter = new CredentialSnapshotter({
      platform: 'win32',
      environment: {
        Path: 'C:\\Windows\\System32',
        USERPROFILE: 'C:\\Users\\nova',
        SECRET_SENTINEL: 'drop-me',
      },
    })
    const snapshot = await snapshotter.prepare({codexHome: home, apiKey: 'api-key-process-only'})
    assert.deepEqual(credentialSnapshotEnvironment(snapshot), {
      PATH: 'C:\\Windows\\System32',
      HOME: 'C:\\Users\\nova',
      CODEX_HOME: await realpath(destination),
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
      CODEX_API_KEY: 'api-key-process-only',
    })
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('credential no-follow, mode, and exact byte bounds fail with only credential_missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-bound-'))
  try {
    const scenarios = process.platform === 'win32'
      ? (['over-limit'] as const)
      : (['symlink', 'group-write', 'over-limit'] as const)
    for (const scenario of scenarios) {
      const diagnostics: string[] = []
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
        onDiagnostic: code => diagnostics.push(code),
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
      assert.deepEqual(diagnostics, ['codex_credential_snapshot_saved_login_failed'])
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
  if (process.platform !== 'win32') {
    await writeFile(outside, 'destination-secret', {mode: 0o600})
    await symlink(outside, join(hostileDestination, 'auth.json'))
  }
  try {
    const snapshotter = new CredentialSnapshotter({
      sourceHome: await realpath(source),
      environment: {PATH: '/safe-path', HOME: '/safe-home'},
    })
    await snapshotter.prepare({
      codexHome: hostCodexHomeForTest(await realpath(exactDestination), {ephemeral: true}),
      apiKey: null,
    })
    if (process.platform !== 'win32') {
      assert.equal((await lstat(join(exactDestination, 'auth.json'))).mode & 0o777, 0o600)
      assert.equal(
        (await lstat(join(exactDestination, '.nova-credential-source-v1.json'))).mode & 0o777,
        0o600,
      )
    }
    const rejectedDestinations = process.platform === 'win32'
      ? [overDestination]
      : [overDestination, hostileDestination]
    for (const destination of rejectedDestinations) {
      await assert.rejects(
        snapshotter.prepare({
          codexHome: hostCodexHomeForTest(await realpath(destination), {ephemeral: true}),
          apiKey: null,
        }),
        (error: unknown) => String(error) === 'CodexCredentialError: credential_missing',
      )
    }
    if (process.platform !== 'win32') {
      assert.equal(await readFile(outside, 'utf8'), 'destination-secret')
    }
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

test('ephemeral cleanup restores a chmodded owned root but refuses an inode replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-clean-identity-'))
  const chmoddedPath = join(root, 'chmodded')
  const replacedPath = join(root, 'replaced')
  await mkdir(chmoddedPath, {mode: 0o700})
  await mkdir(replacedPath, {mode: 0o700})
  const snapshotter = new CredentialSnapshotter({environment: {PATH: '/safe', HOME: '/home'}})
  try {
    const chmodded = hostCodexHomeForTest(await realpath(chmoddedPath), {ephemeral: true})
    await chmod(chmoddedPath, 0o000)
    await snapshotter.removeEphemeralHome(chmodded)
    await assert.rejects(lstat(chmoddedPath), {code: 'ENOENT'})

    const replaced = hostCodexHomeForTest(await realpath(replacedPath), {ephemeral: true})
    const original = join(root, 'original')
    const {rename} = await import('node:fs/promises')
    await rename(replacedPath, original)
    await mkdir(replacedPath, {mode: 0o700})
    await assert.rejects(
      snapshotter.removeEphemeralHome(replaced),
      (error: unknown) => String(error) === 'CodexCredentialError: credential_missing',
    )
    assert.equal((await lstat(replacedPath)).isDirectory(), true)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('ephemeral cleanup never deletes a replacement raced after its identity check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-clean-race-'))
  const selectedPath = join(root, 'selected')
  const originalPath = join(root, 'original')
  let replacementPath = ''
  await mkdir(selectedPath, {mode: 0o700})
  const selected = hostCodexHomeForTest(await realpath(selectedPath), {ephemeral: true})
  try {
    await assert.rejects(
      removeEphemeralHomeWithRaceHookForTest(selected, async quarantinedPath => {
        replacementPath = quarantinedPath
        await rename(quarantinedPath, originalPath)
        await mkdir(quarantinedPath, {mode: 0o700})
        await writeFile(join(quarantinedPath, 'replacement-sentinel'), 'must remain', {mode: 0o600})
      }),
      (error: unknown) => String(error) === 'CodexCredentialError: credential_missing',
    )
    assert.equal(await readFile(join(replacementPath, 'replacement-sentinel'), 'utf8'), 'must remain')
    await assert.rejects(lstat(selectedPath), {code: 'ENOENT'})
    assert.equal((await lstat(originalPath)).isDirectory(), true)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('credential atomic targets use Windows dirname and basename semantics', () => {
  assert.deepEqual(
    splitCredentialAtomicTargetForTest('C:\\Users\\nova\\.codex\\auth.json', 'win32'),
    {directory: 'C:\\Users\\nova\\.codex', filename: 'auth.json'},
  )
})
