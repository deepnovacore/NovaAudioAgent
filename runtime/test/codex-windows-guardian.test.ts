import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {EventEmitter} from 'node:events'
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {PassThrough} from 'node:stream'
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
  loadWindowsGuardianFactoryFromResources,
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

test('the force command is fixed and Windows fails closed without a packaged helper', async () => {
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

test('packaged Windows guardian owns the fixed app-server command and rejects a swapped helper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-packaged-guardian-'))
  const resources = join(root, 'resources')
  const native = join(resources, 'native')
  const helper = join(native, 'windows-job-guardian.exe')
  const pe = executablePe()
  await mkdir(native, {recursive: true})
  await writeFile(helper, pe)
  await writeFile(join(resources, 'native-resources-v1.json'), JSON.stringify({
    schema_version: 1,
    target: 'win32-x64',
    resources: [{
      logical_id: 'windows_job_guardian',
      relative_path: 'native/windows-job-guardian.exe',
      byte_size: pe.byteLength,
      sha256: createHash('sha256').update(pe).digest('hex'),
      kind: 'executable',
      platform: 'win32',
      architecture: 'x64',
      electron_abi: null,
      build_contract_version: 1,
    }],
  }))
  const input = new PassThrough()
  const output = new PassThrough()
  const error = new PassThrough()
  const control = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdin: input,
    stdout: output,
    stderr: error,
    stdio: [input, output, error, control] as const,
    pid: 41,
    kill: () => true,
  })
  const launches: {readonly binary: string; readonly argv: readonly string[]; readonly options: unknown}[] = []
  try {
    const factory = loadWindowsGuardianFactoryFromResources({
      resourcesPath: await realpath(resources),
      platform: 'win32',
      arch: 'x64',
      launcher: (binary, argv, options) => {
        launches.push({binary, argv, options})
        setImmediate(() => {
          control.write('{"type":"ready","version":1,"targetPid":4242}\n')
        })
        return child
      },
    })
    assert.notEqual(factory, null)
    const workspace = await realpath(process.cwd())
    const spec = createApprovedCodexSpawnSpec({
      binary: hostBinaryForTest(process.execPath),
      workspace: hostWorkspaceForTest(workspace),
      codexHome: hostCodexHomeForTest(workspace, {ephemeral: true}),
      environment: {
        PATH: '/safe', HOME: '/safe-home', CODEX_HOME: workspace,
        CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
      },
    })
    const owner = await factory!.spawn(spec, {
      signal: new AbortController().signal,
      expiresAtMs: Date.now() + 5000,
    })
    assert.equal(owner.pid, 4242)
    assert.equal(launches[0]?.binary, await realpath(helper))
    assert.deepEqual(launches[0]?.argv.slice(0, 6), [
      '--target', process.execPath, '--cwd', workspace, '--', process.execPath,
    ])
    control.write('{"type":"exit","version":1,"leaderExitCode":0,"treeEmpty":true}\n')
    child.emit('exit', 0)
    assert.equal(await owner.exit, 0)
    assert.equal(await owner.waitTreeGone(100), true)
    await owner.dispose()

    const commandLaunches: {readonly argv: readonly string[]}[] = []
    const commandFactory = loadWindowsGuardianFactoryFromResources({
      resourcesPath: await realpath(resources),
      platform: 'win32',
      arch: 'x64',
      launcher: (_binary, argv) => {
        commandLaunches.push({argv})
        const commandInput = new PassThrough()
        const commandOutput = new PassThrough()
        const commandError = new PassThrough()
        const commandControl = new PassThrough()
        const commandChild = Object.assign(new EventEmitter(), {
          stdin: commandInput,
          stdout: commandOutput,
          stderr: commandError,
          stdio: [commandInput, commandOutput, commandError, commandControl] as const,
          pid: 42,
          kill: () => true,
        })
        setImmediate(() => {
          commandControl.write('{"type":"ready","version":1,"targetPid":4343}\n')
          commandOutput.write('bounded output')
          commandControl.write('{"type":"exit","version":1,"leaderExitCode":0,"treeEmpty":true}\n')
          commandChild.emit('exit', 0)
        })
        return commandChild
      },
    })
    assert.notEqual(commandFactory, null)
    assert.deepEqual(await commandFactory!.runCommand({
      binary: process.execPath,
      argv: ['--version'],
      cwd: workspace,
      environment: {PATH: '/safe', HOME: '/safe-home'},
      timeoutMs: 5000,
      stdoutLimit: 1024,
      stderrLimit: 1024,
      shell: false,
    }), {status: 0, stdout: Buffer.from('bounded output')})
    assert.deepEqual(commandLaunches[0]?.argv, [
      '--target', process.execPath, '--cwd', workspace, '--', process.execPath, '--version',
    ])

    await writeFile(helper, Buffer.concat([pe, Buffer.from('swap')]))
    await assert.rejects(factory!.spawn(spec, {
      signal: new AbortController().signal,
      expiresAtMs: Date.now() + 5000,
    }), (caught: unknown) => String(caught) === 'CodexProcessOwnerError: spawn_failed')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

function executablePe(): Uint8Array {
  const pe = new Uint8Array(512)
  pe[0] = 0x4d
  pe[1] = 0x5a
  const view = new DataView(pe.buffer)
  view.setUint32(0x3c, 0x80, true)
  pe.set([0x50, 0x45, 0x00, 0x00], 0x80)
  view.setUint16(0x84, 0x8664, true)
  view.setUint16(0x86, 1, true)
  view.setUint16(0x94, 0xf0, true)
  view.setUint16(0x96, 0x0002, true)
  view.setUint16(0x98, 0x020b, true)
  pe.set(new TextEncoder().encode('.text\0\0\0'), 0x188)
  view.setUint32(0x190, 1, true)
  view.setUint32(0x194, 0x1000, true)
  view.setUint32(0x198, 0x40, true)
  view.setUint32(0x19c, 0x1c0, true)
  view.setUint32(0x1ac, 0x60000020, true)
  return pe
}
