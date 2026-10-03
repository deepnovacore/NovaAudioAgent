import assert from 'node:assert/strict'
import {readdir, readFile} from 'node:fs/promises'
import {join, relative} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'
import {
  placeholderEndpointingCapability,
  scanLiveKitPublicSurface,
} from '../src/realtime/volcengine/endpointing-capability.js'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

async function readProductionSources(directory: string): Promise<{
  readonly path: string
  readonly source: string
}[]> {
  const entries = await readdir(directory, {withFileTypes: true})
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  const sources: {readonly path: string; readonly source: string}[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      sources.push(...await readProductionSources(path))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      sources.push({
        path: relative(REPOSITORY_ROOT, path),
        source: await readFile(path, 'utf8'),
      })
    }
  }
  return sources
}

async function readProjectPackageManifests(): Promise<{
  readonly path: string
  readonly manifest: unknown
}[]> {
  const rootPath = join(REPOSITORY_ROOT, 'package.json')
  const rootManifest = JSON.parse(await readFile(rootPath, 'utf8')) as {
    readonly workspaces?: readonly string[]
  }
  const workspaces = rootManifest.workspaces
  assert.ok(workspaces)
  assert.equal(workspaces.every(workspace => typeof workspace === 'string'), true)
  const manifestPaths = [
    'package.json',
    ...workspaces.map(workspace => join(workspace, 'package.json')),
  ]
  return Promise.all(manifestPaths.map(async path => ({
    path,
    manifest: JSON.parse(await readFile(join(REPOSITORY_ROOT, path), 'utf8')) as unknown,
  })))
}

test('placeholder capability is an immutable inconclusive bounded-silence result', () => {
  let loaderCalls = 0
  const result = placeholderEndpointingCapability({
    agentsLoader: () => {
      loaderCalls += 1
      return Promise.reject(new Error('placeholder must not load LiveKit agents'))
    },
  })

  assert.deepEqual(result, {
    schema_version: 1,
    mode: 'bounded_silence',
    eot: {available: false, reason: 'inconclusive'},
    vad: {available: false, reason: 'inconclusive'},
    platform: process.platform,
    arch: process.arch,
  })
  assert.equal(loaderCalls, 0)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.eot), true)
  assert.equal(Object.isFrozen(result.vad), true)
})

test('public LiveKit root imports and exact dependency pins are accepted', () => {
  const violations = scanLiveKitPublicSurface({
    productionSources: [{
      path: 'allowed.ts',
      source: [
        "import type {ipc} from '@livekit/agents'",
        "export*from'@livekit/agents'",
        "const loadAgents = () => import('@livekit/agents')",
        "const agents = require('@livekit/agents')",
        'const rootLiteral = `@livekit/agents`',
      ].join('\n'),
    }],
    packageManifests: [{
      path: 'runtime/package.json',
      manifest: {
        dependencies: {
          '@livekit/agents': '1.6.4',
          '@livekit/rtc-node': '0.13.33',
        },
      },
    }],
  })

  assert.deepEqual(violations, [])
})

test('private LiveKit inventory is rejected with stable violations', () => {
  const violations = scanLiveKitPublicSurface({
    productionSources: [
      {
        path: 'private-imports.ts',
        source: [
          "import {hidden} from '@livekit/agents/dist/internal.js'",
          "import localInference from '@livekit/local-inference'",
          "const rtc = import('@livekit/rtc-node')",
        ].join('\n'),
      },
      {
        path: 'copied-runner.ts',
        source: [
          'const executorName = \'InferenceProcExecutor\'',
          'const warmupMethod = \'_warmup\'',
          'const runnerModule = \'inference_proc\'',
        ].join('\n'),
      },
    ],
    packageManifests: [{
      path: 'bad-package.json',
      manifest: {
        dependencies: {
          '@livekit/local-inference': '1.0.0',
          '@livekit/agents': '^1.6.4',
          '@livekit/rtc-node': 'latest',
        },
      },
    }],
  })

  assert.deepEqual(violations, [
    {
      code: 'forbidden_import',
      path: 'private-imports.ts',
      value: '@livekit/agents/dist/internal.js',
    },
    {
      code: 'forbidden_import',
      path: 'private-imports.ts',
      value: '@livekit/local-inference',
    },
    {
      code: 'forbidden_import',
      path: 'private-imports.ts',
      value: '@livekit/rtc-node',
    },
    {
      code: 'forbidden_source_api',
      path: 'copied-runner.ts',
      value: 'InferenceProcExecutor',
    },
    {
      code: 'forbidden_source_api',
      path: 'copied-runner.ts',
      value: '_warmup',
    },
    {
      code: 'forbidden_source_api',
      path: 'copied-runner.ts',
      value: 'inference_proc',
    },
    {
      code: 'forbidden_dependency',
      path: 'bad-package.json',
      value: '@livekit/local-inference',
    },
    {
      code: 'unsupported_dependency_version',
      path: 'bad-package.json',
      value: '@livekit/agents@^1.6.4',
    },
    {
      code: 'unsupported_dependency_version',
      path: 'bad-package.json',
      value: '@livekit/rtc-node@latest',
    },
  ])
})

