import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseStrictJson } from './strict-json.mjs'

export const RELEASE_GATE_IDS = Object.freeze([
  'repository_full',
  'package_inventory',
  'native_load',
  'installer_smoke',
  'qwen_live',
  'volcengine_live',
  'livekit_capability',
  'codex_live',
  'descendant_cleanup',
  'audio_hardware',
  'camera_hardware',
  'signing',
  'release_authority',
])

const EVIDENCE_CLASSES = Object.freeze({
  repository_full: 'deterministic',
  package_inventory: 'platform_ci',
  native_load: 'platform_ci',
  installer_smoke: 'platform_ci',
  qwen_live: 'operator_external',
  volcengine_live: 'operator_external',
  livekit_capability: 'operator_external',
  codex_live: 'operator_external',
  descendant_cleanup: 'platform_ci',
  audio_hardware: 'operator_external',
  camera_hardware: 'operator_external',
  signing: 'release_authority',
  release_authority: 'release_authority',
})

const ARTIFACT_TARGETS = new Set([
  'darwin-arm64:app', 'darwin-arm64:dmg',
  'win32-x64:portable', 'win32-x64:nsis',
])
const RECORD_KEYS = Object.freeze([
  'schema_version', 'gate_id', 'evidence_class', 'target', 'artifact_sha256',
  'producer_identity', 'run_identity', 'started_at', 'finished_at', 'result_code',
  'evidence_sha256', 'attestation_identity',
])
const MAX_EVIDENCE_AGE_MS = 30 * 24 * 60 * 60 * 1000

export class ReleaseEvidenceError extends Error {
  constructor(code) {
    super(`release evidence rejected: ${code}`)
    this.name = 'ReleaseEvidenceError'
    this.code = code
  }
}

