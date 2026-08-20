import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { app, BrowserWindow, net, protocol } from 'electron'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { installAppProtocol } from '../src/main/app-protocol.mjs'
import { selectMainCameraSource } from '../src/main/camera-source.mjs'
import { browserWindowOptions } from '../src/main/security.mjs'
import {
  CameraFileIntegrationError,
  ChromiumCapabilityError,
  assertVisualEvidence,
  integrationExitCode,
  integrationResultLine,
  verifyCameraFileFixture,
} from './camera-file-integration-contract.mjs'

import { VirtualClock } from '../../../runtime/dist/src/clock.js'
import { MAX_CAMERA_POSITION_MS } from '../../../runtime/dist/src/desktop-camera.js'
import { NodeDesktopServer } from '../../../runtime/dist/src/desktop.js'
import { CamAdapter, CameraError } from '../../../runtime/dist/src/executors/camera.js'
import { ChromiumFrameSource } from '../../../runtime/dist/src/executors/chromium-frame-source.js'
import {
  GUARD_MANIFEST,
  WATCH_MANIFEST,
  WatchAdapter,
} from '../../../runtime/dist/src/executors/watcher.js'
import { MediaStore } from '../../../runtime/dist/src/media-store.js'

protocol.registerSchemesAsPrivileged([{
  scheme: 'nova',
  privileges: {standard: true, secure: true, supportFetchAPI: true, stream: true},
}])

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const repositoryRoot = resolve(packageRoot, '../..')
const preload = resolve(packageRoot, 'src/preload/preload.cjs')
const RUNNER_DEADLINE_MS = 10_000
const HANDSHAKE_DEADLINE_MS = 2_000
const MEDIA_DEADLINE_MS = 5_000
const TOKEN = '0123456789abcdef0123456789abcdef'

let stage = 'fixture'
let window
let server
let source
let cameraTimer

