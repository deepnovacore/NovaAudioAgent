import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp, mkdir, realpath, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {
  RELEASE_ARTIFACT_FILES,
  evidenceFileName,
  verifyGitHubAttestedCandidate,
} from '../scripts/verify-github-release-attestations.mjs'
import {RELEASE_GATE_IDS} from '../scripts/verify-release-evidence.mjs'

const NOW = Date.parse('2026-08-22T00:00:00.000Z')
const RELEASE_VERSION = '0.1.0-rc.1'
const COMMIT = '1'.repeat(40)

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function evidenceClass(gateId) {
  if (gateId === 'repository_full') return 'deterministic'
  if (['package_inventory', 'native_load', 'installer_smoke', 'descendant_cleanup'].includes(gateId)) {
    return 'platform_ci'
  }
  if (['signing', 'release_authority'].includes(gateId)) return 'release_authority'
  return 'operator_external'
}

function evidenceDocument(record, {
  releaseVersion = RELEASE_VERSION,
  commit = COMMIT,
} = {}) {
  const claim = {...record}
  delete claim.evidence_sha256
  return Buffer.from(`${JSON.stringify({
    schema_version: 1,
    release_version: releaseVersion,
    commit,
    record: claim,
  })}\n`)
}

test('production verification rehashes the closed candidate matrix and invokes fixed GitHub trust', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-release-attestation-'))
  t.after(() => import('node:fs/promises').then(({rm}) => rm(root, {recursive: true, force: true})))
  const artifactRootInput = join(root, 'artifacts')
  const evidenceRootInput = join(root, 'evidence')
  await mkdir(artifactRootInput)
  await mkdir(evidenceRootInput)
  const artifactRoot = await realpath(artifactRootInput)
  const evidenceRoot = await realpath(evidenceRootInput)

  const artifacts = []
  const evidence = []
  for (const [target, filename] of Object.entries(RELEASE_ARTIFACT_FILES)) {
    const bytes = Buffer.from(`artifact:${target}`)
    await writeFile(join(artifactRoot, filename), bytes)
    const artifactSha256 = digest(bytes)
    artifacts.push({target, sha256: artifactSha256})
    for (const gateId of RELEASE_GATE_IDS) {
      const klass = evidenceClass(gateId)
      const claim = {
        schema_version: 1,
        gate_id: gateId,
        evidence_class: klass,
        target,
        artifact_sha256: artifactSha256,
        producer_identity: klass === 'operator_external'
          ? 'operator:protected-runner'
          : klass === 'release_authority'
            ? 'authority:release-owner'
            : 'github:deepnovacore/novaaudioagent:release-candidate.yml',
        run_identity: klass === 'operator_external'
          ? 'operator:run-1234'
          : klass === 'release_authority'
            ? 'authority:run-1234'
            : 'github:1234',
        started_at: '2026-08-21T22:00:00.000Z',
        finished_at: '2026-08-21T22:30:00.000Z',
        result_code: 'passed',
        attestation_identity: 'sigstore:github-actions',
      }
      const proof = evidenceDocument(claim)
      await writeFile(join(evidenceRoot, evidenceFileName(target, gateId)), proof)
      evidence.push({...claim, evidence_sha256: digest(proof)})
    }
  }
  const calls = []
  const result = await verifyGitHubAttestedCandidate({
    ledger: {
      schema_version: 1,
      release_version: RELEASE_VERSION,
      commit: COMMIT,
      artifacts,
      evidence,
    },
    artifactRoot,
    evidenceRoot,
    now: NOW,
  }, {
    runGh: input => {
      calls.push(input)
      return {status: 0, signal: null, error: undefined, stdout: '[]', stderr: ''}
    },
  })

  assert.equal(result.status, 'passed')
  assert.equal(calls.length, Object.keys(RELEASE_ARTIFACT_FILES).length + evidence.length)
  for (const call of calls) {
    assert.equal(call.command, 'gh')
    assert.deepEqual(call.args.slice(0, 2), ['attestation', 'verify'])
    assert.ok(call.args.includes('--repo'))
    assert.ok(call.args.includes('deepnovacore/NovaAudioAgent'))
    assert.ok(call.args.includes('--signer-workflow'))
    assert.ok(call.args.includes('--source-digest'))
    assert.equal(call.args.includes('--owner'), false)
  }
})

