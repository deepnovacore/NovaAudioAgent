import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PackageInspectionError,
  inspectConfiguredPackage,
  inspectPackageGraph,
} from '../scripts/inspect-package.mjs'

function validGraph() {
  return {
    includedFiles: [
      'src/main/main.mjs',
      'src/main/camera-source.mjs',
      'src/renderer/camera.mjs',
      'node_modules/@nova-audio-agent/runtime/dist/src/desktop-entry.js',
      'package.json',
    ],
    filePatterns: ['src/**/*', 'package.json', 'THIRD_PARTY_NOTICES.md', 'LICENSES/**/*'],
    extraResources: ['resources/tray', 'build/macos_voice_io'],
    dependencies: { '@nova-audio-agent/runtime': '0.1.0' },
    runtimePackage: {
      files: ['dist/src'],
      dependencies: { ws: '8.21.3', zod: '4.4.3' },
    },
  }
}

test('package graph catches missing renderer camera or compiled runtime', () => {
  assert.doesNotThrow(() => inspectPackageGraph(validGraph()))
  for (const missing of [
    'src/renderer/camera.mjs',
    'node_modules/@nova-audio-agent/runtime/dist/src/desktop-entry.js',
  ]) {
    const graph = validGraph()
    graph.includedFiles = graph.includedFiles.filter(file => file !== missing)
    assert.throws(() => inspectPackageGraph(graph), PackageInspectionError, missing)
  }
})

test('package graph catches demo media, Python surfaces, and broad video inclusion', () => {
  const forbiddenFiles = [
    'assets/demos/cat-sofa-guard/cat-sofa-guard.mp4',
    'assets/development-camera.mp4',
    'src/nova_audio_agent/camera.py',
    'pyproject.toml',
    'uv.lock',
    'scripts/launch_python.py',
  ]
  for (const file of forbiddenFiles) {
    const graph = validGraph()
    graph.includedFiles.push(file)
    assert.throws(() => inspectPackageGraph(graph), PackageInspectionError, file)
  }
  for (const pattern of ['assets/**/*', '**/*.mp4', 'assets/demos/**/*']) {
    const graph = validGraph()
    graph.filePatterns.push(pattern)
    assert.throws(() => inspectPackageGraph(graph), PackageInspectionError, pattern)
  }
})

test('package graph catches camera-native, OpenCV, ffmpeg, or Python dependencies', () => {
  for (const dependency of [
    'opencv4nodejs', 'ffmpeg-static', 'python-shell', 'node-webcam', 'native-video-codec',
  ]) {
    const graph = validGraph()
    graph.dependencies[dependency] = '1.0.0'
    assert.throws(() => inspectPackageGraph(graph), PackageInspectionError, dependency)
  }
  for (const dependency of ['opencv-wasm', 'ffmpeg-kit', 'python-bridge', 'camera-addon']) {
    const graph = validGraph()
    graph.runtimePackage.dependencies[dependency] = '1.0.0'
    assert.throws(() => inspectPackageGraph(graph), PackageInspectionError, dependency)
  }
})

test('actual configured package graph satisfies the deterministic contract', async () => {
  const result = await inspectConfiguredPackage()
  assert.equal(result.cameraIncluded, true)
  assert.equal(result.runtimeIncluded, true)
  assert.deepEqual(result.productionDependencies, ['@nova-audio-agent/runtime'])
  assert.equal(result.forbidden.length, 0)
})
