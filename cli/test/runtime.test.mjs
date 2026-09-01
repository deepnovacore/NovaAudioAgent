import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {ensureDesktop, inspectDoctor, parseChecksum} from '../src/runtime.mjs'

const ARTIFACT = 'nova-audio-agent-0.1.0-linux-x64.AppImage'

test('checksum parser binds a digest to the requested asset', () => {
  const digest = 'a'.repeat(64)
  assert.equal(parseChecksum(`${digest}  ${ARTIFACT}\n`, ARTIFACT), digest)
  assert.throws(() => parseChecksum(`${digest}  another.AppImage\n`, ARTIFACT), /checksum rejected/u)
  assert.throws(() => parseChecksum('not-a-digest', ARTIFACT), /checksum rejected/u)
})

test('desktop install verifies, atomically caches, and reuses a portable file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'novaaudio-cli-'))
  const bytes = Buffer.from('#!/bin/sh\nexit 0\n')
  const digest = createHash('sha256').update(bytes).digest('hex')
  let requests = 0
  const fetchImpl = async url => {
    requests += 1
    return String(url).endsWith('.sha256')
      ? new Response(`${digest}  ${ARTIFACT}\n`)
      : new Response(bytes)
  }
  const first = await ensureDesktop({platform: 'linux', arch: 'x64', home, fetchImpl})
  assert.deepEqual(await readFile(first.executable), bytes)
  const receipt = JSON.parse(await readFile(join(first.root, 'novaaudio-install.json'), 'utf8'))
  assert.equal(receipt.sha256, digest)
  assert.equal(requests, 2)
  const second = await ensureDesktop({platform: 'linux', arch: 'x64', home, fetchImpl})
  assert.equal(second.executable, first.executable)
  assert.equal(requests, 2)
})

test('checksum failure leaves no runnable installation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'novaaudio-cli-'))
  const fetchImpl = async url => String(url).endsWith('.sha256')
    ? new Response(`${'0'.repeat(64)}  ${ARTIFACT}\n`)
    : new Response('changed')
  await assert.rejects(
    ensureDesktop({platform: 'linux', arch: 'x64', home, fetchImpl}),
    /checksum mismatch/u,
  )
  const root = join(home, '.nova-audio-agent/cli/releases/0.1.0/linux-x64')
  await assert.rejects(readFile(join(root, 'NovaAudioAgent.AppImage')))
})

test('a failed replacement preserves an existing cache directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'novaaudio-cli-'))
  const root = join(home, '.nova-audio-agent/cli/releases/0.1.0/linux-x64')
  await mkdir(root, {recursive: true})
  await writeFile(join(root, 'previous-cache'), 'keep')
  const fetchImpl = async url => String(url).endsWith('.sha256')
    ? new Response(`${'0'.repeat(64)}  ${ARTIFACT}\n`)
    : new Response('changed')
  await assert.rejects(
    ensureDesktop({platform: 'linux', arch: 'x64', home, fetchImpl}),
    /checksum mismatch/u,
  )
  assert.equal(await readFile(join(root, 'previous-cache'), 'utf8'), 'keep')
})

test('concurrent installs serialize and reuse the first verified result', async () => {
  const home = await mkdtemp(join(tmpdir(), 'novaaudio-cli-'))
  const bytes = Buffer.from('#!/bin/sh\nexit 0\n')
  const digest = createHash('sha256').update(bytes).digest('hex')
  let requests = 0
  const fetchImpl = async url => {
    requests += 1
    if (String(url).endsWith('.sha256')) return new Response(`${digest}  ${ARTIFACT}\n`)
    await new Promise(resolve => setTimeout(resolve, 25))
    return new Response(bytes)
  }
  const [first, second] = await Promise.all([
    ensureDesktop({platform: 'linux', arch: 'x64', home, fetchImpl}),
    ensureDesktop({platform: 'linux', arch: 'x64', home, fetchImpl}),
  ])
  assert.equal(first.executable, second.executable)
  assert.equal(requests, 2)
})

test('an interrupted download leaves no partial executable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'novaaudio-cli-'))
  const bytes = Buffer.from('partial')
  const digest = createHash('sha256').update(bytes).digest('hex')
  const fetchImpl = async url => {
    if (String(url).endsWith('.sha256')) return new Response(`${digest}  ${ARTIFACT}\n`)
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.error(new Error('connection lost'))
      },
    }))
  }
  await assert.rejects(
    ensureDesktop({platform: 'linux', arch: 'x64', home, fetchImpl}),
    /connection lost/u,
  )
  const executable = join(home, '.nova-audio-agent/cli/releases/0.1.0/linux-x64/NovaAudioAgent.AppImage')
  await assert.rejects(readFile(executable))
})

test('doctor exposes only configured secret key names', async () => {
  const home = await mkdtemp(join(tmpdir(), 'novaaudio-cli-'))
  const settings = join(home, '.config/Nova Audio Agent Ambient Orb/ambient-orb-settings.json')
  await mkdir(join(settings, '..'), {recursive: true})
  await writeFile(settings, JSON.stringify({secrets: {OPENAI_API_KEY: 'secret-value'}}))
  const report = await inspectDoctor({platform: 'linux', arch: 'x64', home, environment: {}})
  assert.deepEqual(report.configuredSecretKeys, ['OPENAI_API_KEY'])
  assert.doesNotMatch(JSON.stringify(report), /secret-value/u)
})
