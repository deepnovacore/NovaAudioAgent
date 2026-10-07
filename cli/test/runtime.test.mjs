import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {EventEmitter, once} from 'node:events'
import {createServer} from 'node:http'
import {mkdir, mkdtemp, readFile, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {test} from 'node:test'

import {ensureDesktop, inspectDoctor, launchDesktop, parseChecksum} from '../src/runtime.mjs'

const ARTIFACT = 'nova-audio-agent-0.3.1-windows-x64-portable.zip'
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
  const root = join(home, '.nova-audio-agent/cli/releases/0.3.1/win32-x64')
  await assert.rejects(readFile(join(root, 'Nova Audio Agent Desktop.exe')))
})

test('a failed replacement preserves an existing cache directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'novaaudio-cli-'))
  const root = join(home, '.nova-audio-agent/cli/releases/0.3.1/win32-x64')
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
  const executable = join(home, '.nova-audio-agent/cli/releases/0.3.1/win32-x64/Nova Audio Agent Desktop.exe')
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

test('doctor names the voice pipeline keys and probes only environment keys when online', async () => {
  const home = await mkdtemp(join(tmpdir(), 'novaaudio-cli-'))
  const appData = join(home, 'appdata')
  const settings = join(appData, 'Nova Audio Agent Ambient Orb/ambient-orb-settings.json')
  await mkdir(join(settings, '..'), {recursive: true})
  await writeFile(settings, JSON.stringify({pipelineMode: 'cascaded', cascadedLlmProvider: 'deepseek', secrets: {doubaoBigmodelApiKey: {enc: 'safeStorage', data: 'c2VhbGVk'}}}))
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({url: String(url), authorization: init.headers.authorization})
    return new Response('{}', {status: 401})
  }
  const environment = {APPDATA: appData, DEEPSEEK_API_KEY: 'env-value'}
  const offline = await inspectDoctor({...TARGET_OPTIONS, home, environment, fetchImpl})
  assert.deepEqual(offline.voice, {pipeline: 'cascaded', keys: [
    {name: 'DEEPSEEK_API_KEY', source: 'environment'},
    {name: 'DOUBAO_BIGMODEL_API_KEY', source: 'settings'},
  ]})
  assert.equal(calls.length, 0)
  const online = await inspectDoctor({...TARGET_OPTIONS, home, environment, fetchImpl, online: true})
  assert.deepEqual(online.voice.keys[0], {name: 'DEEPSEEK_API_KEY', source: 'environment', probe: 'rejected'})
  assert.equal(online.voice.keys[1].probe, undefined)
  assert.deepEqual(calls, [{url: 'https://api.deepseek.com/models', authorization: 'Bearer env-value'}])
  assert.doesNotMatch(JSON.stringify(online), /env-value|c2VhbGVk/u)
})

test('doctor counts only saved keys the desktop can load, and the DashScope-gateway model key', async () => {
  const home = await mkdtemp(join(tmpdir(), 'novaaudio-cli-'))
  const appData = join(home, 'appdata')
  const settings = join(appData, 'Nova Audio Agent Ambient Orb/ambient-orb-settings.json')
  await mkdir(join(settings, '..'), {recursive: true})
  const voice = async (document, environment = {}) => {
    await writeFile(settings, JSON.stringify(document))
    return (await inspectDoctor({...TARGET_OPTIONS, home, environment: {APPDATA: appData, ...environment}})).voice.keys
  }
  // The desktop drops a plaintext or malformed entry, so it cannot satisfy the voice pipeline.
  assert.deepEqual(await voice({secrets: {dashscopeApiKey: 'old-plaintext-value'}}), [{name: 'DASHSCOPE_API_KEY', source: null}])
  assert.deepEqual(await voice({secrets: {dashscopeApiKey: {enc: 'rot13', data: 'c2VhbGVk'}}}), [{name: 'DASHSCOPE_API_KEY', source: null}])
  assert.deepEqual(await voice({secrets: {modelApiKey: {enc: 'safeStorage', data: 'c2VhbGVk'}}}), [{name: 'MODEL_API_KEY', source: 'settings'}])
  assert.deepEqual(await voice({}, {MODEL_API_KEY: 'm'}), [{name: 'MODEL_API_KEY', source: 'environment'}])
  assert.deepEqual(await voice({modelBaseUrl: 'https://models.example/v1'}, {MODEL_API_KEY: 'm'}), [{name: 'DASHSCOPE_API_KEY', source: null}])
})

test('doctor defaults a fresh install to the integrated DashScope key', async () => {
  const home = await mkdtemp(join(tmpdir(), 'novaaudio-cli-'))
  const report = await inspectDoctor({...TARGET_OPTIONS, home, environment: {APPDATA: join(home, 'appdata')}})
  assert.deepEqual(report.voice, {pipeline: 'integrated', keys: [{name: 'DASHSCOPE_API_KEY', source: null}]})
})

test('doctor never probes a custom gateway key against DashScope', async t => {
  const home = await mkdtemp(join(tmpdir(), 'novaaudio-cli-'))
  t.after(() => rm(home, {recursive: true, force: true}))
  const calls = []
  const report = await inspectDoctor({...TARGET_OPTIONS, home, online: true,
    environment: {APPDATA: join(home, 'appdata'), MODEL_BASE_URL: 'https://models.example/v1', MODEL_API_KEY: 'custom-key'},
    fetchImpl: async url => { calls.push(url); return new Response('{}', {status: 200}) },
  })
  assert.deepEqual(report.voice.keys, [{name: 'DASHSCOPE_API_KEY', source: null}])
  assert.deepEqual(calls, [])
})

// Exercise Node fetch's real "terminated" response-body failure, not a mocked error.
for (const failure of ['checksum', 'artifact', 'persistent']) {
  test(`release download recovers or explains a truncated ${failure} response`, async t => {
    const home = await mkdtemp(join(tmpdir(), 'novaaudio-truncated-'))
    t.after(() => rm(home, {recursive: true, force: true}))
    const bytes = Buffer.from('verified portable desktop payload')
    const digest = createHash('sha256').update(bytes).digest('hex')
    let interruptions = 0
    const server = createServer((req, res) => {
      const checksum = req.url.endsWith('.sha256')
      const body = checksum ? Buffer.from(`${digest}  ${ARTIFACT}\n`) : bytes
      res.writeHead(200, {'content-length': body.length})
      if ((failure === 'checksum' ? checksum : !checksum) && (interruptions === 0 || failure === 'persistent')) {
        interruptions += 1
        res.write(body.subarray(0, 4))
        setTimeout(() => res.destroy(), 10)
      } else res.end(body)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
    const fetchImpl = (url, options) => fetch(`http://127.0.0.1:${server.address().port}/${new URL(url).pathname.split('/').at(-1)}`, options)
    const install = ensureDesktop({...TARGET_OPTIONS, home, fetchImpl, extractImpl: extractFixture})
    if (failure === 'persistent') {
      await assert.rejects(install, error => /download.*failed.*3 attempts/i.test(error.message) && /retry/i.test(error.message) && error.cause?.message === 'terminated')
      assert.equal(interruptions, 3)
      await assert.rejects(readFile(join(home, '.nova-audio-agent/cli/releases/0.3.1/win32-x64/novaaudio-install.json')))
    } else {
      const installed = await install
      assert.deepEqual(await readFile(installed.executable), bytes)
      assert.equal(JSON.parse(await readFile(join(installed.root, 'novaaudio-install.json'), 'utf8')).sha256, digest)
    }
  })
}
