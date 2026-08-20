import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import test from 'node:test'

import { createPackage, extractAll, listPackage } from '@electron/asar'

import * as packageInspection from '../scripts/inspect-package.mjs'

const {
  PackageInspectionError,
  evaluateBuilderFiles,
  evaluatePackageFiles,
  inspectConfiguredPackage,
  inspectPackagedFileList,
} = packageInspection

const DESKTOP_FILES = [
  'src/main/main.mjs',
  'src/renderer/camera.mjs',
  'src/renderer/orb-visual.mjs',
  'package.json',
  'assets/demos/cat-sofa-guard/cat-sofa-guard.mp4',
]

const DESKTOP_MANIFEST = Object.freeze({
  name: '@nova-audio-agent/ambient-orb',
  dependencies: { '@nova-audio-agent/runtime': '0.1.0' },
})
const RUNTIME_MANIFEST = Object.freeze({
  name: '@nova-audio-agent/runtime',
  files: ['dist/src'],
  dependencies: { ws: '8.21.3', zod: '4.4.3' },
})

function inspectArtifact(files, overrides = {}) {
  return inspectPackagedFileList(files, {
    desktopManifest: DESKTOP_MANIFEST,
    runtimeManifest: RUNTIME_MANIFEST,
    ...overrides,
  })
}

async function writeArtifactRoot(root, {
  desktopManifest = DESKTOP_MANIFEST,
  runtimeManifest = RUNTIME_MANIFEST,
} = {}) {
  const files = new Map([
    ['package.json', JSON.stringify(desktopManifest)],
    ['src/main/main.mjs', 'export {}\n'],
    ['src/main/camera-source.mjs', 'export {}\n'],
    ['src/renderer/camera.mjs', 'export const camera = true\n'],
    ['node_modules/@nova-audio-agent/runtime/package.json', JSON.stringify(runtimeManifest)],
    ['node_modules/@nova-audio-agent/runtime/dist/src/desktop-entry.js', 'export {}\n'],
    ['node_modules/ws/package.json', '{"name":"ws"}\n'],
    ['node_modules/zod/package.json', '{"name":"zod"}\n'],
  ])
  for (const [file, body] of files) {
    const target = resolve(root, file)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body, 'utf8')
  }
}

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
  assert.doesNotThrow(() => inspectArtifact(validArtifactFiles()))
  for (const missing of [
    'package.json',
    'node_modules/@nova-audio-agent/runtime/package.json',
    'src/renderer/camera.mjs',
    'node_modules/@nova-audio-agent/runtime/dist/src/desktop-entry.js',
    'node_modules/ws/package.json',
    'node_modules/zod/package.json',
  ]) {
    assert.throws(
      () => inspectArtifact(validArtifactFiles().filter(file => file !== missing)),
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
      () => inspectArtifact([...validArtifactFiles(), forbidden]),
      PackageInspectionError,
      forbidden,
    )
  }
  assert.throws(
    () => inspectArtifact(validArtifactFiles(), {
      runtimeManifest: { ...RUNTIME_MANIFEST, dependencies: { ws: '8.21.3' } },
    }),
    PackageInspectionError,
    'missing runtime dependency must fail closed',
  )
})

test('artifact dependency closure comes only from required manifest contents', () => {
  assert.throws(
    () => inspectPackagedFileList(validArtifactFiles()),
    PackageInspectionError,
    'artifact inspection cannot default manifest evidence',
  )
  assert.throws(
    () => inspectArtifact([...validArtifactFiles(), 'node_modules/lodash/package.json']),
    PackageInspectionError,
    'an ordinary undeclared package must fail even when its name is not otherwise forbidden',
  )
  assert.throws(
    () => inspectArtifact(validArtifactFiles(), {
      desktopManifest: {
        ...DESKTOP_MANIFEST,
        dependencies: {
          '@nova-audio-agent/runtime': '0.1.0',
          lodash: '4.17.21',
        },
      },
    }),
    PackageInspectionError,
    'desktop dependency expansion must fail',
  )
  assert.throws(
    () => inspectArtifact(validArtifactFiles(), {
      runtimeManifest: { ...RUNTIME_MANIFEST, files: ['dist/other'] },
    }),
    PackageInspectionError,
    'the runtime entry must be selected by its own files contract',
  )
  assert.throws(
    () => inspectArtifact([
      ...validArtifactFiles(),
      'node_modules/@nova-audio-agent/runtime/src/private.ts',
    ]),
    PackageInspectionError,
    'runtime artifact files outside the manifest files contract must fail',
  )
  assert.throws(
    () => inspectArtifact(validArtifactFiles(), {
      runtimeManifest: { ...RUNTIME_MANIFEST, optionalDependencies: null },
    }),
    PackageInspectionError,
    'malformed dependency closure fields must fail closed',
  )
  assert.throws(
    () => inspectArtifact(validArtifactFiles(), {
      runtimeManifest: Object.assign(Object.create(null), RUNTIME_MANIFEST),
    }),
    PackageInspectionError,
    'manifest inputs must be plain JSON objects',
  )
  assert.doesNotThrow(() => inspectArtifact([
    ...validArtifactFiles(),
    'node_modules/.package-lock.json',
  ]))
})

