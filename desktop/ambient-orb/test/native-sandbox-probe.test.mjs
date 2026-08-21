import assert from 'node:assert/strict'
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises'
import {createServer} from 'node:net'
import {tmpdir} from 'node:os'
import {basename, dirname, resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import test from 'node:test'

import {buildCodexSandboxProbe} from '../scripts/build-codex-sandbox-probe.mjs'

const packageRoot = resolve(import.meta.dirname, '..')

test('fixed native sandbox probe invokes its child and cannot default an unsandboxed run positive', {
  skip: process.platform !== 'darwin',
  timeout: 30_000,
}, async () => {
  const outputRoot = await mkdtemp(resolve(tmpdir(), 'nova-sandbox-probe-build-'))
  const probe = await buildCodexSandboxProbe({
    packageRoot,
    outputRoot,
    platform: process.platform,
    arch: process.arch,
  })
  const parent = await mkdtemp(resolve(tmpdir(), 'nova-sandbox-probe-fixture-'))
  const workspace = resolve(parent, 'workspace')
  const sibling = resolve(parent, '.nova-audio-agent-codex-preflight-test')
  await mkdir(workspace, {mode: 0o700})
  await mkdir(sibling, {mode: 0o700})
  const canary = resolve(sibling, 'canary')
  await writeFile(canary, 'host-created-canary', {mode: 0o600})
  const canonicalWorkspace = await realpath(workspace)
  const canonicalCanary = await realpath(canary)
  const marker = resolve(canonicalWorkspace, '.nova-audio-agent-codex-preflight-0123456789abcdef0123456789abcdef')

  const server = createServer(socket => socket.end())
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  try {
    const address = server.address()
    assert.ok(address !== null && typeof address === 'object')
    const result = spawnSync(probe, [
      '--main',
      canonicalWorkspace,
      canonicalCanary,
      marker,
      String(address.port),
    ], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 5_000,
      env: {},
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    const document = JSON.parse(result.stdout)
    assert.deepEqual(Object.keys(document), [
      'cwd_matches',
      'inside_write',
      'inside_remove',
      'outside_write_denied',
      'child_outside_write_denied',
      'network_denied',
      'limits',
    ])
    assert.deepEqual(document, {
      cwd_matches: true,
      inside_write: true,
      inside_remove: true,
      outside_write_denied: false,
      child_outside_write_denied: false,
      network_denied: false,
      limits: {
        cpu: document.limits.cpu,
        as: document.limits.as,
        nofile: document.limits.nofile,
      },
    })
    for (const value of Object.values(document.limits)) {
      assert.ok(['finite', 'unbounded', 'unavailable'].includes(value))
    }
    assert.equal(await readFile(canary, 'utf8'), 'child-write-succeeded')
    assert.equal(dirname(canary), sibling)
    assert.equal(basename(canary), 'canary')
  } finally {
    await new Promise(resolveClose => server.close(resolveClose))
    await rm(parent, {recursive: true, force: true})
    await rm(outputRoot, {recursive: true, force: true})
  }
})