function plain(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function hasExactKeys(value, keys) {
  return plain(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function sha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function safeIdentity(value, prefix) {
  return typeof value === 'string'
    && value.length >= 3
    && value.length <= 160
    && value.startsWith(prefix)
    && /^[a-z0-9:._/@-]+$/u.test(value)
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function frozenResult(status, resultCode, passed, pending, failed = []) {
  return Object.freeze({
    status,
    result_code: resultCode,
    passed_gate_ids: Object.freeze([...passed].sort()),
    pending_gate_ids: Object.freeze([...pending].sort()),
    failed_gate_ids: Object.freeze([...failed].sort()),
  })
}

function validatedCandidateLedger(ledger, now) {
  if (!hasExactKeys(ledger, [
    'schema_version', 'release_version', 'commit', 'artifacts', 'evidence',
  ])) throw new ReleaseEvidenceError('ledger_invalid')
  if (
    ledger.schema_version !== 1
    || typeof ledger.release_version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u.test(ledger.release_version)
    || typeof ledger.commit !== 'string'
    || !/^[0-9a-f]{40}$/u.test(ledger.commit)
    || !Array.isArray(ledger.artifacts)
    || ledger.artifacts.length === 0
    || !Array.isArray(ledger.evidence)
  ) throw new ReleaseEvidenceError('ledger_invalid')

  const artifacts = new Map()
  for (const artifact of ledger.artifacts) {
    if (
      !hasExactKeys(artifact, ['target', 'sha256'])
      || !ARTIFACT_TARGETS.has(artifact.target)
      || !sha256(artifact.sha256)
      || artifacts.has(artifact.target)
    ) throw new ReleaseEvidenceError('artifact_invalid')
    artifacts.set(artifact.target, artifact.sha256)
  }
  if (
    artifacts.size !== ARTIFACT_TARGETS.size
    || [...ARTIFACT_TARGETS].some(target => !artifacts.has(target))
  ) throw new ReleaseEvidenceError('artifact_matrix_invalid')

  const records = new Map()
  for (const record of ledger.evidence) {
    if (!hasExactKeys(record, RECORD_KEYS)) throw new ReleaseEvidenceError('evidence_invalid')
    const started = timestamp(record.started_at)
    const finished = timestamp(record.finished_at)
    if (
      record.schema_version !== 1
      || !RELEASE_GATE_IDS.includes(record.gate_id)
      || record.evidence_class !== EVIDENCE_CLASSES[record.gate_id]
      || !ARTIFACT_TARGETS.has(record.target)
      || !artifacts.has(record.target)
      || !sha256(record.artifact_sha256)
      || !safeIdentity(record.producer_identity, record.evidence_class === 'operator_external'
        ? 'operator:'
        : record.evidence_class === 'release_authority' ? 'authority:' : 'github:')
      || !safeIdentity(record.run_identity, record.evidence_class === 'operator_external'
        ? 'operator:'
        : record.evidence_class === 'release_authority' ? 'authority:' : 'github:')
      || !['passed', 'pending', 'failed'].includes(record.result_code)
      || !sha256(record.evidence_sha256)
      || !safeIdentity(record.attestation_identity, 'sigstore:')
      || started === null
      || finished === null
      || started > finished
      || finished > now + 5 * 60 * 1000
      || now - finished > MAX_EVIDENCE_AGE_MS
    ) throw new ReleaseEvidenceError('evidence_invalid')
    if (record.artifact_sha256 !== artifacts.get(record.target)) {
      throw new ReleaseEvidenceError('evidence_artifact_mismatch')
    }
    const key = `${record.target}\0${record.gate_id}`
    if (records.has(key)) throw new ReleaseEvidenceError('evidence_duplicate')
    records.set(key, record)
  }

  return {artifacts, records}
}

export function validateCandidateLedgerStructure(ledger, {now = Date.now()} = {}) {
  const {artifacts, records} = validatedCandidateLedger(ledger, now)
  return Object.freeze({artifact_count: artifacts.size, evidence_count: records.size})
}

function evaluateCandidateLedger(ledger, {now, verifyAttestation, trustEvidence}) {
  const {artifacts, records} = validatedCandidateLedger(ledger, now)

  const passed = new Set()
  const pending = new Set()
  const failed = new Set()
  let untrusted = false
  for (const target of artifacts.keys()) {
    for (const gateId of RELEASE_GATE_IDS) {
      const record = records.get(`${target}\0${gateId}`)
      if (!record || record.result_code === 'pending') {
        pending.add(gateId)
        continue
      }
      if (record.result_code === 'failed') {
        failed.add(gateId)
        continue
      }
      const trusted = trustEvidence === true
        && typeof verifyAttestation === 'function'
        && verifyAttestation(Object.freeze({ ...record })) === true
      if (!trusted) {
        untrusted = true
        failed.add(gateId)
        continue
      }
      passed.add(gateId)
    }
  }
  if (untrusted) return frozenResult('failed', 'untrusted_evidence', passed, pending, failed)
  if (failed.size > 0) return frozenResult('failed', 'gate_failed', passed, pending, failed)
  if (pending.size > 0) return frozenResult('pending', 'evidence_pending', passed, pending)
  return frozenResult('passed', 'passed', passed, [])
}

export function verifyCandidateLedger(ledger, {now = Date.now()} = {}) {
  return evaluateCandidateLedger(ledger, {
    now,
    verifyAttestation: undefined,
    trustEvidence: false,
  })
}

/** Schema-mechanics seam; release commands use GitHub/OIDC verification instead. */
export function verifyCandidateLedgerForTest(ledger, {
  now = Date.now(),
  verifyAttestation,
} = {}) {
  return evaluateCandidateLedger(ledger, {now, verifyAttestation, trustEvidence: true})
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  const ledgerPath = process.argv.length === 4 && process.argv[2] === '--ledger'
    ? process.argv[3]
    : null
  const run = ledgerPath === null
    ? Promise.reject(new ReleaseEvidenceError('usage_invalid'))
    : readFile(ledgerPath, 'utf8').then(text => verifyCandidateLedger(parseStrictJson(text)))
  run.then(
    result => {
      process.stdout.write(`${JSON.stringify(result)}\n`)
      if (result.status !== 'passed') process.exitCode = 1
    },
    () => {
      process.stderr.write('release evidence rejected\n')
      process.exitCode = 1
    },
  )
}
