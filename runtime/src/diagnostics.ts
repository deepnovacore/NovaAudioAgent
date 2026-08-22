import {isAbsolute} from 'node:path'
import {z} from 'zod'

import {
  loadSettings,
  requireCascadedCredentials,
  requireIntegratedRealtime,
  resolveCascadedSelection,
  type Settings,
} from './config.js'
import {findRetiredConfiguration} from './environment-contract.js'
import {stripLikePython} from './python-text.js'

const diagnosticIdSchema = z.enum([
  'node.version',
  'configuration.retirement',
  'configuration.parse',
  'provider.qwen',
  'provider.volcengine',
  'executors.contract',
  'search.credential',
  'camera.source',
])
const diagnosticCodeSchema = z.enum([
  'node_version_supported',
  'node_version_unsupported',
  'active_configuration',
  'retired_capability',
  'retired_configuration',
  'configuration_valid',
  'configuration_invalid',
  'qwen_configuration_valid',
  'qwen_configuration_invalid',
  'volcengine_configuration_valid',
  'volcengine_configuration_invalid',
  'executor_configuration_valid',
  'executor_configuration_invalid',
  'search_credential_present',
  'search_credential_missing',
  'camera_local_selected',
  'camera_file_selected',
  'camera_source_invalid',
  'diagnostic_internal_failure',
])

const diagnosticCheckSchema = z.object({
  id: diagnosticIdSchema,
  status: z.enum(['pass', 'fail', 'unavailable']),
  code: diagnosticCodeSchema,
}).strict()

export const diagnosticReportSchema = z.object({
  schema_version: z.literal(1),
  runtime: z.literal('node'),
  ok: z.boolean(),
  checks: z.array(diagnosticCheckSchema).max(8),
}).strict()

export interface DiagnosticCheck {
  readonly id: z.infer<typeof diagnosticIdSchema>
  readonly status: 'pass' | 'fail' | 'unavailable'
  readonly code: z.infer<typeof diagnosticCodeSchema>
}

export interface DiagnosticReport {
  readonly schema_version: 1
  readonly runtime: 'node'
  readonly ok: boolean
  readonly checks: readonly DiagnosticCheck[]
}

export function buildDiagnosticReport(options: {
  readonly environment: NodeJS.ProcessEnv
  readonly nodeVersion: string
}): Promise<DiagnosticReport> {
  const checks: DiagnosticCheck[] = [nodeVersionCheck(options.nodeVersion)]
  try {
    const retired = findRetiredConfiguration(options.environment)
    if (retired !== null) {
      checks.push(check(
        'configuration.retirement',
        'fail',
        retired.fields.length === 0 ? 'retired_capability' : 'retired_configuration',
      ))
      checks.push(check('configuration.parse', 'fail', 'configuration_invalid'))
      return Promise.resolve(report(checks))
    }
    checks.push(check('configuration.retirement', 'pass', 'active_configuration'))
  } catch {
    checks.push(check('configuration.retirement', 'fail', 'diagnostic_internal_failure'))
    return Promise.resolve(report(checks))
  }

  let settings: Settings
  try {
    settings = loadSettings(options.environment)
    checks.push(check('configuration.parse', 'pass', 'configuration_valid'))
  } catch {
    checks.push(check('configuration.parse', 'fail', 'configuration_invalid'))
    return Promise.resolve(report(checks))
  }

  checks.push(providerCheck(settings))
  checks.push(executorCheck(settings))
  checks.push(searchCheck(settings))
  try {
    checks.push(cameraCheck(options.environment))
  } catch {
    checks.push(check('camera.source', 'fail', 'diagnostic_internal_failure'))
  }
  return Promise.resolve(report(checks))
}

function nodeVersionCheck(version: string): DiagnosticCheck {
  const match = /^v?([0-9]+)\.([0-9]+)\.([0-9]+)$/u.exec(version)
  if (match === null) return check('node.version', 'fail', 'node_version_unsupported')
  const major = Number(match[1])
  const minor = Number(match[2])
  const supported = major > 22 || (major === 22 && minor >= 12)
  return supported
    ? check('node.version', 'pass', 'node_version_supported')
    : check('node.version', 'fail', 'node_version_unsupported')
}

function providerCheck(settings: Settings): DiagnosticCheck {
  if (settings.pipeline_mode === 'integrated') {
    try {
      requireIntegratedRealtime(settings)
      return check('provider.qwen', 'pass', 'qwen_configuration_valid')
    } catch {
      return check('provider.qwen', 'fail', 'qwen_configuration_invalid')
    }
  }
  try {
    const selection = resolveCascadedSelection(settings)
    requireCascadedCredentials(settings, selection)
    return check('provider.volcengine', 'pass', 'volcengine_configuration_valid')
  } catch {
    return check('provider.volcengine', 'fail', 'volcengine_configuration_invalid')
  }
}

function executorCheck(settings: Settings): DiagnosticCheck {
  if (settings.executors.includes('codex')) {
    const workspace = stripLikePython(settings.codex_workspace ?? '')
    if (workspace === '') {
      return check('executors.contract', 'fail', 'executor_configuration_invalid')
    }
  }
  return check('executors.contract', 'pass', 'executor_configuration_valid')
}

function searchCheck(settings: Settings): DiagnosticCheck {
  return stripLikePython(settings.tavily_api_key ?? '') === ''
    ? check('search.credential', 'fail', 'search_credential_missing')
    : check('search.credential', 'pass', 'search_credential_present')
}

function cameraCheck(environment: NodeJS.ProcessEnv): DiagnosticCheck {
  const configured = stripLikePython(environment.NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE ?? '')
  if (configured === '') return check('camera.source', 'pass', 'camera_local_selected')
  return isAbsolute(configured)
    ? check('camera.source', 'pass', 'camera_file_selected')
    : check('camera.source', 'fail', 'camera_source_invalid')
}

function check(
  id: DiagnosticCheck['id'],
  status: DiagnosticCheck['status'],
  code: DiagnosticCheck['code'],
): DiagnosticCheck {
  return Object.freeze({id, status, code})
}

function report(checks: readonly DiagnosticCheck[]): DiagnosticReport {
  return Object.freeze({
    schema_version: 1 as const,
    runtime: 'node' as const,
    ok: checks.every(item => item.status !== 'fail'),
    checks: Object.freeze([...checks]),
  })
}