test('attested evidence bytes bind every ledger claim plus release and commit identities', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-release-attestation-claims-'))
  t.after(() => import('node:fs/promises').then(({rm}) => rm(root, {recursive: true, force: true})))
  const artifactRootInput = join(root, 'artifacts')
  const evidenceRootInput = join(root, 'evidence')
  await mkdir(artifactRootInput)
  await mkdir(evidenceRootInput)
  const artifactRoot = await realpath(artifactRootInput)
  const evidenceRoot = await realpath(evidenceRootInput)
  const artifacts = []
  for (const [target, filename] of Object.entries(RELEASE_ARTIFACT_FILES)) {
    const bytes = Buffer.from(`artifact:${target}`)
    await writeFile(join(artifactRoot, filename), bytes)
    artifacts.push({target, sha256: digest(bytes)})
  }
  const target = 'darwin-arm64:app'
  const artifactSha256 = artifacts.find(value => value.target === target).sha256
  const claim = {
    schema_version: 1,
    gate_id: 'repository_full',
    evidence_class: 'deterministic',
    target,
    artifact_sha256: artifactSha256,
    producer_identity: 'github:deepnovacore/novaaudioagent:release-candidate.yml',
    run_identity: 'github:1234',
    started_at: '2026-08-21T22:00:00.000Z',
    finished_at: '2026-08-21T22:30:00.000Z',
    result_code: 'passed',
    attestation_identity: 'sigstore:github-actions',
  }
  const proof = evidenceDocument(claim)
  await writeFile(join(evidenceRoot, evidenceFileName(target, claim.gate_id)), proof)
  const evidence = [{...claim, evidence_sha256: digest(proof)}]
  const ledger = {
    schema_version: 1,
    release_version: RELEASE_VERSION,
    commit: COMMIT,
    artifacts,
    evidence,
  }
  const trustedGh = () => ({status: 0, signal: null, error: undefined, stdout: '[]', stderr: ''})

  await assert.rejects(
    verifyGitHubAttestedCandidate({
      ledger: {...ledger, evidence: [{...evidence[0], result_code: 'failed'}]},
      artifactRoot,
      evidenceRoot,
      now: NOW,
    }, {runGh: trustedGh}),
    error => error.code === 'evidence_claim_mismatch',
  )
  await assert.rejects(
    verifyGitHubAttestedCandidate({
      ledger: {...ledger, release_version: '0.1.0-rc.2'},
      artifactRoot,
      evidenceRoot,
      now: NOW,
    }, {runGh: trustedGh}),
    error => error.code === 'evidence_claim_mismatch',
  )
})

test('production verification rejects changed bytes and a failed GitHub attestation safely', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nova-release-attestation-reject-'))
  t.after(() => import('node:fs/promises').then(({rm}) => rm(root, {recursive: true, force: true})))
  const artifactRootInput = join(root, 'artifacts')
  const evidenceRootInput = join(root, 'evidence')
  await mkdir(artifactRootInput)
  await mkdir(evidenceRootInput)
  const artifactRoot = await realpath(artifactRootInput)
  const evidenceRoot = await realpath(evidenceRootInput)
  const artifacts = []
  for (const [target, filename] of Object.entries(RELEASE_ARTIFACT_FILES)) {
    const bytes = Buffer.from(`artifact:${target}`)
    await writeFile(join(artifactRoot, filename), bytes)
    artifacts.push({target, sha256: digest(bytes)})
  }
  const ledger = {
    schema_version: 1,
    release_version: '0.1.0-rc.1',
    commit: '2'.repeat(40),
    artifacts,
    evidence: [],
  }
  await writeFile(join(artifactRoot, RELEASE_ARTIFACT_FILES['darwin-arm64:app']), 'changed')
  await assert.rejects(
    verifyGitHubAttestedCandidate({ledger, artifactRoot, evidenceRoot, now: NOW}, {
      runGh: () => ({status: 0, signal: null, stdout: '[]', stderr: ''}),
    }),
    error => error.code === 'artifact_digest_mismatch' && !error.message.includes(root),
  )

  await writeFile(
    join(artifactRoot, RELEASE_ARTIFACT_FILES['darwin-arm64:app']),
    Buffer.from('artifact:darwin-arm64:app'),
  )
  await assert.rejects(
    verifyGitHubAttestedCandidate({ledger, artifactRoot, evidenceRoot, now: NOW}, {
      runGh: () => ({status: 1, signal: null, stdout: '', stderr: 'private sentinel'}),
    }),
    error => error.code === 'attestation_untrusted'
      && !error.message.includes('private sentinel')
      && !error.message.includes(root),
  )
})
