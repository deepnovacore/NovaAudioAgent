import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RELEASE_GATE_IDS,
  verifyCandidateLedger,
  verifyCandidateLedgerForTest,
} from '../scripts/verify-release-evidence.mjs'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const NOW = Date.parse('2026-08-22T00:00:00.000Z')

function artifact() {
  return { target: 'darwin-arm64:app', sha256: SHA_A }
}

const ARTIFACT_TARGETS = [
  'darwin-arm64:app', 'darwin-arm64:dmg',
  'darwin-x64:app', 'darwin-x64:dmg',
  'win32-x64:nsis',
  'linux-x64-gnu:appimage', 'linux-x64-gnu:deb',
]

function artifactMatrix() {
  return ARTIFACT_TARGETS.map(target => ({ target, sha256: SHA_A }))
}

function evidence(gateId, overrides = {}) {
  const evidenceClass = gateId === 'repository_full'
    ? 'deterministic'
    : ['package_inventory', 'native_load', 'installer_smoke', 'descendant_cleanup'].includes(gateId)
      ? 'platform_ci'
      : ['signing', 'release_authority'].includes(gateId)
        ? 'release_authority'
        : 'operator_external'
  const identityPrefix = evidenceClass === 'operator_external'
    ? 'operator:protected-runner'
    : evidenceClass === 'release_authority'
      ? 'authority:release-owner'
      : 'github:openai/nova-audio-agent:release.yml'
  const runIdentity = evidenceClass === 'operator_external'
    ? 'operator:run-123456789'
    : evidenceClass === 'release_authority'
      ? 'authority:run-123456789'
      : 'github:123456789'
  return {
    schema_version: 1,
    gate_id: gateId,
    evidence_class: evidenceClass,
    target: 'darwin-arm64:app',
    artifact_sha256: SHA_A,
    producer_identity: identityPrefix,
    run_identity: runIdentity,
    started_at: '2026-08-21T22:00:00.000Z',
    finished_at: '2026-08-21T22:30:00.000Z',
    result_code: 'passed',
    evidence_sha256: SHA_B,
    attestation_identity: 'sigstore:github-actions',
    ...overrides,
  }
}

test('missing external evidence stays pending and cannot become a release claim', () => {
  const result = verifyCandidateLedger({
    schema_version: 1,
    release_version: '0.1.0-rc.1',
    commit: '1'.repeat(40),
    artifacts: artifactMatrix(),
    evidence: [],
  }, { now: NOW })
  assert.equal(result.status, 'pending')
  assert.deepEqual(result.passed_gate_ids, [])
  assert.deepEqual(result.pending_gate_ids, [...RELEASE_GATE_IDS].sort())
})

test('a candidate ledger requires the exact closed artifact matrix', () => {
  assert.throws(
    () => verifyCandidateLedger({
      schema_version: 1,
      release_version: '0.1.0-rc.1',
      commit: '1'.repeat(40),
      artifacts: [artifact()],
      evidence: [],
    }, { now: NOW }),
    error => error.code === 'artifact_matrix_invalid',
  )
})

test('test trust can prove schema mechanics but production rejects the same unsigned ledger', () => {
  const records = ARTIFACT_TARGETS.flatMap(target => RELEASE_GATE_IDS.map(gateId => evidence(gateId, {
    target,
  })))
  const ledger = {
    schema_version: 1,
    release_version: '0.1.0-rc.1',
    commit: '1'.repeat(40),
    artifacts: artifactMatrix(),
    evidence: records,
  }
  const trusted = verifyCandidateLedgerForTest(ledger, {
    now: NOW,
    verifyAttestation: () => true,
  })
  assert.equal(trusted.status, 'passed')
  assert.deepEqual(trusted.pending_gate_ids, [])

  const production = verifyCandidateLedger(ledger, { now: NOW })
  assert.equal(production.status, 'failed')
  assert.equal(production.result_code, 'untrusted_evidence')
})

test('cross-artifact and free-form evidence fail closed without leaking supplied text', () => {
  const base = {
    schema_version: 1,
    release_version: '0.1.0-rc.1',
    commit: '1'.repeat(40),
    artifacts: artifactMatrix(),
    evidence: [evidence('repository_full', { artifact_sha256: SHA_B })],
  }
  assert.throws(
    () => verifyCandidateLedgerForTest(base, { now: NOW, verifyAttestation: () => true }),
    error => {
      assert.equal(error.code, 'evidence_artifact_mismatch')
      assert.doesNotMatch(error.message, /aaaa|bbbb|github/u)
      return true
    },
  )
  assert.throws(
    () => verifyCandidateLedgerForTest({
      ...base,
      evidence: [{ ...evidence('repository_full'), note: 'private-path-sentinel' }],
    }, { now: NOW, verifyAttestation: () => true }),
    error => {
      assert.equal(error.code, 'evidence_invalid')
      assert.doesNotMatch(error.message, /private-path-sentinel/u)
      return true
    },
  )
})