test('literal LiveKit module references cannot bypass policy through syntax or spacing', () => {
  const references = [
    {
      path: 'compact-import.ts',
      source: "import{hidden}from'@livekit/agents/dist/internal.js'",
    },
    {
      path: 'compact-export.ts',
      source: "export{hidden}from'@livekit/agents/dist/internal.js'",
    },
    {
      path: 'import-equals.ts',
      source: "import hidden = require('@livekit/agents/dist/internal.js')",
    },
    {
      path: 'commonjs-require.ts',
      source: "const hidden=require('@livekit/agents/dist/internal.js')",
    },
    {
      path: 'comment-gap-import.ts',
      source: 'import{hidden}from/*gap*/"@livekit/agents/dist/internal.js"',
    },
    {
      path: 'comment-gap-require.ts',
      source: 'const hidden=require/*gap*/("@livekit/agents/dist/internal.js")',
    },
    {
      path: 'backtick-import.ts',
      source: 'const hidden=import(`@livekit/agents/dist/internal.js`)',
    },
    {
      path: 'backtick-require.ts',
      source: 'const hidden=require(`@livekit/agents/dist/internal.js`)',
    },
  ]

  assert.deepEqual(scanLiveKitPublicSurface({
    productionSources: references,
    packageManifests: [],
  }), references.map(reference => ({
    code: 'forbidden_import',
    path: reference.path,
    value: '@livekit/agents/dist/internal.js',
  })))
})

test('repository production sources and workspace manifests obey the public boundary', async () => {
  const packageManifests = await readProjectPackageManifests()
  const violations = scanLiveKitPublicSurface({
    productionSources: await readProductionSources(join(REPOSITORY_ROOT, 'runtime', 'src')),
    packageManifests,
  })
  assert.deepEqual(violations, [])

  const runtimeEntry = packageManifests.find(
    entry => entry.path.replaceAll('\\', '/') === 'runtime/package.json',
  )
  assert.ok(runtimeEntry)
  const runtimeManifest = runtimeEntry.manifest as {
    readonly dependencies?: Readonly<Record<string, unknown>>
  }
  assert.equal(runtimeManifest.dependencies?.['@livekit/agents'], '1.6.4')
  assert.equal(runtimeManifest.dependencies?.['@livekit/rtc-node'], '0.13.33')
})


test('standalone local EOT permits only its owner import and exact runtime native pin', () => {
  const source = "import type * as LocalInference from '@livekit/local-inference'"
  for (const path of ['runtime/src/realtime/volcengine/local-eot-executor.ts', 'runtime\\src\\realtime\\volcengine\\local-eot-executor.ts']) {
    assert.deepEqual(scanLiveKitPublicSurface({productionSources: [{path, source}], packageManifests: [
      {path: 'runtime/package.json', manifest: {dependencies: {'@livekit/local-inference': '0.2.7'}}},
    ]}), [])
  }
  assert.equal(scanLiveKitPublicSurface({productionSources: [{path: 'elsewhere.ts', source}], packageManifests: []}).length, 1)
  assert.equal(scanLiveKitPublicSurface({productionSources: [], packageManifests: [
    {path: 'runtime/package.json', manifest: {dependencies: {'@livekit/local-inference': '^0.2.7'}}},
  ]}).length, 1)
})

test('standalone EOT permits only its isolated public inference adapter and exact runtime pin', () => {
  const path = 'runtime/src/realtime/volcengine/local-eot-executor.ts'
  const source = "const load = () => import('@livekit/local-inference')"
  const inventory = {productionSources: [{path, source}], packageManifests: [{path: 'runtime/package.json',
    manifest: {dependencies: {'@livekit/local-inference': '0.2.7'}}}]}
  assert.deepEqual(scanLiveKitPublicSurface(inventory), [])
  assert.deepEqual(scanLiveKitPublicSurface({
    productionSources: inventory.productionSources.map(entry => ({...entry, path: entry.path.replaceAll('/', '\\')})),
    packageManifests: inventory.packageManifests.map(entry => ({...entry, path: entry.path.replaceAll('/', '\\')})),
  }), [])
  assert.equal(scanLiveKitPublicSurface({...inventory, productionSources: [{path: 'other.ts', source}]}).length, 1)
  assert.equal(scanLiveKitPublicSurface({...inventory, productionSources: [{path, source: source.replace('local-inference', 'local-inference/private')}]}).length, 1)
  for (const version of ['^0.2.7', '0.2.8']) {
    assert.equal(scanLiveKitPublicSurface({productionSources: [], packageManifests: [{path: 'runtime/package.json',
      manifest: {dependencies: {'@livekit/local-inference': version}}}]}).length, 1)
  }
})