async function runIntegration() {
  const fixture = await verifyCameraFileFixture(repositoryRoot)
  const selected = selectMainCameraSource(process.env)
  if (selected.source !== 'file' || selected.file !== fixture.assetFile) {
    throw new CameraFileIntegrationError('camera fixture selection rejected')
  }

  stage = 'app_ready'
  try {
    await settleWithin(app.whenReady(), HANDSHAKE_DEADLINE_MS, 'electron app readiness')
  } catch {
    throw new ChromiumCapabilityError()
  }

  const clock = new VirtualClock(100)
  const mediaStore = new MediaStore()
  let authenticatedCount = 0
  let disconnectedCount = 0
  cameraTimer = makeCameraTimer()
  server = new NodeDesktopServer({
    token: TOKEN,
    closeGraceMs: 100,
    cameraTimer,
    onClientAuthenticated: () => { authenticatedCount += 1 },
    onClientDisconnect: () => { disconnectedCount += 1 },
  })
  const readiness = await settleWithin(server.start(), HANDSHAKE_DEADLINE_MS, 'desktop server start')
  source = new ChromiumFrameSource({source: 'file', transport: server, clock})

  stage = 'source_start_without_renderer'
  await settleWithin(source.start(), HANDSHAKE_DEADLINE_MS, 'camera source start')
  assert.equal(authenticatedCount, 0)

  const route = {requests: 0, nonzeroRanges: 0}
  stage = 'window'
  window = new BrowserWindow({
    ...browserWindowOptions(preload, `camera-${randomBytes(4).toString('hex')}`, {opaque: true}),
    show: false,
  })
  const rendererFiles = Object.freeze([
    '/scripts/camera-file-integration.html',
    '/scripts/camera-file-integration-renderer.mjs',
    '/src/renderer/camera.mjs',
    '/reference-first.png',
    '/reference-last.png',
  ])
  const fixedFiles = new Map([
    [resolve(packageRoot, 'scripts/camera-file-integration.html'),
      resolve(packageRoot, 'scripts/camera-file-integration.html')],
    [resolve(packageRoot, 'scripts/camera-file-integration-renderer.mjs'),
      resolve(packageRoot, 'scripts/camera-file-integration-renderer.mjs')],
    [resolve(packageRoot, 'src/renderer/camera.mjs'), resolve(packageRoot, 'src/renderer/camera.mjs')],
    [resolve(packageRoot, 'reference-first.png'), fixture.firstFile],
    [resolve(packageRoot, 'reference-last.png'), fixture.lastFile],
  ])
  installAppProtocol(window.webContents.session.protocol, {
    rendererRoot: packageRoot,
    rendererFiles,
    fetchFile: file => {
      const fixed = fixedFiles.get(file)
      return fixed === undefined
        ? new Response('Not found', {status: 404})
        : net.fetch(pathToFileURL(fixed).href)
    },
    cameraFile: selected.file,
    fetchCameraFile: (url, init) => {
      route.requests += 1
      const range = new Headers(init?.headers).get('range')
      const start = /^bytes=(\d+)-/iu.exec(range ?? '')?.[1]
      if (start !== undefined && Number(start) > 0) route.nonzeroRanges += 1
      return net.fetch(url, init)
    },
  })
  stage = 'page_load'
  try {
    await settleWithin(
      window.loadURL('nova://orb/scripts/camera-file-integration.html'),
      HANDSHAKE_DEADLINE_MS,
      'renderer page load',
    )
    assert.equal(await rendererExpression(
      'typeof window.novaCameraFileIntegration === "object"',
    ), true)
  } catch {
    throw new ChromiumCapabilityError()
  }

  const endpoint = `ws://${readiness.host}:${readiness.port}`
  let expectedAuthentication = authenticatedCount
  const connectRenderer = async (options = {}) => {
    try { await rendererCall('cleanup') } catch { /* first connection or reloaded page */ }
    await server.disconnectClient()
    expectedAuthentication += 1
    await rendererCall('start', {
      endpoint,
      token: TOKEN,
      sourceMode: options.sourceMode ?? 'file',
      failureSequence: options.failureSequence ?? [],
      holdSeek: options.holdSeek === true,
      imageCaptureUnavailable: options.imageCaptureUnavailable === true,
      permissionDenied: options.permissionDenied === true,
    })
    await waitUntil(
      () => authenticatedCount >= expectedAuthentication,
      HANDSHAKE_DEADLINE_MS,
      'renderer authentication',
    )
  }

  stage = 'chromium_decode'
  await connectRenderer()
  let first
  try {
    first = await settleWithin(source.snapshot(), MEDIA_DEADLINE_MS, 'first Chromium capture')
  } catch {
    throw new ChromiumCapabilityError()
  }
  assertJpeg(first)
  assertJpeg(await settleWithin(source.snapshot(), MEDIA_DEADLINE_MS, 'second initial capture'))
  await source.restart()
  clock.advanceTo(102.5)
  assertJpeg(await settleWithin(source.snapshot(), MEDIA_DEADLINE_MS, '2500ms capture'))
  clock.advanceTo(105)
  assertJpeg(await settleWithin(source.snapshot(), MEDIA_DEADLINE_MS, '5000ms capture'))
  await source.restart()
  assertJpeg(await settleWithin(source.snapshot(), MEDIA_DEADLINE_MS, 'restart zero capture'))
  clock.advanceTo(105 + (MAX_CAMERA_POSITION_MS / 1_000))
  assertJpeg(await settleWithin(source.snapshot(), MEDIA_DEADLINE_MS, 'past-end capture'))
  const epochTrace = await rendererCall('requestTrace')
  assert.deepEqual(epochTrace.slice(0, 6).map(value => value.positionMs), [
    0, 0, 2_500, 5_000, 0, MAX_CAMERA_POSITION_MS,
  ])
  assert.ok(route.requests > 0)
  assert.ok(route.nonzeroRanges > 0)

  let visual
  try {
    visual = await settleWithin(rendererCall('visualEvidence'), MEDIA_DEADLINE_MS, 'visual oracle')
    assertVisualEvidence(visual)
  } catch {
    throw new ChromiumCapabilityError()
  }
  const visualSummary = withoutLandmarks(visual)

  stage = 'shared_executors'
  const cam = new CamAdapter(source, mediaStore)
  const camResult = await cam.dispatch('snapshot', {}, executorContext(clock))
  assert.equal(camResult.outcome, 'ok')
  const camEntry = mediaStore.peek(camResult.content.media_ref)
  assert.ok(camEntry)
  assertJpeg(camEntry)
  assert.equal(camEntry.digest, camResult.content.digest)

  await source.restart()
  clock.advanceTo(clock.now() + 2.5)
  const watchGateway = scriptedGateway(['miss', 'hit'])
  const watchObservations = []
  const watch = new WatchAdapter({
    manifest: WATCH_MANIFEST,
    source,
    gateway: watchGateway,
    mediaStore,
    model: 'camera-integration-model',
    captureEnabled: true,
  })
  const watchStartedAt = clock.now()
  const beforeWatchTrace = (await rendererCall('requestTrace')).length
  const watchRun = watch.dispatch('start', {
    condition: '猫进入沙发区域', interval_s: 2, duration_s: 30,
  }, executorContext(clock, watchObservations))
  await waitUntil(() => clock.waiterCount() === 1, HANDSHAKE_DEADLINE_MS, 'watch first sample')
  clock.advanceTo(watchStartedAt + 2)
  await waitUntil(() => watchGateway.calls.length === 2 && clock.waiterCount() === 1,
    HANDSHAKE_DEADLINE_MS, 'watch second sample')
  clock.advanceTo(watchStartedAt + 30)
  const watchResult = await settleWithin(watchRun, HANDSHAKE_DEADLINE_MS, 'watch window')
  assert.equal(watchResult.content.reason, 'window_elapsed')
  const watchTrace = (await rendererCall('requestTrace')).slice(beforeWatchTrace)
  assert.ok(watchTrace.length >= 2)
  assert.equal(watchTrace[0].positionMs, 2_500)
  assert.equal(watchTrace.some(value => value.positionMs === 0), false)
  assertGatewayImages(watchGateway.calls)

  let guardRestarts = 0
  const guardGateway = scriptedGateway(['hit'])
  const guardObservations = []
  const guard = new WatchAdapter({
    manifest: GUARD_MANIFEST,
    source,
    gateway: guardGateway,
    mediaStore,
    model: 'camera-integration-model',
    captureEnabled: true,
    prepareObservation: async () => {
      guardRestarts += 1
      await source.restart()
    },
  })
  const guardStartedAt = clock.now()
  const beforeGuardTrace = (await rendererCall('requestTrace')).length
  const guardRun = guard.dispatch('start', {
    condition: '猫进入沙发区域', interval_s: 2, duration_s: 30,
  }, executorContext(clock, guardObservations))
  await waitUntil(() => guardGateway.calls.length === 1 && clock.waiterCount() === 1,
    HANDSHAKE_DEADLINE_MS, 'guard first sample')
  clock.advanceTo(guardStartedAt + 30)
  await settleWithin(guardRun, HANDSHAKE_DEADLINE_MS, 'guard window')
  const guardTrace = (await rendererCall('requestTrace')).slice(beforeGuardTrace)
  assert.equal(guardRestarts, 1)
  assert.equal(guardTrace[0].positionMs, 0)
  const hit = guardObservations.find(value => value.content?.state === 'hit')
  assert.ok(hit)
  const guardEntry = mediaStore.peek(hit.content.media_ref)
  assert.ok(guardEntry)
  assert.deepEqual(guardEntry.payload, guardGateway.calls[0].images[0].payload)

  stage = 'failure_sweep'
  const stableFailures = []
  for (const hook of [
    'metadata_unavailable', 'seek_unavailable', 'canvas_unavailable', 'encode_unavailable',
  ]) {
    await connectRenderer({failureSequence: [hook]})
    await assert.rejects(source.snapshot(), CameraError)
    stableFailures.push(hook)
  }
  const localSource = new ChromiumFrameSource({source: 'local', transport: server, clock})
  await localSource.start()
  await connectRenderer({sourceMode: 'local', permissionDenied: true})
  await assert.rejects(localSource.snapshot(), CameraError)
  stableFailures.push('permission_denied')
  await connectRenderer({sourceMode: 'local', imageCaptureUnavailable: true})
  await assert.rejects(localSource.snapshot(), CameraError)
  await localSource.stop()
  stableFailures.push('image_capture_unavailable')

  for (const hook of ['wrong_id', 'malformed', 'oversized']) {
    await connectRenderer({failureSequence: [hook]})
    await assert.rejects(source.snapshot(), CameraError)
    await connectRenderer()
    assertJpeg(await source.snapshot())
    stableFailures.push(hook)
  }

  cameraTimer.overrideMs = 50
  await connectRenderer({failureSequence: ['drop', 'ok']})
  await assert.rejects(source.snapshot(), CameraError)
  cameraTimer.overrideMs = undefined
  assertJpeg(await source.snapshot())
  stableFailures.push('timeout')

  const programmingSource = new ChromiumFrameSource({
    source: 'file',
    clock,
    transport: {captureCamera: async () => { throw new Error('programmer defect') }},
  })
  await programmingSource.start()
  await assert.rejects(programmingSource.snapshot(), error => !(error instanceof CameraError))
  await programmingSource.stop()

  stage = 'watch_recovery'
  await connectRenderer({
    failureSequence: [
      'encode_unavailable', 'ok', 'encode_unavailable', 'encode_unavailable',
      'encode_unavailable',
    ],
  })
  const recoveryGateway = scriptedGateway(['miss'])
  const recoveryWatch = new WatchAdapter({
    manifest: WATCH_MANIFEST,
    source,
    gateway: recoveryGateway,
    mediaStore,
    model: 'camera-integration-model',
    captureEnabled: true,
  })
  const recoveryRun = recoveryWatch.dispatch('start', {
    condition: '猫进入沙发区域', interval_s: 2, duration_s: 30,
  }, executorContext(clock, []))
  for (let sample = 0; sample < 4; sample += 1) {
    await waitUntil(() => clock.waiterCount() === 1, HANDSHAKE_DEADLINE_MS,
      `watch recovery sample ${sample}`)
    clock.advanceTo(clock.now() + 2)
  }
  const recoveryResult = await settleWithin(recoveryRun, HANDSHAKE_DEADLINE_MS, 'watch recovery')
  assert.equal(recoveryResult.outcome, 'unknown')
  assert.equal(recoveryResult.content.error, 'capture_unavailable')
  assert.equal(recoveryGateway.calls.length, 1)

  const failedGuard = new WatchAdapter({
    manifest: GUARD_MANIFEST,
    source,
    gateway: scriptedGateway([]),
    mediaStore,
    model: 'camera-integration-model',
    captureEnabled: true,
    prepareObservation: async () => { throw new CameraError('unavailable') },
  })
  const guardFailure = await failedGuard.dispatch('start', {
    condition: '猫进入沙发区域', interval_s: 2, duration_s: 30,
  }, executorContext(clock, []))
  assert.equal(guardFailure.content.error, 'capture_unavailable')

  stage = 'non_starvation'
  await connectRenderer({holdSeek: true})
  let heldSettled = false
  const held = source.snapshot().finally(() => { heldSettled = true })
  await waitUntil(async () => (await rendererCall('requestTrace')).length >= 1,
    HANDSHAKE_DEADLINE_MS, 'held camera request')
  await server.sendText(JSON.stringify({
    type: 'playback.clear', utterance_id: 'camera-test', generation_epoch: 1,
  }))
  await settleWithin(rendererCall('waitForControl', 'playback.clear'), HANDSHAKE_DEADLINE_MS,
    'playback control during capture')
  assert.equal(heldSettled, false)
  await rendererCall('releaseSeek')
  assertJpeg(await settleWithin(held, MEDIA_DEADLINE_MS, 'released held capture'))

  stage = 'reload_reconnect'
  const staleCapture = source.snapshot()
  await waitUntil(async () => (await rendererCall('requestTrace')).length >= 2,
    HANDSHAKE_DEADLINE_MS, 'reload held capture')
  const reloaded = new Promise(resolveReload => window.webContents.once('did-finish-load', resolveReload))
  window.reload()
  await settleWithin(reloaded, HANDSHAKE_DEADLINE_MS, 'renderer reload')
  await assert.rejects(staleCapture, CameraError)
  assert.equal(await rendererExpression(
    'typeof window.novaCameraFileIntegration === "object"',
  ), true)
  expectedAuthentication = authenticatedCount
  await connectRenderer()
  assertJpeg(await source.snapshot())

  stage = 'pending_shutdown'
  await connectRenderer({holdSeek: true})
  const pendingAtShutdown = source.snapshot()
  await waitUntil(async () => (await rendererCall('requestTrace')).length >= 1,
    HANDSHAKE_DEADLINE_MS, 'shutdown held capture')
  await server.close()
  await assert.rejects(pendingAtShutdown, CameraError)
  await source.stop()
  await source.stop()
  await server.close()
  const cleanup = await rendererCall('cleanup')
  assert.equal(cleanup.videoPlay, 0)
  assert.ok(cleanup.videoPause > 0)
  assert.ok(cleanup.videoLoad > 0)
  assert.ok(cleanup.videoSourceCleared > 0)
  assert.equal(cameraTimer.activeCount(), 0)
  assert.ok(disconnectedCount > 0)

  return Object.freeze({
    ok: true,
    fixture: {sha256: fixture.sha256, bytes: fixture.bytes, width: 1280, height: 720},
    route,
    visual: visualSummary,
    epochPositions: [0, 0, 2_500, 5_000, 0, MAX_CAMERA_POSITION_MS],
    executors: {
      camStored: true,
      watchRestarted: false,
      guardRestarts,
      guardEvidenceStored: true,
      recoverySamples: 5,
    },
    failures: stableFailures,
    lifecycle: {sourceStartBeforeRenderer: true, reloadRecovered: true, shutdownDrained: true},
  })
}

