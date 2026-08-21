import type * as LiveKitAgents from '@livekit/agents'

export type EndpointingCapabilityReason =
  | 'ready'
  | 'unsupported_platform'
  | 'package_unavailable'
  | 'native_unavailable'
  | 'executor_unavailable'
  | 'model_unavailable'
  | 'timeout'
  | 'inconclusive'
  | 'aborted'

export interface EndpointingCapabilityResult {
  readonly schema_version: 1
  readonly mode: 'livekit_v1_mini' | 'bounded_silence'
  readonly eot: {
    readonly available: boolean
    readonly reason: EndpointingCapabilityReason
  }
  readonly vad: {
    readonly available: boolean
    readonly reason: EndpointingCapabilityReason
  }
  readonly platform: string
  readonly arch: string
}

export type LiveKitAgentsPublicSurface = typeof LiveKitAgents
export type LiveKitExecutor = LiveKitAgents.ipc.InferenceExecutor
export type LiveKitAgentsLoader = () => Promise<LiveKitAgentsPublicSurface>

export interface PlaceholderEndpointingCapabilityOptions {
  readonly agentsLoader: LiveKitAgentsLoader
}

export interface LiveKitProductionSource {
  readonly path: string
  readonly source: string
}

export interface LiveKitPackageManifest {
  readonly path: string
  readonly manifest: unknown
}

export interface LiveKitPolicyInventory {
  readonly productionSources: readonly LiveKitProductionSource[]
  readonly packageManifests: readonly LiveKitPackageManifest[]
}

export type LiveKitPolicyViolationCode =
  | 'forbidden_import'
  | 'forbidden_source_api'
  | 'forbidden_dependency'
  | 'unsupported_dependency_version'

export interface LiveKitPolicyViolation {
  readonly code: LiveKitPolicyViolationCode
  readonly path: string
  readonly value: string
}

const LIVEKIT_AGENTS_ROOT = '@livekit/agents'
const LIVEKIT_LOCAL_INFERENCE = '@livekit/' + 'local-inference'
const LIVEKIT_DEPENDENCY_VERSIONS = Object.freeze({
  '@livekit/agents': '1.6.4',
  '@livekit/rtc-node': '0.13.33',
})
const DEPENDENCY_SECTIONS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const)
const FORBIDDEN_SOURCE_APIS = Object.freeze([
  'Inference' + 'ProcExecutor',
  '_' + 'warmup',
  'inference' + '_' + 'proc',
])
const STATIC_LIVEKIT_IMPORT =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"](@livekit\/[^'"]+)['"]/gu
const DYNAMIC_LIVEKIT_IMPORT =
  /\bimport\s*\(\s*['"](@livekit\/[^'"]+)['"]\s*\)/gu

export function placeholderEndpointingCapability(
  options: PlaceholderEndpointingCapabilityOptions,
): EndpointingCapabilityResult {
  void options.agentsLoader
  const unavailable = Object.freeze({available: false, reason: 'inconclusive' as const})
  return Object.freeze({
    schema_version: 1,
    mode: 'bounded_silence',
    eot: unavailable,
    vad: unavailable,
    platform: process.platform,
    arch: process.arch,
  })
}

export function scanLiveKitPublicSurface(
  inventory: LiveKitPolicyInventory,
): readonly LiveKitPolicyViolation[] {
  const violations: LiveKitPolicyViolation[] = []

  for (const source of inventory.productionSources) {
    for (const specifier of liveKitImportSpecifiers(source.source)) {
      if (specifier !== LIVEKIT_AGENTS_ROOT) {
        violations.push(Object.freeze({
          code: 'forbidden_import',
          path: source.path,
          value: specifier,
        }))
      }
    }
    for (const blockedApi of FORBIDDEN_SOURCE_APIS) {
      if (source.source.includes(blockedApi)) {
        violations.push(Object.freeze({
          code: 'forbidden_source_api',
          path: source.path,
          value: blockedApi,
        }))
      }
    }
  }

  for (const manifestEntry of inventory.packageManifests) {
    const manifest = asStringRecord(manifestEntry.manifest)
    if (manifest === null) continue
    for (const section of DEPENDENCY_SECTIONS) {
      const dependencies = asStringRecord(manifest[section])
      if (dependencies === null) continue
      if (Object.hasOwn(dependencies, LIVEKIT_LOCAL_INFERENCE)) {
        violations.push(Object.freeze({
          code: 'forbidden_dependency',
          path: manifestEntry.path,
          value: LIVEKIT_LOCAL_INFERENCE,
        }))
      }
      for (const [dependency, expectedVersion] of Object.entries(LIVEKIT_DEPENDENCY_VERSIONS)) {
        if (!Object.hasOwn(dependencies, dependency)) continue
        const actualVersion = dependencies[dependency]
        if (actualVersion !== expectedVersion) {
          violations.push(Object.freeze({
            code: 'unsupported_dependency_version',
            path: manifestEntry.path,
            value: `${dependency}@${String(actualVersion)}`,
          }))
        }
      }
    }
  }

  return Object.freeze(violations)
}

function liveKitImportSpecifiers(source: string): readonly string[] {
  const matches: {readonly index: number; readonly specifier: string}[] = []
  for (const match of source.matchAll(STATIC_LIVEKIT_IMPORT)) {
    const specifier = match[1]
    if (specifier !== undefined) matches.push({index: match.index, specifier})
  }
  for (const match of source.matchAll(DYNAMIC_LIVEKIT_IMPORT)) {
    const specifier = match[1]
    if (specifier !== undefined) matches.push({index: match.index, specifier})
  }
  matches.sort((left, right) => left.index - right.index)
  return Object.freeze(matches.map(match => match.specifier))
}

function asStringRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
