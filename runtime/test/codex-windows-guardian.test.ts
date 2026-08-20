import assert from 'node:assert/strict'
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {test} from 'node:test'

import * as runtime from '../src/index.js'
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
} from '../src/codex-windows-guardian.js'

const encoder = new TextEncoder()

test('guardian control rejects duplicate ready frames without exposing their contents', () => {
  const module = runtime as unknown as Record<string, unknown>
  const Parser = typeof module.WindowsGuardianControlParser === 'function'
    ? module.WindowsGuardianControlParser as new () => {
      feed(chunk: Uint8Array): readonly unknown[]
      end(): void
    }
    : class UnsafeGuardianParser {
      feed(chunk: Uint8Array): readonly unknown[] {
        return String(new TextDecoder().decode(chunk)).split('\n').filter(Boolean).map(value => JSON.parse(value) as unknown)
      }
      end(): void { return undefined }
    }
  const parser = new Parser()
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
  await assert.rejects(factory.spawn(spec), (error: unknown) => {
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
  const pe = new Uint8Array(256)
  pe[0] = 0x4d
  pe[1] = 0x5a
  new DataView(pe.buffer).setUint32(0x3c, 0x80, true)
  pe.set([0x50, 0x45, 0x00, 0x00], 0x80)
  new DataView(pe.buffer).setUint16(0x84, 0x8664, true)
  await writeFile(valid, pe)
  await writeFile(script, pe)
  await writeFile(malformed, Uint8Array.of(0x4d, 0x5a))
  try {
    const validCanonical = await realpath(valid)
    const scriptCanonical = await realpath(script)
    const malformedCanonical = await realpath(malformed)
    const module = runtime as unknown as Record<string, unknown>
    const validate = typeof module.windowsGuardianHelperForTest === 'function'
      ? module.windowsGuardianHelperForTest as (
        path: string,
        allowlist: readonly string[],
        architecture: string,
      ) => string
      : (path: string) => path
    assert.equal(validate(validCanonical, [validCanonical], 'x64'), validCanonical)
    for (const [path, allowlist, architecture] of [
      [scriptCanonical, [scriptCanonical], 'x64'],
      [malformedCanonical, [malformedCanonical], 'x64'],
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
