import assert from 'node:assert/strict'
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {test} from 'node:test'

import {
  createApprovedCodexSpawnSpec,
  createPlatformCodexProcessOwnerFactory,
  hostBinaryForTest,
  hostCodexHomeForTest,
  hostWorkspaceForTest,
} from '../src/codex-process-owner.js'
import {
  CodexWindowsGuardianError,
  WINDOWS_GUARDIAN_FRAME_LIMIT,
  WindowsGuardianControlParser,
  windowsGuardianForceFrame,
  windowsGuardianHelperForTest,
} from '../src/codex-windows-guardian.js'

const encoder = new TextEncoder()

test('guardian control rejects duplicate ready frames without exposing their contents', () => {
  const parser = new WindowsGuardianControlParser()
  const ready = '{"type":"ready","version":1,"targetPid":123}\n'
  assert.deepEqual(parser.feed(encoder.encode(ready)), [{type: 'ready', version: 1, targetPid: 123}])
  assert.throws(
    () => parser.feed(encoder.encode(ready)),
    (error: unknown) => String(error) === 'CodexWindowsGuardianError: spawn_failed',
  )
})

test('guardian frames enforce exact UTF-8 byte limit, order, shape, and EOF', () => {
  const ready = '{"type":"ready","version":1,"targetPid":123}'
  const exact = `${ready}${' '.repeat(WINDOWS_GUARDIAN_FRAME_LIMIT - encoder.encode(ready).byteLength)}\n`
  const parser = new WindowsGuardianControlParser()
  assert.deepEqual(parser.feed(encoder.encode(exact)), [{type: 'ready', version: 1, targetPid: 123}])
  assert.deepEqual(parser.feed(encoder.encode(
    '{"type":"exit","version":1,"leaderExitCode":0,"treeEmpty":true}\n',
  )), [{type: 'exit', version: 1, leaderExitCode: 0, treeEmpty: true}])
  parser.end()

  for (const bytes of [
    encoder.encode(`${ready}${' '.repeat(WINDOWS_GUARDIAN_FRAME_LIMIT - encoder.encode(ready).byteLength + 1)}\n`),
    encoder.encode('{"type":"exit","version":1,"leaderExitCode":0,"treeEmpty":true}\n'),
    encoder.encode('{"type":"ready","type":"ready","version":1,"targetPid":123}\n'),
    Uint8Array.of(0xff, 0x0a),
  ]) {
    const rejected = new WindowsGuardianControlParser()
    assert.throws(() => rejected.feed(bytes), CodexWindowsGuardianError)
  }
  const premature = new WindowsGuardianControlParser()
  premature.feed(encoder.encode(`${ready}\n`))
  assert.throws(() => premature.end(), CodexWindowsGuardianError)
})

test('the force command is fixed and Windows production has no helper or taskkill fallback', async () => {
  assert.equal(new TextDecoder().decode(windowsGuardianForceFrame()), '{"type":"force","version":1}\n')
  const workspace = process.cwd()
  const spec = createApprovedCodexSpawnSpec({
    binary: hostBinaryForTest(process.execPath),
    workspace: hostWorkspaceForTest(workspace),
    codexHome: hostCodexHomeForTest(workspace, {ephemeral: true}),
    environment: {
      PATH: '/safe', HOME: '/safe-home', CODEX_HOME: workspace,
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
    },
  })
  const factory = createPlatformCodexProcessOwnerFactory({platform: 'win32'})
  await assert.rejects(factory.spawn(spec, {
    signal: new AbortController().signal,
    expiresAtMs: Date.now() + 5000,
  }), (error: unknown) => {
    assert.equal(String(error), 'CodexProcessOwnerError: spawn_failed')
    assert.equal(String(error).includes('taskkill'), false)
    return true
  })
})

test('guardian helper resolution accepts only canonical allowlisted architecture-matched PE files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-guardian-pe-'))
  const valid = join(root, 'job-launcher.exe')
  const script = join(root, 'job-launcher.cmd')
  const malformed = join(root, 'malformed.exe')
  const zeroSection = join(root, 'zero-section.exe')
  const pe = new Uint8Array(512)
  pe[0] = 0x4d
  pe[1] = 0x5a
  new DataView(pe.buffer).setUint32(0x3c, 0x80, true)
  pe.set([0x50, 0x45, 0x00, 0x00], 0x80)
  new DataView(pe.buffer).setUint16(0x84, 0x8664, true)
  new DataView(pe.buffer).setUint16(0x86, 1, true)
  new DataView(pe.buffer).setUint16(0x94, 0xf0, true)
  new DataView(pe.buffer).setUint16(0x96, 0x0002, true)
  new DataView(pe.buffer).setUint16(0x98, 0x020b, true)
  pe.set(new TextEncoder().encode('.text\0\0\0'), 0x188)
  new DataView(pe.buffer).setUint32(0x190, 1, true)
  new DataView(pe.buffer).setUint32(0x194, 0x1000, true)
  new DataView(pe.buffer).setUint32(0x198, 0x40, true)
  new DataView(pe.buffer).setUint32(0x19c, 0x1c0, true)
  new DataView(pe.buffer).setUint32(0x1ac, 0x60000020, true)
  await writeFile(valid, pe)
  await writeFile(script, pe)
  await writeFile(malformed, Uint8Array.of(0x4d, 0x5a))
  const zeroSectionBytes = pe.slice()
  zeroSectionBytes.fill(0, 0x188, 0x1b0)
  await writeFile(zeroSection, zeroSectionBytes)
  try {
    const validCanonical = await realpath(valid)
    const scriptCanonical = await realpath(script)
    const malformedCanonical = await realpath(malformed)
    const zeroSectionCanonical = await realpath(zeroSection)
    const validate = windowsGuardianHelperForTest
    assert.equal(validate(validCanonical, [validCanonical], 'x64'), validCanonical)
    for (const [path, allowlist, architecture] of [
      [scriptCanonical, [scriptCanonical], 'x64'],
      [malformedCanonical, [malformedCanonical], 'x64'],
      [zeroSectionCanonical, [zeroSectionCanonical], 'x64'],
      [validCanonical, [validCanonical], 'arm64'],
      [validCanonical, [malformedCanonical], 'x64'],
      [`${resolve(validCanonical)}/.`, [validCanonical], 'x64'],
    ] as const) {
      assert.throws(() => validate(path, allowlist, architecture), CodexWindowsGuardianError)
    }
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('guardian rejects machine-only MZ/PE stubs without executable headers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-guardian-stub-'))
  const stub = join(root, 'stub.exe')
  const bytes = new Uint8Array(256)
  bytes[0] = 0x4d
  bytes[1] = 0x5a
  const view = new DataView(bytes.buffer)
  view.setUint32(0x3c, 0x80, true)
  bytes.set([0x50, 0x45, 0, 0], 0x80)
  view.setUint16(0x84, 0x8664, true)
  await writeFile(stub, bytes)
  try {
    const canonical = await realpath(stub)
    assert.throws(
      () => windowsGuardianHelperForTest(canonical, [canonical], 'x64'),
      CodexWindowsGuardianError,
    )
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})