function executorContext(clock, observations = []) {
  return {
    clock,
    delegate: {},
    signal: new AbortController().signal,
    progress: () => {},
    observe: value => { observations.push(value) },
  }
}

function scriptedGateway(verdicts) {
  const pending = [...verdicts]
  const calls = []
  return {
    calls,
    stream: async function * stream() {},
    async complete(request) {
      if (pending.length === 0) throw new Error('unexpected gateway call')
      calls.push(Object.freeze({
        ...request,
        images: request.images.map(image => Object.freeze({
          ...image, payload: new Uint8Array(image.payload),
        })),
      }))
      const verdict = pending.shift()
      return verdict === 'hit'
        ? {text: '{"hit":true,"observation":"猫进入了沙发区域"}'}
        : {text: '{"hit":false,"observation":""}'}
    },
  }
}

function assertGatewayImages(calls) {
  assert.ok(calls.length > 0)
  for (const call of calls) {
    assert.equal(call.images.length, 1)
    assert.equal(call.images[0].ref, 'watch-frame')
    assert.equal(call.images[0].media_type, 'image/jpeg')
    assertJpeg(call.images[0])
  }
}

function assertJpeg(frame) {
  assert.equal(frame.media_type, 'image/jpeg')
  assert.equal(frame.width, 1280)
  assert.equal(frame.height, 720)
  assert.ok(frame.payload instanceof Uint8Array)
  assert.equal(frame.payload[0], 0xff)
  assert.equal(frame.payload[1], 0xd8)
  assert.equal(frame.payload[frame.payload.byteLength - 2], 0xff)
  assert.equal(frame.payload[frame.payload.byteLength - 1], 0xd9)
}

