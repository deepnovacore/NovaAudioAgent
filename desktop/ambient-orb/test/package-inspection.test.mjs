import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve, sep } from 'node:path'
import test from 'node:test'

import { createPackage, createPackageWithOptions, extractAll, listPackage } from '@electron/asar'

import * as packageInspection from '../scripts/inspect-package.mjs'
import { generateNativeResourceManifest } from '../scripts/native-resource-contract.mjs'
import { deriveLockedProductionClosure } from '../scripts/release-dependency-closure.mjs'

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
  dependencies: {
    '@livekit/agents': '1.6.4',
    '@livekit/rtc-node': '0.13.33',
    undici: '7.29.0',
    ws: '8.21.3',
    zod: '4.4.3',
  },
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
    ['node_modules/@livekit/agents/package.json', '{"name":"@livekit/agents"}\n'],
    ['node_modules/@livekit/rtc-node/package.json', '{"name":"@livekit/rtc-node"}\n'],
    ['node_modules/undici/package.json', '{"name":"undici"}\n'],
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
    'node_modules/@livekit/agents/package.json',
    'node_modules/@livekit/rtc-node/package.json',
    'node_modules/undici/package.json',
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
    'node_modules/@livekit/agents/package.json',
    'node_modules/@livekit/rtc-node/package.json',
    'node_modules/undici/package.json',
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
    'node_modules/example/test/private.js',
    'node_modules/example/dist/private.test.js',
    'node_modules/example/dist/private.js.map',
    'node_modules/example/src/private.ts',
    'node_modules/example/demo.png',
    'node_modules/example/fake-app-server.js',
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