test('desktop and runtime peer surfaces cannot widen the production closure', () => {
  for (const layer of ['desktop', 'runtime']) {
    for (const [field, value] of [
      ['peerDependencies', { lodash: '4.17.21' }],
      ['peerDependenciesMeta', { lodash: { optional: true } }],
      ['peerDependencies', null],
      ['peerDependenciesMeta', []],
    ]) {
      assert.throws(
        () => inspectArtifact(validArtifactFiles(), {
          [`${layer}Manifest`]: {
            ...(layer === 'desktop' ? DESKTOP_MANIFEST : RUNTIME_MANIFEST),
            [field]: value,
          },
        }),
        PackageInspectionError,
        `${layer} ${field} must be an absent or empty plain object`,
      )
    }
  }
  assert.doesNotThrow(() => inspectArtifact(validArtifactFiles(), {
    desktopManifest: {
      ...DESKTOP_MANIFEST,
      peerDependencies: {},
      peerDependenciesMeta: {},
    },
    runtimeManifest: {
      ...RUNTIME_MANIFEST,
      peerDependencies: {},
      peerDependenciesMeta: {},
    },
  }))
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

test('artifact-root entry reads bounded manifests from the inspected artifact itself', async () => {
  assert.equal(typeof packageInspection.inspectArtifactRoot, 'function')
  const root = await mkdtemp(resolve(tmpdir(), 'nova-package-artifact-'))
  try {
    await writeArtifactRoot(root)
    const result = await packageInspection.inspectArtifactRoot(root)
    assert.equal(result.cameraIncluded, true)
    assert.deepEqual(result.productionDependencies, ['@nova-audio-agent/runtime'])

    for (const missing of ['package.json', 'node_modules/@nova-audio-agent/runtime/package.json']) {
      await rm(resolve(root, missing))
      await assert.rejects(
        packageInspection.inspectArtifactRoot(root),
        PackageInspectionError,
        `physically removing ${missing} must fail artifact-root inspection`,
      )
      await writeArtifactRoot(root)
    }

    const fileList = resolve(root, 'asar-file-list.json')
    await writeFile(
      fileList,
      JSON.stringify(validArtifactFiles().map(file => `/${file}`)),
      'utf8',
    )
    await assert.rejects(
      packageInspection.inspectArtifactFileList(fileList),
      PackageInspectionError,
      'a file list alone cannot substitute expected manifest contents',
    )
    await writeFile(
      fileList,
      JSON.stringify([...validArtifactFiles(), 'secret-path-sentinel']),
      'utf8',
    )
    await assert.rejects(
      packageInspection.inspectArtifactFileList(fileList, root),
      error => {
        assert.ok(error instanceof PackageInspectionError)
        assert.doesNotMatch(error.message, /nova-package-artifact|secret-path-sentinel/u)
        return true
      },
    )
    await writeFile(
      fileList,
      JSON.stringify(validArtifactFiles().map(file => `/${file}`)),
      'utf8',
    )
    const listed = await packageInspection.inspectArtifactFileList(fileList, root)
    assert.equal(listed.runtimeIncluded, true, 'asar-style leading slashes are list syntax')
    for (const missing of ['package.json', 'node_modules/@nova-audio-agent/runtime/package.json']) {
      await writeFile(
        fileList,
        JSON.stringify(validArtifactFiles().filter(file => file !== missing)),
        'utf8',
      )
      await assert.rejects(
        packageInspection.inspectArtifactFileList(fileList, root),
        PackageInspectionError,
        missing,
      )
    }

    await writeFile(resolve(root, 'package.json'), '{malformed secret-path-sentinel', 'utf8')
    await assert.rejects(
      packageInspection.inspectArtifactRoot(root),
      error => {
        assert.ok(error instanceof PackageInspectionError)
        assert.doesNotMatch(error.message, /nova-package-artifact|secret-path-sentinel/u)
        return true
      },
    )

    await writeFile(
      resolve(root, 'package.json'),
      JSON.stringify({ ...DESKTOP_MANIFEST, padding: 'x'.repeat(128 * 1024) }),
      'utf8',
    )
    await assert.rejects(
      packageInspection.inspectArtifactRoot(root),
      error => {
        assert.ok(error instanceof PackageInspectionError)
        assert.doesNotMatch(error.message, /nova-package-artifact/u)
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('real ASAR listings admit structural directories but reject an extra package directory', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-package-asar-'))
  const source = resolve(root, 'source')
  const archive = resolve(root, 'app.asar')
  const extracted = resolve(root, 'extracted')
  const listFile = resolve(root, 'asar-file-list.json')
  try {
    await writeArtifactRoot(source)
    await createPackage(source, archive)
    const listed = listPackage(archive)
    assert.ok(listed.includes('/node_modules'))
    assert.ok(listed.includes('/node_modules/@nova-audio-agent'))
    extractAll(archive, extracted)
    await writeFile(listFile, JSON.stringify(listed), 'utf8')

    const valid = await packageInspection.inspectArtifactFileList(listFile, extracted)
    assert.equal(valid.runtimeIncluded, true)

    await mkdir(resolve(source, 'node_modules/lodash'), { recursive: true })
    const expandedArchive = resolve(root, 'expanded.asar')
    const expandedRoot = resolve(root, 'expanded')
    await createPackage(source, expandedArchive)
    const expandedList = listPackage(expandedArchive)
    assert.ok(expandedList.includes('/node_modules/lodash'))
    extractAll(expandedArchive, expandedRoot)
    await writeFile(listFile, JSON.stringify(expandedList), 'utf8')
    await assert.rejects(
      packageInspection.inspectArtifactFileList(listFile, expandedRoot),
      PackageInspectionError,
      'filtering directory entries must not conceal an undeclared empty package',
    )
    await assert.rejects(
      packageInspection.inspectArtifactRoot(expandedRoot),
      PackageInspectionError,
      'root inspection must retain the same undeclared directory evidence',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
