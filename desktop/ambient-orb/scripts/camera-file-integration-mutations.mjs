import {spawnSync} from 'node:child_process'
import {readFile, writeFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const node = process.execPath
const runtimeBuild = Object.freeze({
  command: 'npm',
  args: ['run', 'build', '--workspace', '@nova-audio-agent/runtime'],
})

const mutations = Object.freeze([
  {
    name: 'renderer page failures remain product failures',
    file: 'desktop/ambient-orb/scripts/camera-file-integration-contract.mjs',
    from: '    return error instanceof Error ? error : new CameraFileIntegrationError()',
    to: "    return error instanceof Error && error.message === 'renderer page load failed' ? new ChromiumCapabilityError('codec_not_supported') : error instanceof Error ? error : new CameraFileIntegrationError()",
    commands: [nodeTest('desktop/ambient-orb/test/camera-file-integration-contract.test.mjs',
      'integration operation boundary')],
  },
  {
    name: 'generic first capture failures remain product failures',
    file: 'desktop/ambient-orb/scripts/camera-file-integration-contract.mjs',
    from: '    return error instanceof Error ? error : new CameraFileIntegrationError()',
    to: "    return error instanceof Error && error.message === 'first Chromium capture generic error' ? new ChromiumCapabilityError('codec_not_supported') : error instanceof Error ? error : new CameraFileIntegrationError()",
    commands: [nodeTest('desktop/ambient-orb/test/camera-file-integration-contract.test.mjs',
      'integration operation boundary')],
  },
  {
    name: 'visual assertion failures remain product failures',
    file: 'desktop/ambient-orb/scripts/camera-file-integration-contract.mjs',
    from: '    return error instanceof Error ? error : new CameraFileIntegrationError()',
    to: "    return error instanceof Error && error.message === 'camera visual evidence rejected' ? new ChromiumCapabilityError('codec_not_supported') : error instanceof Error ? error : new CameraFileIntegrationError()",
    commands: [nodeTest('desktop/ambient-orb/test/camera-file-integration-contract.test.mjs',
      'integration operation boundary')],
  },
  {
    name: 'codec capability cannot default positive',
    file: 'desktop/ambient-orb/scripts/camera-file-integration-renderer.mjs',
    from: "  return support === 'probably' || support === 'maybe'",
    to: '  return true',
    commands: [nodeTest('desktop/ambient-orb/test/camera-file-integration-contract.test.mjs',
      'renderer codec capability')],
  },
  {
    name: 'reload encode barrier cannot be bypassed',
    file: 'desktop/ambient-orb/scripts/camera-file-integration-renderer.mjs',
    from: '        pending.add(release)',
    to: '        release()',
    commands: [nodeTest('desktop/ambient-orb/test/camera-file-integration-contract.test.mjs',
      'test-only encode barrier')],
  },
  {
    name: 'decode must reach loadeddata before capture',
    file: 'desktop/ambient-orb/src/renderer/camera.mjs',
    from: "      if (!(video.readyState >= 2)) await this.#waitForVideo(video, 'loadeddata', operation)",
    to: '      if (!(video.readyState >= 2)) await Promise.resolve()',
    commands: [nodeTest('desktop/ambient-orb/test/camera.test.mjs',
      'file decode failure after metadata')],
  },
  {
    name: 'locked fixture codec metadata cannot drift',
    file: 'desktop/ambient-orb/scripts/camera-file-integration-contract.mjs',
    from: "    codec: 'h264',\n    sampleEntry: sampleEntry.type,",
    to: "    codec: 'not-h264',\n    sampleEntry: sampleEntry.type,",
    commands: [nodeTest('desktop/ambient-orb/test/camera-file-integration-contract.test.mjs',
      'camera file fixture authority')],
  },
  {
    name: 'locked fixture chroma metadata cannot drift',
    file: 'desktop/ambient-orb/scripts/camera-file-integration-contract.mjs',
    from: "    chromaSubsampling: sampleEntry.chromaFormatIdc === 1 ? '4:2:0' : 'unsupported',",
    to: "    chromaSubsampling: sampleEntry.chromaFormatIdc === 2 ? '4:2:0' : 'unsupported',",
    commands: [nodeTest('desktop/ambient-orb/test/camera-file-integration-contract.test.mjs',
      'camera file fixture authority')],
  },
  {
    name: 'locked fixture dimensions cannot drift',
    file: 'desktop/ambient-orb/scripts/camera-file-integration-contract.mjs',
    from: '    width: sampleEntry.width,\n    height: sampleEntry.height,',
    to: '    width: sampleEntry.width - 1,\n    height: sampleEntry.height,',
    commands: [nodeTest('desktop/ambient-orb/test/camera-file-integration-contract.test.mjs',
      'camera file fixture authority')],
  },
  {
    name: 'locked fixture sample count cannot drift',
    file: 'desktop/ambient-orb/scripts/camera-file-integration-contract.mjs',
    from: '    sampleCount,\n    frameRate: (sampleCount * timescale) / timing.duration,',
    to: '    sampleCount: sampleCount + 1,\n    frameRate: (sampleCount * timescale) / timing.duration,',
    commands: [nodeTest('desktop/ambient-orb/test/camera-file-integration-contract.test.mjs',
      'camera file fixture authority')],
  },
  {
    name: 'locked fixture timing cannot drift',
    file: 'desktop/ambient-orb/scripts/camera-file-integration-contract.mjs',
    from: '    durationSeconds: trackDuration / movieTimescale,',
    to: '    durationSeconds: (trackDuration + movieTimescale) / movieTimescale,',
    commands: [nodeTest('desktop/ambient-orb/test/camera-file-integration-contract.test.mjs',
      'camera file fixture authority')],
  },
  {
    name: 'renderer cannot replace fixed camera route with file URL',
    file: 'desktop/ambient-orb/src/main/app-protocol.mjs',
    from: "export const CAMERA_SOURCE_URL = 'nova://orb/camera-source'",
    to: "export const CAMERA_SOURCE_URL = 'file:///tmp/renderer-selected.mp4'",
    commands: [nodeTest('desktop/ambient-orb/test/app-protocol.test.mjs')],
  },
  {
    name: 'camera route forwards byte ranges',
    file: 'desktop/ambient-orb/src/main/app-protocol.mjs',
    from: "return fetchCameraFile(pathToFileURL(cameraFile).href, { headers: request.headers })",
    to: "return fetchCameraFile(pathToFileURL(cameraFile).href, { headers: new Headers() })",
    commands: [nodeTest('desktop/ambient-orb/test/app-protocol.test.mjs')],
  },
  {
    name: 'file position uses runtime epoch',
    file: 'runtime/src/executors/chromium-frame-source.ts',
    from: 'const elapsedMs = Math.floor((readClock(this.#clock) * 1000) - (this.#epoch * 1000))',
    to: 'const elapsedMs = 0',
    commands: [runtimeBuild, nodeTest('runtime/dist/test/chromium-frame-source.test.js')],
  },
  {
    name: 'Watch never restarts a file source',
    file: 'runtime/src/assembly.ts',
    from: `    model: watchModel,
    captureEnabled,
  })
  const guard = new WatchAdapter({`,
    to: `    model: watchModel,
    captureEnabled,
    prepareObservation: async () => {
      if (isFileBackedFrameSource(frameSource)) await frameSource.restart()
    },
  })
  const guard = new WatchAdapter({`,
    commands: [runtimeBuild, nodeTest('runtime/dist/test/assembly.test.js')],
  },
  {
    name: 'Guard restarts a file source before observation',
    file: 'runtime/src/assembly.ts',
    from: `    ...(isFileBackedFrameSource(frameSource)
      ? {prepareObservation: () => frameSource.restart()}
      : {}),`,
    to: '    ...{},',
    commands: [runtimeBuild, nodeTest('runtime/dist/test/assembly.test.js')],
  },
  {
    name: 'camera enqueue cannot join an awaited renderer tail',
    file: 'desktop/ambient-orb/src/renderer/camera.mjs',
    from: '          void this.#cameraController.enqueue(event.data, record.delivery)',
    to: '          return this.#cameraController.enqueue(event.data, record.delivery)',
    commands: [nodeTest('desktop/ambient-orb/test/camera-router.test.mjs')],
  },
  {
    name: 'old renderer generation cannot send a late capture',
    file: 'desktop/ambient-orb/src/renderer/camera.mjs',
    from: `      if (!operation.active() || state.closed || this.#disposed) return
      if (!safeIsCurrent(delivery)) return
      responseAttempted = true`,
    to: `      if (!operation.active() || state.closed || this.#disposed) return
      responseAttempted = true`,
    commands: [nodeTest('desktop/ambient-orb/test/camera.test.mjs')],
  },
  {
    name: 'camera error never reveals DOM or path detail',
    file: 'desktop/ambient-orb/src/renderer/camera.mjs',
    from: `    error: 'capture_unavailable',
  })`,
    to: `    error: 'capture_unavailable',
    detail: 'DOMException /private/camera-file',
  })`,
    commands: [nodeTest('desktop/ambient-orb/test/camera.test.mjs')],
  },
  {
    name: 'shutdown rejects and clears held camera requests',
    file: 'runtime/src/desktop.ts',
    from: `  #rejectSocketCameraCaptures(socket: WebSocket): void {
    for (const pending of [...this.#pendingCamera.values()]) {
      if (pending.socket === socket) this.#rejectCameraCapture(pending, cameraUnavailableError())
    }
  }`,
    to: `  #rejectSocketCameraCaptures(socket: WebSocket): void {
    void socket
  }`,
    commands: [
      runtimeBuild,
      nodeTest('runtime/dist/test/desktop.test.js',
        'camera requests are cleaned on disconnect, explicit disconnect and server close'),
    ],
  },
  {
    name: 'cat-sofa fixture cannot enter package files',
    file: 'desktop/ambient-orb/electron-builder.yml',
    from: '  - LICENSES/**/*',
    to: `  - LICENSES/**/*
  - ../../assets/demos/cat-sofa-guard/cat-sofa-guard.mp4`,
    commands: [nodeTest('desktop/ambient-orb/test/package-inspection.test.mjs')],
  },
])

function nodeTest(file, pattern) {
  return Object.freeze({
    command: node,
    args: [
      '--test',
      ...(pattern === undefined ? [] : [`--test-name-pattern=${pattern}`]),
      file,
    ],
  })
}

function runCommand(spec) {
  const result = spawnSync(spec.command, spec.args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 20_000,
    stdio: 'pipe',
  })
  if (result.error?.code === 'ENOENT') return 'tool-missing'
  if (result.error?.code === 'ETIMEDOUT' || result.signal !== null) return 'timeout'
  return result.status === 0 ? 'passed' : 'failed'
}

