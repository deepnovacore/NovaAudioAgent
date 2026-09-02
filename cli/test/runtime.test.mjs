import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {EventEmitter} from 'node:events'
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {test} from 'node:test'

import {ensureDesktop, inspectDoctor, launchDesktop, parseChecksum} from '../src/runtime.mjs'

const ARTIFACT = 'nova-audio-agent-0.1.1-windows-x64-portable.zip'
const TARGET_OPTIONS = Object.freeze({platform: 'win32', arch: 'x64'})

async function extractFixture({artifact, payload, target}) {
  const executable = join(payload, target.executable)
  await mkdir(dirname(executable), {recursive: true})
  await writeFile(executable, await readFile(artifact), {mode: 0o700})
  return executable
}

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
  const first = await ensureDesktop({...TARGET_OPTIONS, home, fetchImpl, extractImpl: extractFixture})
  assert.deepEqual(await readFile(first.executable), bytes)
  const receipt = JSON.parse(await readFile(join(first.root, 'novaaudio-install.json'), 'utf8'))
  assert.equal(receipt.sha256, digest)
  assert.equal(requests, 2)
  const second = await ensureDesktop({...TARGET_OPTIONS, home, fetchImpl, extractImpl: extractFixture})
  assert.equal(second.executable, first.executable)
  assert.equal(requests, 3)
})

test('an online cache is reused only while its receipt matches the current release digest', async () => {
  const home = await mkdtemp(join(tmpdir(), 'novaaudio-cli-'))
  let bytes = Buffer.from('#!/bin/sh\nexit 1\n')
  let digest = createHash('sha256').update(bytes).digest('hex')
  const fetchImpl = async url => String(url).endsWith('.sha256')
    ? new Response(`${digest}  ${ARTIFACT}\n`)
    : new Response(bytes)
  const first = await ensureDesktop({...TARGET_OPTIONS, home, fetchImpl, extractImpl: extractFixture})
  bytes = Buffer.from('#!/bin/sh\nexit 0\n')
  digest = createHash('sha256').update(bytes).digest('hex')
  const second = await ensureDesktop({...TARGET_OPTIONS, home, fetchImpl, extractImpl: extractFixture})
  assert.equal(second.executable, first.executable)
  assert.deepEqual(await readFile(second.executable), bytes)
  const receipt = JSON.parse(await readFile(join(second.root, 'novaaudio-install.json'), 'utf8'))
  assert.equal(receipt.sha256, digest)
})

test('a receipt-validated cache remains available when the release host is offline', async () => {
  const home = await mkdtemp(join(tmpdir(), 'novaaudio-cli-'))
  const bytes = Buffer.from('#!/bin/sh\nexit 0\n')
  const digest = createHash('sha256').update(bytes).digest('hex')
  const online = async url => String(url).endsWith('.sha256')
    ? new Response(`${digest}  ${ARTIFACT}\n`)
    : new Response(bytes)
  const installed = await ensureDesktop({...TARGET_OPTIONS, home, fetchImpl: online, extractImpl: extractFixture})
  const offline = async () => { throw new Error('offline') }
  const reused = await ensureDesktop({...TARGET_OPTIONS, home, fetchImpl: offline, extractImpl: extractFixture})
  assert.equal(reused.executable, installed.executable)
})

test('checksum failure leaves no runnable installation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'novaaudio-cli-'))
  const fetchImpl = async url => String(url).endsWith('.sha256')
    ? new Response(`${'0'.repeat(64)}  ${ARTIFACT}\n`)
    : new Response('changed')
  await assert.rejects(
    ensureDesktop({...TARGET_OPTIONS, home, fetchImpl, extractImpl: extractFixture}),
    /checksum mismatch/u,
  )
  const root = join(home, '.nova-audio-agent/cli/releases/0.1.1/win32-x64')
  await assert.rejects(readFile(join(root, 'Nova Audio Agent Ambient Orb.exe')))
})

test('a failed replacement preserves an existing cache directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'novaaudio-cli-'))
  const root = join(home, '.nova-audio-agent/cli/releases/0.1.1/win32-x64')
  await mkdir(root, {recursive: true})
  await writeFile(join(root, 'previous-cache'), 'keep')
  const fetchImpl = async url => String(url).endsWith('.sha256')
    ? new Response(`${'0'.repeat(64)}  ${ARTIFACT}\n`)
    : new Response('changed')
  await assert.rejects(
    ensureDesktop({...TARGET_OPTIONS, home, fetchImpl, extractImpl: extractFixture}),
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
    ensureDesktop({...TARGET_OPTIONS, home, fetchImpl, extractImpl: extractFixture}),
    ensureDesktop({...TARGET_OPTIONS, home, fetchImpl, extractImpl: extractFixture}),
  ])
  assert.equal(first.executable, second.executable)
  assert.equal(requests, 3)
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
    ensureDesktop({...TARGET_OPTIONS, home, fetchImpl, extractImpl: extractFixture}),
    /connection lost/u,
  )
  const executable = join(home, '.nova-audio-agent/cli/releases/0.1.1/win32-x64/Nova Audio Agent Ambient Orb.exe')
  await assert.rejects(readFile(executable))
})

test('doctor exposes only configured secret key names', async () => {
  const home = await mkdtemp(join(tmpdir(), 'novaaudio-cli-'))
  const appData = join(home, 'appdata')
  const settings = join(appData, 'Nova Audio Agent Ambient Orb/ambient-orb-settings.json')
  await mkdir(join(settings, '..'), {recursive: true})
  await writeFile(settings, JSON.stringify({secrets: {OPENAI_API_KEY: 'secret-value'}}))
  const report = await inspectDoctor({...TARGET_OPTIONS, home, environment: {APPDATA: appData}})
  assert.deepEqual(report.configuredSecretKeys, ['OPENAI_API_KEY'])
  assert.doesNotMatch(JSON.stringify(report), /secret-value/u)
})

test('desktop launch waits for spawn success and enables no-FUSE AppImage execution', async () => {
  const child = new EventEmitter()
  child.unref = () => { child.unrefCalled = true }
  let launch
  const started = launchDesktop('/tmp/NovaAudioAgent.AppImage', {
    platform: 'linux',
    environment: {PATH: '/usr/bin'},
    openSettings: true,
    launchGraceMs: 1,
    spawnImpl: (executable, args, options) => {
      launch = {executable, args, options}
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
  })
  await started
  assert.equal(launch.executable, '/tmp/NovaAudioAgent.AppImage')
  assert.deepEqual(launch.args, ['--open-settings'])
  assert.equal(launch.options.env.APPIMAGE_EXTRACT_AND_RUN, '1')
  assert.equal(child.unrefCalled, true)
})

test('desktop launch rejects a process that exits unsuccessfully during startup grace', async () => {
  const child = new EventEmitter()
  child.unref = () => assert.fail('failed launch must not detach')
  const launch = launchDesktop('/tmp/NovaAudioAgent.AppImage', {
    launchGraceMs: 100,
    spawnImpl: () => {
      queueMicrotask(() => {
        child.emit('spawn')
        child.emit('exit', 1, null)
      })
      return child
    },
  })
  await assert.rejects(launch, /desktop launch failed/u)
})

test('desktop launch reports an executable spawn failure', async () => {
  const child = new EventEmitter()
  child.unref = () => assert.fail('failed launch must not detach')
  const launch = launchDesktop('/missing/Nova', {
    spawnImpl: () => {
      queueMicrotask(() => child.emit('error', new Error('ENOENT')))
      return child
    },
  })
  await assert.rejects(launch, /desktop launch failed/u)
})