test('configured graph follows the target-applicable lock closure without treating package filenames as executables', async () => {
  const targetId = process.platform === 'darwin'
    ? `darwin-${process.arch}`
    : process.platform === 'win32'
      ? `win32-${process.arch}`
      : `linux-${process.arch}-gnu`
  const localInferencePackage = {
    'darwin-arm64': '@livekit/local-inference-darwin-arm64@0.2.7',
    'darwin-x64': '@livekit/local-inference-darwin-x64@0.2.7',
    'linux-x64-gnu': '@livekit/local-inference-linux-x64-gnu@0.2.7',
    'win32-x64': '@livekit/local-inference-win32-x64-msvc@0.2.7',
  }[targetId]
  assert.ok(localInferencePackage, `unsupported package-inspection test target: ${targetId}`)

  const result = await inspectConfiguredPackage({ targetId })
  assert.ok(result.selectedPackages.includes('@livekit/agents@1.6.4'))
  assert.ok(result.selectedPackages.includes('@livekit/local-inference@0.2.7'))
  assert.ok(result.selectedPackages.includes(localInferencePackage))
  assert.ok(result.selectedPackages.includes('fluent-ffmpeg@2.1.3'))
  assert.deepEqual(
    result.selectedPackages.filter(value => /ffmpeg/iu.test(value)),
    ['fluent-ffmpeg@2.1.3'],
    'only the locked LiveKit public-root JavaScript wrapper exception is selected',
  )
  assert.equal(
    result.selectedPackages.filter(value => value.startsWith('@livekit/local-inference-')).length,
    1,
    'only the current target local-inference package is selected',
  )
  assert.ok(!result.includedFiles.some(value => /\.test\.(?:c?m?js|ts)$/u.test(value)))
  assert.ok(!result.includedFiles.some(value => value.endsWith('.map')))
  assert.ok(!result.includedFiles.some(value => /\.(?:snap|png|mts)$/u.test(value)))
  assert.ok(!result.includedFiles.some(value => /@livekit\/av-[^/]+\/ffmpeg$/u.test(value)))
  assert.ok(!result.includedFiles.some(value => (
    /(?:^|\/)(?:ffmpeg|ffprobe)(?:\.exe)?$/iu.test(value)
    || /(?:^|\/)(?:lib)?(?:avcodec|avdevice|avfilter|avformat|avutil|swresample|swscale)(?:[-.]|$).*(?:\.dylib|\.so(?:\.\d+)*|\.dll)$/iu.test(value)
  )))
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
    const portableListed = listed.map(file => file.replaceAll('\\', '/'))
    assert.ok(portableListed.includes('/node_modules'))
    assert.ok(portableListed.includes('/node_modules/@nova-audio-agent'))
    extractAll(archive, extracted)
    await writeFile(listFile, JSON.stringify(listed), 'utf8')

    const valid = await packageInspection.inspectArtifactFileList(listFile, extracted)
    assert.equal(valid.runtimeIncluded, true)

    await writeFile(
      listFile,
      JSON.stringify(listed.map(file => file.replace(/^\//u, '\\'))),
      'utf8',
    )
    const windowsListed = await packageInspection.inspectArtifactFileList(listFile, extracted)
    assert.equal(windowsListed.runtimeIncluded, true, 'Windows ASAR lists use one leading backslash')

    for (const unsafe of ['//package.json', '\\\\package.json', 'C:/package.json']) {
      await writeFile(listFile, JSON.stringify([unsafe]), 'utf8')
      await assert.rejects(
        packageInspection.inspectArtifactFileList(listFile, extracted),
        error => error instanceof PackageInspectionError && /unsafe package path/u.test(error.message),
        `must reject ${JSON.stringify(unsafe)} without stripping more than one ASAR list separator`,
      )
    }

    await mkdir(resolve(source, 'node_modules/lodash'), { recursive: true })
    const expandedArchive = resolve(root, 'expanded.asar')
    const expandedRoot = resolve(root, 'expanded')
    await createPackage(source, expandedArchive)
    const expandedList = listPackage(expandedArchive)
    assert.ok(expandedList.map(file => file.replaceAll('\\', '/')).includes('/node_modules/lodash'))
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

test('release inspection cannot cross-pair an ASAR listing with a different extraction root', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-package-cross-pair-'))
  const sourceA = resolve(root, 'source-a')
  const sourceB = resolve(root, 'source-b')
  const archiveA = resolve(root, 'a.asar')
  const extractedB = resolve(root, 'extracted-b')
  const listFile = resolve(root, 'a-list.json')
  try {
    await writeArtifactRoot(sourceA)
    await writeArtifactRoot(sourceB)
    await writeFile(resolve(sourceB, 'src/renderer/camera.mjs'), 'export const fromB = true\n')
    await createPackage(sourceA, archiveA)
    await createPackage(sourceB, resolve(root, 'b.asar'))
    extractAll(resolve(root, 'b.asar'), extractedB)
    await writeFile(listFile, JSON.stringify(listPackage(archiveA)), 'utf8')

    const command = spawnSync(process.execPath, [
      resolve(import.meta.dirname, '../scripts/inspect-package.mjs'),
      '--file-list', listFile,
      '--artifact-root', extractedB,
    ], { encoding: 'utf8' })
    assert.notEqual(command.status, 0, 'a caller-supplied list/root pair is not a release API')
    assert.doesNotMatch(command.stderr, /cross-pair|source-a|source-b|extracted-b/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('built candidate CLI emits only a stable bounded rejection', () => {
  const command = spawnSync(process.execPath, [
    resolve(import.meta.dirname, '../scripts/inspect-built-preview.mjs'),
    '--caller-selected-artifact',
  ], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.notEqual(command.status, 0)
  assert.equal(command.stderr, 'desktop package inspection rejected\n')
  assert.doesNotMatch(command.stderr, /node-typescript-runtime|nova-release-candidate|at async/u)

  const diagnostic = spawnSync(process.execPath, [
    resolve(import.meta.dirname, '../scripts/inspect-built-preview.mjs'),
    '--caller-selected-artifact',
  ], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    timeout: 30_000,
    env: {...process.env, NOVA_RELEASE_INSPECTION_DIAGNOSTICS: '1'},
  })
  assert.notEqual(diagnostic.status, 0)
  assert.equal(diagnostic.stderr, 'desktop package inspection rejected: usage rejected\n')
  assert.doesNotMatch(diagnostic.stderr, /node-typescript-runtime|nova-release-candidate|at async/u)
})

test('container preflight rejects a compressed bomb before creating extraction output', async () => {
  assert.equal(typeof packageInspection.extractPreflightedContainer, 'function')
  const root = await mkdtemp(resolve(tmpdir(), 'nova-container-bomb-'))
  const raw = resolve(root, 'container-raw')
  let extractionCalled = false
  const listing = [
    'Path = payload.bin',
    'Size = 2147483649',
    'Packed Size = 128',
    'Folder = -',
    'Attributes = A',
    '',
  ].join('\n')
  try {
    await assert.rejects(
      packageInspection.extractPreflightedContainer({
        format: 'appimage',
        listing,
        destinationRoot: raw,
        extractEntry: async () => { extractionCalled = true },
      }),
      error => {
        assert.equal(error.message, 'desktop package contract rejected: candidate container listing rejected')
        return true
      },
    )
    assert.equal(extractionCalled, false)
    await assert.rejects(lstat(raw), error => error.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a successful bounded container listing may carry an ignored stderr warning', async () => {
  assert.equal(typeof packageInspection.runBoundedListing, 'function')
  const root = await mkdtemp(resolve(tmpdir(), 'nova-container-listing-warning-'))
  const tool = resolve(root, 'listing-tool.mjs')
  try {
    await writeFile(tool, [
      "process.stdout.write('Path = payload\\nSize = 0\\nFolder = +\\n\\n')",
      "process.stderr.write('bounded extractor warning\\n')",
      '',
    ].join('\n'))
    assert.equal(
      packageInspection.runBoundedListing(process.execPath, [tool], root),
      'Path = payload\nSize = 0\nFolder = +\n\n',
    )
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('bounded container listing exposes only a stable diagnostic class for tool failure', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-container-listing-failure-'))
  const tool = resolve(root, 'listing-tool.mjs')
  try {
    await writeFile(tool, 'process.exitCode = 23\n')
    assert.throws(
      () => packageInspection.runBoundedListing(process.execPath, [tool], root),
      error => {
        assert.equal(error.message, 'desktop package contract rejected: candidate container listing rejected')
        assert.equal(error.diagnosticCode, 'tool-status-23')
        return true
      },
    )
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('AppImage inspection snapshots only the appended SquashFS payload without executing it', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-appimage-filesystem-'))
  const source = resolve(root, 'candidate.AppImage')
  const destination = resolve(root, 'candidate.squashfs')
  try {
    const image = Buffer.alloc(320)
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(image, 0)
    image[4] = 2
    image[5] = 1
    Buffer.from([0x41, 0x49, 0x02]).copy(image, 8)
    image.writeBigUInt64LE(64n, 40)
    image.writeUInt16LE(64, 58)
    image.writeUInt16LE(2, 60)
    image.writeBigUInt64LE(160n, 64 + 64 + 24)
    image.writeBigUInt64LE(96n, 64 + 64 + 32)
    Buffer.from('hsqs').copy(image, 256)
    Buffer.from('bounded-payload').copy(image, 260)
    await writeFile(source, image)

    assert.deepEqual(
      await packageInspection.captureAppImageFilesystem(source, destination),
      {offset: 256, size: 64},
    )
    assert.deepEqual(await readFile(destination), image.subarray(256))
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('AppImage filesystem snapshot rejects invalid type or payload magic', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-appimage-invalid-'))
  try {
    for (const [name, typeMagic, payloadMagic] of [
      ['type', [0x41, 0x49, 0x01], 'hsqs'],
      ['payload', [0x41, 0x49, 0x02], 'nope'],
    ]) {
      const source = resolve(root, `${name}.AppImage`)
      const destination = resolve(root, `${name}.squashfs`)
      const image = Buffer.alloc(196)
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(image, 0)
      image[4] = 2
      image[5] = 1
      Buffer.from(typeMagic).copy(image, 8)
      image.writeBigUInt64LE(64n, 40)
      image.writeUInt16LE(64, 58)
      image.writeUInt16LE(1, 60)
      Buffer.from(payloadMagic).copy(image, 128)
      await writeFile(source, image)
      await assert.rejects(
        packageInspection.captureAppImageFilesystem(source, destination),
        PackageInspectionError,
      )
      await assert.rejects(lstat(destination), error => error.code === 'ENOENT')
    }
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('container preflight rejects excessive entries and unsafe paths before extraction', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-container-entries-'))
  const raw = resolve(root, 'container-raw')
  const record = index => [
    `Path = files/f${index}.txt`,
    'Size = 1',
    'Packed Size = 1',
    'Folder = -',
    'Attributes = A',
    '',
  ].join('\n')
  try {
    const many = Array.from({ length: 10_001 }, (_, index) => record(index)).join('')
    await assert.rejects(packageInspection.extractPreflightedContainer({
      format: 'nsis',
      listing: many,
      destinationRoot: raw,
      extractEntry: async () => assert.fail('must not extract'),
    }), PackageInspectionError)
    await assert.rejects(lstat(raw), error => error.code === 'ENOENT')

    for (const path of ['../escape', '/absolute', 'C:\\escape', 'safe/../../escape']) {
      await assert.rejects(packageInspection.extractPreflightedContainer({
        format: 'nsis',
        listing: record(1).replace('files/f1.txt', path),
        destinationRoot: raw,
        extractEntry: async () => assert.fail('must not extract'),
      }), PackageInspectionError, path)
      await assert.rejects(lstat(raw), error => error.code === 'ENOENT')
    }

    const invalidListings = [
      `${record(1)}${record(1)}`,
      `${record(1).replace('files/f1.txt', 'FILES/F1.TXT')}${record(1)}`,
      record(1).replace('Attributes = A', 'Attributes = A lrwxr-xr-x'),
      record(1).replace('files/f1.txt', Array.from({ length: 65 }, () => 'x').join('/')),
      `${record(1).replace('files/f1.txt', 'parent')}${record(2).replace('files/f2.txt', 'parent/child')}`,
    ]
    for (const listing of invalidListings) {
      await assert.rejects(packageInspection.extractPreflightedContainer({
        format: 'appimage',
        listing,
        destinationRoot: raw,
        extractEntry: async () => assert.fail('must not extract'),
      }), PackageInspectionError)
      await assert.rejects(lstat(raw), error => error.code === 'ENOENT')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('container preflight accepts bounded 7z and deb file inventories', () => {
  const sevenZip = packageInspection.preflightContainerListing({
    format: 'appimage',
    listing: [
      'Path = resources',
      'Size = 0',
      'Packed Size = 0',
      'Attributes = D drwxr-xr-x',
      '',
      'Path = resources/app.asar',
      'Size = 12',
      'Packed Size = 4',
      'Attributes = A -rw-r--r--',
      '',
    ].join('\n'),
  })
  assert.deepEqual(sevenZip.map(({ path, type, size }) => ({ path, type, size })), [
    { path: 'resources', type: 'directory', size: 0 },
    { path: 'resources/app.asar', type: 'file', size: 12 },
  ])

  const deb = packageInspection.preflightContainerListing({
    format: 'deb',
    listing: [
      'drwxr-xr-x root/root 0 2026-08-22 00:00 ./',
      'drwxr-xr-x root/root 0 2026-08-22 00:00 ./usr/',
      '-rw-r--r-- root/root 12 2026-08-22 00:00 ./usr/app.asar',
      '',
    ].join('\n'),
  })
  assert.deepEqual(deb.map(({ path, type, size }) => ({ path, type, size })), [
    { path: 'usr', type: 'directory', size: 0 },
    { path: 'usr/app.asar', type: 'file', size: 12 },
  ])
})

test('container preflight admits only internal relative links and verifies their extracted targets', async () => {
  const sevenZip = packageInspection.preflightContainerListing({
    format: 'appimage',
    listing: [
      'Path = AppRun',
      'Size = 12',
      'Packed Size = 0',
      'Attributes = A lrwxrwxrwx',
      'Symbolic Link = usr/bin/nova',
      '',
    ].join('\n'),
  })
  assert.deepEqual(sevenZip, [
    { path: 'AppRun', raw_path: 'AppRun', type: 'link', size: 0, target: 'usr/bin/nova' },
  ])

  const deb = packageInspection.preflightContainerListing({
    format: 'deb',
    listing: 'lrwxrwxrwx root/root 12 2026-08-22 00:00 ./usr/bin/nova -> ../lib/nova\n',
  })
  assert.deepEqual(deb, [
    {
      path: 'usr/bin/nova', raw_path: './usr/bin/nova',
      type: 'link', size: 0, target: '../lib/nova',
    },
  ])

  for (const [format, listing] of [
    ['appimage', [
      'Path = AppRun', 'Size = 0', 'Attributes = A lrwxrwxrwx',
      'Symbolic Link = /outside', '',
    ].join('\n')],
    ['deb', 'lrwxrwxrwx root/root 7 2026-08-22 00:00 ./usr/bin/nova -> ../../../outside\n'],
  ]) {
    assert.throws(
      () => packageInspection.preflightContainerListing({ format, listing }),
      PackageInspectionError,
    )
  }

  if (process.platform === 'win32') return
  const root = await mkdtemp(resolve(tmpdir(), 'nova-container-safe-link-'))
  const raw = resolve(root, 'raw')
  try {
    await packageInspection.extractPreflightedContainer({
      format: 'appimage',
      listing: [
        'Path = usr', 'Size = 0', 'Attributes = D drwxr-xr-x', '',
        'Path = usr/bin', 'Size = 0', 'Attributes = D drwxr-xr-x', '',
        'Path = usr/bin/nova', 'Size = 4', 'Attributes = A -rwxr-xr-x', '',
        'Path = AppRun', 'Size = 12', 'Attributes = A lrwxrwxrwx',
        'Symbolic Link = usr/bin/nova', '',
      ].join('\n'),
      destinationRoot: raw,
      extract: async () => {
        await mkdir(resolve(raw, 'usr/bin'), { recursive: true })
        await writeFile(resolve(raw, 'usr/bin/nova'), 'nova')
        await symlink('usr/bin/nova', resolve(raw, 'AppRun'))
      },
    })
    await rm(raw, { recursive: true, force: true })
    await assert.rejects(packageInspection.extractPreflightedContainer({
      format: 'appimage',
      listing: [
        'Path = AppRun', 'Size = 12', 'Attributes = A lrwxrwxrwx',
        'Symbolic Link = usr/bin/nova', '',
      ].join('\n'),
      destinationRoot: raw,
      extract: async () => symlink('usr/bin/other', resolve(raw, 'AppRun')),
    }), PackageInspectionError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('installer inspection never executes an ELECTRON_BUILDER_7ZIP_PATH override', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-container-tool-override-'))
  const candidate = resolve(root, 'candidate.exe')
  const sentinel = resolve(root, 'override-called')
  const preload = resolve(root, 'sentinel.cjs')
  try {
    await writeFile(candidate, 'not-an-installer')
    await writeFile(preload, [
      "const { writeFileSync } = require('node:fs')",
      "if (process.argv.includes('-slt')) writeFileSync(process.env.NOVA_7ZIP_SENTINEL, 'called')",
      '',
    ].join('\n'))
    const command = spawnSync(process.execPath, [
      resolve(import.meta.dirname, '../scripts/inspect-package.mjs'),
      '--artifact', candidate,
      '--target', 'win32-x64',
      '--format', 'nsis',
    ], {
      cwd: resolve(import.meta.dirname, '../../..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_BUILDER_7ZIP_PATH: process.execPath,
        NODE_OPTIONS: `--require=${preload}`,
        NOVA_7ZIP_SENTINEL: sentinel,
      },
    })
    assert.notEqual(command.status, 0)
    assert.equal(
      command.stderr,
      'desktop package contract rejected: candidate container listing rejected\n',
    )
    await assert.rejects(lstat(sentinel), error => error.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('locked installer tool snapshots one verified package-owned executable and rejects mutations', async () => {
  assert.equal(typeof packageInspection.snapshotLockedSevenZipTool, 'function')
  const root = await mkdtemp(resolve(tmpdir(), 'nova-locked-container-tool-'))
  const lockPath = resolve(root, 'package-lock.json')
  const packageRoot = resolve(root, 'node_modules/7zip-bin')
  const relativeToolPath = process.platform === 'darwin'
    ? `mac/${process.arch}/7za`
    : process.platform === 'win32'
      ? `win/${process.arch}/7za.exe`
      : `linux/${process.arch}/7za`
  const toolPath = resolve(packageRoot, relativeToolPath)
  const installedPackageRoot = resolve(import.meta.dirname, '../../../node_modules/7zip-bin')
  const toolBytes = await readFile(resolve(installedPackageRoot, relativeToolPath))
  assert.equal(packageInspection.assertCurrentHostSevenZipBinary(toolBytes), true)
  const wrongArchitecture = Buffer.from(toolBytes)
  if (process.platform === 'darwin') {
    wrongArchitecture.writeUInt32LE(process.arch === 'arm64' ? 0x01000007 : 0x0100000c, 4)
  } else if (process.platform === 'linux') {
    wrongArchitecture.writeUInt16LE(183, 18)
  } else {
    wrongArchitecture.writeUInt16LE(0xaa64, wrongArchitecture.readUInt32LE(0x3c) + 4)
  }
  assert.throws(
    () => packageInspection.assertCurrentHostSevenZipBinary(wrongArchitecture),
    error => {
      assert.equal(
        error.message,
        'desktop package contract rejected: candidate container tool rejected',
      )
      return true
    },
  )
  const resolved = 'https://registry.npmmirror.com/7zip-bin/-/7zip-bin-5.2.0.tgz'
  const integrity = 'sha512-ukTPVhqG4jNzMro2qA9HSCSSVJN3aN7tlb+hfqYCt3ER0yWroeA2VR38MNrOHLQ/cVj+DaIMad0kFCtWWowh/A=='
  const writeFixture = async ({ bytes = toolBytes, writeTool = true } = {}) => {
    await mkdir(dirname(toolPath), { recursive: true })
    await writeFile(resolve(packageRoot, 'package.json'), JSON.stringify({ name: '7zip-bin', version: '5.2.0' }))
    if (writeTool) {
      await writeFile(toolPath, bytes, { mode: 0o700 })
      await chmod(toolPath, 0o700)
    }
    await writeFile(lockPath, JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/7zip-bin': {
          version: '5.2.0', resolved, integrity, dev: true,
        },
      },
    }))
  }
  const snapshotRoot = resolve(root, 'snapshot')
  const rejectsTool = promise => assert.rejects(promise, error => {
    assert.equal(
      error.message,
      'desktop package contract rejected: candidate container tool rejected',
    )
    return true
  })
  try {
    await writeFixture()
    const snapshot = await packageInspection.snapshotLockedSevenZipTool({
      lockPath, privateRoot: snapshotRoot,
    })
    assert.equal(snapshot.size, toolBytes.length)
    assert.notEqual(snapshot.path, toolPath)
    await writeFile(toolPath, Buffer.alloc(toolBytes.length, 0xff))
    assert.deepEqual(await readFile(snapshot.path), toolBytes)

    await rm(snapshotRoot, { recursive: true, force: true })
    const changedBytes = Buffer.from(toolBytes)
    changedBytes[changedBytes.length - 1] ^= 0xff
    await writeFixture({ bytes: changedBytes })
    await rejectsTool(packageInspection.snapshotLockedSevenZipTool({
      lockPath, privateRoot: snapshotRoot,
    }))

    await rm(snapshotRoot, { recursive: true, force: true })
    await rm(toolPath, { force: true })
    await writeFixture({ writeTool: false })
    await rejectsTool(packageInspection.snapshotLockedSevenZipTool({
      lockPath, privateRoot: snapshotRoot,
    }))

    if (process.platform !== 'win32') {
      await writeFixture()
      await chmod(toolPath, 0o722)
      await rejectsTool(packageInspection.snapshotLockedSevenZipTool({
        lockPath, privateRoot: snapshotRoot,
      }))
    }

    if (process.platform !== 'win32') {
      await writeFixture()
      const linkTarget = resolve(dirname(toolPath), 'real-7za')
      await writeFile(linkTarget, toolBytes, { mode: 0o700 })
      await rm(toolPath)
      await symlink('real-7za', toolPath)
      await rejectsTool(packageInspection.snapshotLockedSevenZipTool({
        lockPath, privateRoot: snapshotRoot,
      }))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('committed installer tool identity matches the current locked host binary', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-committed-container-tool-'))
  try {
    const snapshot = await packageInspection.snapshotLockedSevenZipTool({ privateRoot: root })
    assert.match(snapshot.sha256, /^[0-9a-f]{64}$/u)
    assert.ok(snapshot.size > 0)
    assert.ok(snapshot.path.startsWith(`${root}${sep}`))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('owned ASAR inspection hashes, lists, and extracts one private snapshot', async () => {
  assert.equal(typeof packageInspection.inspectAsarSnapshot, 'function')
  const root = await mkdtemp(resolve(tmpdir(), 'nova-package-owned-asar-'))
  const source = resolve(root, 'source')
  const archive = resolve(root, 'app.asar')
  try {
    await writeArtifactRoot(source)
    await createPackage(source, archive)
    const first = await packageInspection.inspectAsarSnapshot(archive)
    assert.match(first.asar_sha256, /^[0-9a-f]{64}$/u)
    assert.equal(first.cameraIncluded, true)
    assert.equal(first.runtimeIncluded, true)

    await writeFile(resolve(source, 'src/renderer/camera.mjs'), 'export const changed = true\n')
    await createPackage(source, resolve(root, 'changed.asar'))
    const changed = await packageInspection.inspectAsarSnapshot(resolve(root, 'changed.asar'))
    assert.notEqual(changed.asar_sha256, first.asar_sha256)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('owned ASAR inspection rejects excessive header depth before extraction', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-package-deep-asar-'))
  const source = resolve(root, 'source')
  const archive = resolve(root, 'deep.asar')
  try {
    await writeArtifactRoot(source)
    let directory = source
    for (let depth = 0; depth < 34; depth += 1) directory = resolve(directory, `d${depth}`)
    await mkdir(directory, { recursive: true })
    await writeFile(resolve(directory, 'payload.js'), 'export {}\n', 'utf8')
    await createPackage(source, archive)
    await assert.rejects(
      packageInspection.inspectAsarSnapshot(archive),
      error => error instanceof PackageInspectionError && /ASAR header rejected/u.test(error.message),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('release candidate inspection owns the complete application snapshot and requires native manifest', async () => {
  assert.equal(typeof packageInspection.inspectBuiltArtifact, 'function')
  const root = await mkdtemp(resolve(tmpdir(), 'nova-package-candidate-'))
  const source = resolve(root, 'source')
  const application = resolve(root, 'Candidate.app')
  const resources = resolve(application, 'Contents/Resources')
  try {
    await writeArtifactRoot(source)
    await mkdir(resources, { recursive: true })
    await createPackage(source, resolve(resources, 'app.asar'))
    await assert.rejects(
      packageInspection.inspectBuiltArtifact(application, {
        targetId: 'darwin-arm64',
        format: 'app',
      }),
      error => (
        error instanceof PackageInspectionError
        && /native resource manifest missing/u.test(error.message)
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('release candidate report binds artifact SHA and rejects an external resource swap', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-package-candidate-complete-'))
  const source = resolve(root, 'source')
  const application = resolve(root, 'Candidate.app')
  const resources = resolve(application, 'Contents/Resources')
  const lockPath = resolve(root, 'package-lock.json')
  const fakeMach = kind => {
    const body = Buffer.alloc(64)
    body.writeUInt32LE(0xfeedfacf, 0)
    body.writeUInt32LE(0x0100000c, 4)
    body.writeUInt32LE(kind === 'executable' ? 2 : 8, 12)
    if (kind === 'executable') {
      body.writeUInt32LE(1, 16)
      body.writeUInt32LE(24, 20)
      body.writeUInt32LE(0x32, 32)
      body.writeUInt32LE(24, 36)
      body.writeUInt32LE(1, 40)
      body.writeUInt32LE(0x000c0000, 44)
    }
    return body
  }
  try {
    await writeArtifactRoot(source)
    const packageFiles = new Map([
      ['node_modules/@livekit/local-inference/package.json', JSON.stringify({
        name: '@livekit/local-inference', version: '0.2.7',
      })],
      ['node_modules/@livekit/local-inference-darwin-arm64/package.json', JSON.stringify({
        name: '@livekit/local-inference-darwin-arm64', version: '0.2.7',
      })],
      [
        'node_modules/@livekit/local-inference-darwin-arm64/local-inference.darwin-arm64.node',
        fakeMach('node_addon'),
      ],
      ['node_modules/@livekit/rtc-ffi-bindings/package.json', JSON.stringify({
        name: '@livekit/rtc-ffi-bindings', version: '0.13.33',
      })],
      ['node_modules/@livekit/rtc-ffi-bindings-darwin-arm64/package.json', JSON.stringify({
        name: '@livekit/rtc-ffi-bindings-darwin-arm64', version: '0.13.33',
      })],
      [
        'node_modules/@livekit/rtc-ffi-bindings-darwin-arm64/rtc-node.darwin-arm64.node',
        fakeMach('node_addon'),
      ],
    ])
    for (const [path, body] of packageFiles) {
      const destination = resolve(source, path)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, body)
    }
    const lock = {
      lockfileVersion: 3,
      packages: {
        'desktop/ambient-orb': {
          name: '@nova-audio-agent/ambient-orb',
          dependencies: { '@nova-audio-agent/runtime': '0.1.0' },
        },
        'node_modules/@nova-audio-agent/runtime': { link: true, resolved: 'node/runtime' },
        'node/runtime': {
          name: '@nova-audio-agent/runtime', version: '0.1.0',
          dependencies: {
            '@livekit/agents': '1.6.4', '@livekit/rtc-node': '0.13.33',
            undici: '7.29.0', ws: '8.21.3', zod: '4.4.3',
          },
        },
        'node_modules/@livekit/agents': {
          version: '1.6.4', dependencies: { '@livekit/local-inference': '0.2.7' },
        },
        'node_modules/@livekit/local-inference': {
          version: '0.2.7',
          optionalDependencies: { '@livekit/local-inference-darwin-arm64': '0.2.7' },
        },
        'node_modules/@livekit/local-inference-darwin-arm64': {
          version: '0.2.7', os: ['darwin'], cpu: ['arm64'],
        },
        'node_modules/@livekit/rtc-node': {
          version: '0.13.33', dependencies: { '@livekit/rtc-ffi-bindings': '0.13.33' },
        },
        'node_modules/@livekit/rtc-ffi-bindings': {
          version: '0.13.33',
          optionalDependencies: { '@livekit/rtc-ffi-bindings-darwin-arm64': '0.13.33' },
        },
        'node_modules/@livekit/rtc-ffi-bindings-darwin-arm64': {
          version: '0.13.33', os: ['darwin'], cpu: ['arm64'],
        },
        'node_modules/undici': { version: '7.29.0' },
        'node_modules/ws': { version: '8.21.3' },
        'node_modules/zod': { version: '4.4.3' },
      },
    }
    await writeFile(lockPath, JSON.stringify(lock), 'utf8')
    const closure = await deriveLockedProductionClosure({ lockPath, targetId: 'darwin-arm64' })
    const dependencyReport = await packageInspection.buildDependencyReport(source, closure)
    await mkdir(resolve(source, 'build/release'), { recursive: true })
    await writeFile(
      resolve(source, 'build/release/production-dependencies-v1.json'),
      JSON.stringify(dependencyReport),
      'utf8',
    )
    await mkdir(resources, { recursive: true })
    await createPackageWithOptions(source, resolve(resources, 'app.asar'), {
      unpack: '**/*.node',
    })
    const external = new Map([
      ['native/project-native/nova_project_native.node', fakeMach('node_addon')],
      ['native/codex-sandbox-probe', fakeMach('executable')],
      ['native/macos_voice_io', fakeMach('executable')],
      ['endpointing/volcengine-v1/MANIFEST.json', Buffer.from('manifest')],
      ['endpointing/volcengine-v1/LICENSE.silero-vad.txt', Buffer.from('license')],
      ['endpointing/volcengine-v1/silence-16k-s16le.pcm', Buffer.from('silence')],
      ['endpointing/volcengine-v1/speech-16k-s16le.pcm', Buffer.from('speech')],
    ])
    for (const [path, body] of external) {
      const destination = resolve(resources, path)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, body)
      if (path === 'native/codex-sandbox-probe' || path === 'native/macos_voice_io') {
        await chmod(destination, 0o755)
      }
    }
    const nativeManifest = await generateNativeResourceManifest({
      resourcesRoot: resources,
      targetId: 'darwin-arm64',
      dependencyReport,
    })
    await writeFile(
      resolve(resources, 'native-resources-v1.json'),
      JSON.stringify(nativeManifest),
      'utf8',
    )
    const report = await packageInspection.inspectBuiltArtifact(application, {
      targetId: 'darwin-arm64',
      format: 'app',
      lockPath,
    })
    assert.match(report.artifact_sha256, /^[0-9a-f]{64}$/u)
    assert.equal(report.native_resource_count, 9)

    await writeFile(resolve(resources, 'native/codex-sandbox-probe'), fakeMach('executable'))
    await writeFile(resolve(resources, 'native/codex-sandbox-probe'), Buffer.concat([
      fakeMach('executable'), Buffer.from('changed'),
    ]))
    await assert.rejects(
      packageInspection.inspectBuiltArtifact(application, {
        targetId: 'darwin-arm64', format: 'app', lockPath,
      }),
      PackageInspectionError,
      'external bytes cannot be swapped behind an old manifest',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('dependency report binds exact files while final native bytes belong only to the native manifest', async () => {
  assert.equal(typeof packageInspection.buildDependencyReport, 'function')
  assert.equal(typeof packageInspection.assertArtifactDependencyReport, 'function')
  const root = await mkdtemp(resolve(tmpdir(), 'nova-package-dependencies-'))
  const repository = resolve(root, 'repository')
  const artifact = resolve(root, 'artifact')
  const closure = {
    schema_version: 1,
    target: 'darwin-arm64',
    packages: [
      {
        name: 'alpha', version: '1.0.0', installKey: 'node_modules/alpha',
        content_sha256: 'a'.repeat(64),
      },
      {
        name: 'beta', version: '2.0.0', installKey: 'node_modules/alpha/node_modules/beta',
        content_sha256: 'b'.repeat(64),
      },
    ],
  }
  const sourceFiles = new Map([
    ['node_modules/alpha/package.json', '{"name":"alpha","version":"1.0.0"}\n'],
    ['node_modules/alpha/index.js', 'export const alpha = true\n'],
    ['node_modules/alpha/src/runtime.js', 'export const requiredAtRuntime = true\n'],
    ['node_modules/alpha/native.node', 'unsigned native bytes'],
    ['node_modules/alpha/node_modules/beta/package.json', '{"name":"beta","version":"2.0.0"}\n'],
    ['node_modules/alpha/node_modules/beta/index.js', 'export const beta = true\n'],
  ])
  try {
    for (const [path, body] of sourceFiles) {
      for (const destinationRoot of [repository, artifact]) {
        const destination = resolve(destinationRoot, path)
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, body, 'utf8')
      }
    }
    const report = await packageInspection.buildDependencyReport(repository, closure)
    assert.deepEqual(report.packages.map(value => value.install_key), [
      'node_modules/alpha',
      'node_modules/alpha/node_modules/beta',
    ])
    assert.ok(report.packages.every(value => value.files.every(file => (
      file.path.endsWith('.node')
        ? Object.keys(file).sort().join(',') === 'integrity_owner,path'
          && file.integrity_owner === 'native_manifest'
        : /^[0-9a-f]{64}$/u.test(file.sha256) && file.byte_size > 0
    ))))
    assert.ok(
      report.packages[0].files.some(file => file.path === 'src/runtime.js'),
      'runtime JavaScript under a dependency src directory is part of the exact closure',
    )
    await mkdir(resolve(artifact, 'build/release'), { recursive: true })
    await writeFile(
      resolve(artifact, 'build/release/production-dependencies-v1.json'),
      JSON.stringify(report),
      'utf8',
    )
    await assert.doesNotReject(
      packageInspection.assertArtifactDependencyReport(artifact, closure),
    )

    await writeFile(resolve(artifact, 'node_modules/alpha/index.js'), 'changed bytes\n', 'utf8')
    await assert.rejects(
      packageInspection.assertArtifactDependencyReport(artifact, closure),
      PackageInspectionError,
      'same manifest identity with changed bytes must fail',
    )
    await writeFile(resolve(artifact, 'node_modules/alpha/index.js'), sourceFiles.get(
      'node_modules/alpha/index.js',
    ), 'utf8')
    await writeFile(
      resolve(artifact, 'node_modules/alpha/native.node'),
      'signed native bytes are intentionally different',
      'utf8',
    )
    await assert.doesNotReject(
      packageInspection.assertArtifactDependencyReport(artifact, closure),
      'dependency inventory delegates signing-mutated native bytes to native-resources-v1.json',
    )
    await rm(resolve(artifact, 'node_modules/alpha/native.node'))
    await assert.rejects(
      packageInspection.assertArtifactDependencyReport(artifact, closure),
      PackageInspectionError,
      'delegating native bytes does not permit a missing native inventory entry',
    )
    await writeFile(
      resolve(artifact, 'node_modules/alpha/native.node'),
      sourceFiles.get('node_modules/alpha/native.node'),
      'utf8',
    )
    await writeFile(resolve(artifact, 'node_modules/alpha/extra.js'), 'extra\n', 'utf8')
    await assert.rejects(
      packageInspection.assertArtifactDependencyReport(artifact, closure),
      PackageInspectionError,
      'an extra file at a selected install key must fail',
    )
    await rm(resolve(artifact, 'node_modules/alpha/extra.js'))
    await mkdir(resolve(artifact, 'node_modules/shadow'), { recursive: true })
    await writeFile(
      resolve(artifact, 'node_modules/shadow/package.json'),
      '{"name":"alpha","version":"1.0.0"}\n',
      'utf8',
    )
    await assert.rejects(
      packageInspection.assertArtifactDependencyReport(artifact, closure),
      PackageInspectionError,
      'the same name/version at an unselected install key must fail',
    )

    if (process.platform !== 'win32') {
      await mkdir(resolve(repository, 'node_modules/alias-parent/node_modules'), { recursive: true })
      await symlink(
        resolve(repository, 'node_modules/alpha'),
        resolve(repository, 'node_modules/alias-parent/node_modules/alpha'),
      )
      await assert.rejects(
        packageInspection.buildDependencyReport(repository, {
          ...closure,
          packages: [...closure.packages, {
            ...closure.packages[0],
            installKey: 'node_modules/alias-parent/node_modules/alpha',
          }],
        }),
        PackageInspectionError,
        'two install keys resolving to one real package must fail',
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