async function applyMutation(mutation) {
  const file = resolve(repositoryRoot, mutation.file)
  const original = await readFile(file, 'utf8')
  const first = original.indexOf(mutation.from)
  if (first < 0 || original.indexOf(mutation.from, first + mutation.from.length) >= 0) {
    return Object.freeze({name: mutation.name, classification: 'tool-missing'})
  }
  try {
    await writeFile(file, original.replace(mutation.from, mutation.to), 'utf8')
    for (const command of mutation.commands) {
      const status = runCommand(command)
      if (status === 'tool-missing' || status === 'timeout') {
        return Object.freeze({name: mutation.name, classification: status})
      }
      if (status === 'failed') {
        return Object.freeze({name: mutation.name, classification: 'detected'})
      }
    }
    return Object.freeze({name: mutation.name, classification: 'survived'})
  } finally {
    await writeFile(file, original, 'utf8')
  }
}

const results = []
try {
  for (const mutation of mutations) results.push(await applyMutation(mutation))
} finally {
  runCommand(runtimeBuild)
}

const counts = Object.fromEntries(
  ['detected', 'survived', 'timeout', 'tool-missing'].map(classification => [
    classification,
    results.filter(result => result.classification === classification).length,
  ]),
)
process.stdout.write(`${JSON.stringify({counts, mutations: results})}\n`)
process.exitCode = counts.survived === 0 && counts.timeout === 0 && counts['tool-missing'] === 0
  && counts.detected === mutations.length ? 0 : 1