function withoutLandmarks(visual) {
  const summary = {...visual}
  delete summary.landmarks
  return summary
}

function makeCameraTimer() {
  const handles = new Set()
  return {
    overrideMs: undefined,
    set(delayMs, callback) {
      const handle = setTimeout(() => {
        handles.delete(handle)
        callback()
      }, this.overrideMs ?? delayMs)
      handles.add(handle)
      return handle
    },
    clear(handle) {
      clearTimeout(handle)
      handles.delete(handle)
    },
    activeCount: () => handles.size,
  }
}

async function rendererCall(method, ...args) {
  const allowed = new Set([
    'start', 'waitForControl', 'releaseSeek', 'requestTrace', 'visualEvidence', 'cleanup',
  ])
  if (!allowed.has(method)) throw new CameraFileIntegrationError('renderer call rejected')
  return rendererExpression(
    `window.novaCameraFileIntegration[${JSON.stringify(method)}](...${JSON.stringify(args)})`,
  )
}

function rendererExpression(expression) {
  return settleWithin(
    window.webContents.executeJavaScript(expression, false),
    MEDIA_DEADLINE_MS,
    'renderer expression',
  )
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolveWait => setImmediate(resolveWait))
  }
  throw new CameraFileIntegrationError(`${label} timed out`)
}

function settleWithin(promise, timeoutMs, label) {
  let handle
  const timeout = new Promise((_, reject) => {
    handle = setTimeout(() => reject(new CameraFileIntegrationError(`${label} timed out`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(handle))
}

const complete = settleWithin(runIntegration(), RUNNER_DEADLINE_MS, 'camera integration')
let result
try {
  result = await complete
} catch (error) {
  result = error instanceof ChromiumCapabilityError
    || stage === 'app_ready'
    || stage === 'window'
    || stage === 'page_load'
    || stage === 'chromium_decode'
    ? new ChromiumCapabilityError()
    : error
} finally {
  try {
    await settleWithin(server?.close() ?? Promise.resolve(), HANDSHAKE_DEADLINE_MS,
      'desktop server cleanup')
  } catch { /* bounded owner cleanup */ }
  try {
    await settleWithin(source?.stop() ?? Promise.resolve(), HANDSHAKE_DEADLINE_MS,
      'camera source cleanup')
  } catch { /* bounded owner cleanup */ }
  window?.destroy()
}

const exitCode = integrationExitCode(result)
process.stdout.write(`${integrationResultLine(result)}\n`)
app.exit(exitCode)
