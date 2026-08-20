import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PackageInspectionError,
  evaluateBuilderFiles,
  evaluatePackageFiles,
  inspectConfiguredPackage,
  inspectPackagedFileList,
} from '../scripts/inspect-package.mjs'

const DESKTOP_FILES = [
  'src/main/main.mjs',
  'src/renderer/camera.mjs',
  'src/renderer/orb-visual.mjs',
  'package.json',
  'assets/demos/cat-sofa-guard/cat-sofa-guard.mp4',
]

test('builder files matcher catches removing or excluding camera with ordered rules', () => {
  assert.deepEqual(evaluateBuilderFiles(DESKTOP_FILES, [
    'src/**/*', 'package.json', '!src/renderer/orb-visual.mjs', 'src/renderer/orb-visual.mjs',
  ]), [
    'package.json',
    'src/main/main.mjs',
    'src/renderer/camera.mjs',
    'src/renderer/orb-visual.mjs',
  ])

  assert.equal(evaluateBuilderFiles(DESKTOP_FILES, ['package.json']).includes(
    'src/renderer/camera.mjs',
  ), false, 'removing src/**/* excludes camera')
  assert.equal(evaluateBuilderFiles(DESKTOP_FILES, [
    'src/**/*', '!src/renderer/camera.mjs',
  ]).includes('src/renderer/camera.mjs'), false, 'later exclusion wins')
  assert.equal(evaluateBuilderFiles(DESKTOP_FILES, [
    '!src/renderer/camera.mjs', 'src/**/*',
  ]).includes('src/renderer/camera.mjs'), true, 'later inclusion can re-include')
})

test('builder files matcher fails closed on unsupported or unsafe rules', () => {
  for (const rule of [
    '', '!', '/absolute/**/*', '../outside/**/*', 'src/{main,renderer}/**/*',
    'src/[ab].mjs', 'src/@(main|renderer)/**/*', 'src/!(camera).mjs', 'src\\**\\*',
  ]) {
    assert.throws(
      () => evaluateBuilderFiles(DESKTOP_FILES, [rule]),
      PackageInspectionError,
      rule,
    )
  }
})

test('workspace package files materialization catches changed files rules and missing entry', () => {
  const installed = [
    'package.json',
    'dist/src/index.js',
    'dist/src/desktop-entry.js',
    'dist/test/desktop-entry.test.js',
    'src/desktop-entry.ts',
  ]
  assert.deepEqual(evaluatePackageFiles(installed, ['dist/src']), [
    'dist/src/desktop-entry.js',
    'dist/src/index.js',
    'package.json',
  ])
  assert.equal(evaluatePackageFiles(installed, ['dist/other']).includes(
    'dist/src/desktop-entry.js',
  ), false)
  assert.equal(evaluatePackageFiles(installed.filter(
    file => file !== 'dist/src/desktop-entry.js',
  ), ['dist/src']).includes('dist/src/desktop-entry.js'), false)
})

function validArtifactFiles() {
  return [
    'src/main/main.mjs',
    'src/main/camera-source.mjs',
    'src/renderer/camera.mjs',
    'node_modules/@nova-audio-agent/runtime/package.json',
    'node_modules/@nova-audio-agent/runtime/dist/src/desktop-entry.js',
    'node_modules/ws/package.json',
    'node_modules/zod/package.json',
    'package.json',
  ]
}

test('artifact file-list entry point catches missing camera/runtime and forbidden surfaces', () => {
  assert.doesNotThrow(() => inspectPackagedFileList(validArtifactFiles()))
  for (const missing of [
    'src/renderer/camera.mjs',
    'node_modules/@nova-audio-agent/runtime/dist/src/desktop-entry.js',
    'node_modules/ws/package.json',
    'node_modules/zod/package.json',
  ]) {
    assert.throws(
      () => inspectPackagedFileList(validArtifactFiles().filter(file => file !== missing)),
      PackageInspectionError,
      missing,
    )
  }
  for (const forbidden of [
    'assets/demos/cat-sofa-guard/cat-sofa-guard.mp4',
    'src/nova_audio_agent/camera.py',
    'pyproject.toml',
    'uv.lock',
    'node_modules/opencv4nodejs/index.js',
    'node_modules/ffmpeg-static/ffmpeg',
    'node_modules/python-shell/index.js',
    'node_modules/node-webcam/index.js',
  ]) {
    assert.throws(
      () => inspectPackagedFileList([...validArtifactFiles(), forbidden]),
      PackageInspectionError,
      forbidden,
    )
  }
  assert.throws(
    () => inspectPackagedFileList(validArtifactFiles(), { runtimeDependencies: ['ws'] }),
    PackageInspectionError,
    'missing runtime dependency must fail closed',
  )
})

test('actual configured graph derives camera and runtime from config plus installed content', async () => {
  const result = await inspectConfiguredPackage()
  assert.equal(result.cameraIncluded, true)
  assert.equal(result.runtimeIncluded, true)
  assert.ok(result.includedFiles.includes('src/renderer/camera.mjs'))
  assert.ok(result.includedFiles.includes(
    'node_modules/@nova-audio-agent/runtime/dist/src/desktop-entry.js',
  ))
  assert.ok(result.includedFiles.includes('node_modules/ws/package.json'))
  assert.ok(result.includedFiles.includes('node_modules/zod/package.json'))
  assert.deepEqual(result.productionDependencies, ['@nova-audio-agent/runtime'])
  assert.equal(result.forbidden.length, 0)
})
