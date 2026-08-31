import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {createReadStream, readFileSync} from 'node:fs'
import {lstat, readFile, readdir, realpath} from 'node:fs/promises'
import {isAbsolute, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {parseStrictJson} from './strict-json.mjs'
import {
  RELEASE_GATE_IDS,
  validateCandidateLedgerStructure,
} from './verify-release-evidence.mjs'

const RELEASE_REPOSITORY = 'deepnovacore/NovaAudioAgent'
const BUILD_SIGNER = `${RELEASE_REPOSITORY}/.github/workflows/release-candidate.yml`
const EVIDENCE_SIGNERS = Object.freeze({
  deterministic: BUILD_SIGNER,
  platform_ci: BUILD_SIGNER,
  operator_external: `${RELEASE_REPOSITORY}/.github/workflows/release-external-evidence.yml`,
  release_authority: `${RELEASE_REPOSITORY}/.github/workflows/release-authority.yml`,
})
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024
const MAX_EVIDENCE_BYTES = 1024 * 1024
const GH_TIMEOUT_MS = 120_000
const GH_OUTPUT_BYTES = 1024 * 1024
const EVIDENCE_CLAIM_KEYS = Object.freeze([
  'schema_version', 'gate_id', 'evidence_class', 'target', 'artifact_sha256',
  'producer_identity', 'run_identity', 'started_at', 'finished_at', 'result_code',
  'attestation_identity',
])

const releasePackage = parseStrictJson(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
export const RELEASE_VERSION = releasePackage.version
if (typeof RELEASE_VERSION !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(RELEASE_VERSION)) {
  throw new Error('release package version invalid')
}
const RELEASE_FILE_PREFIX = `nova-audio-agent-${RELEASE_VERSION}`

export const RELEASE_ARTIFACT_FILES = Object.freeze({
  'darwin-arm64:app': `${RELEASE_FILE_PREFIX}-macos-arm64-app.zip`,
  'darwin-arm64:dmg': `${RELEASE_FILE_PREFIX}-macos-arm64.dmg`,
  'darwin-x64:app': `${RELEASE_FILE_PREFIX}-macos-x64-app.zip`,
  'darwin-x64:dmg': `${RELEASE_FILE_PREFIX}-macos-x64.dmg`,
  'win32-x64:nsis': `${RELEASE_FILE_PREFIX}-windows-x64.exe`,
  'linux-x64-gnu:appimage': `${RELEASE_FILE_PREFIX}-linux-x64.AppImage`,
  'linux-x64-gnu:deb': `${RELEASE_FILE_PREFIX}-linux-x64.deb`,
})

export class ReleaseAttestationError extends Error {
  constructor(code) {
    super(`release attestation rejected: ${code}`)
    this.name = 'ReleaseAttestationError'
    this.code = code
  }
}

export function evidenceFileName(target, gateId) {
  if (!Object.hasOwn(RELEASE_ARTIFACT_FILES, target)
    || typeof gateId !== 'string'
    || !/^[a-z][a-z0-9_]{2,63}$/u.test(gateId)) {
    throw new ReleaseAttestationError('evidence_identity_invalid')
  }
  return `${target.replaceAll(':', '--')}--${gateId}.json`
}

export async function verifyGitHubAttestedCandidate({
  ledger,
  artifactRoot,
  evidenceRoot,
  now = Date.now(),
}, {
  runGh = defaultRunGh,
} = {}) {
  validateCandidateLedgerStructure(ledger, {now})
  const artifactDirectory = await exactDirectory(artifactRoot, 'artifact_root_invalid')
  const evidenceDirectory = await exactDirectory(evidenceRoot, 'evidence_root_invalid')
  const expectedArtifacts = Object.values(RELEASE_ARTIFACT_FILES).sort()
  await requireExactFiles(artifactDirectory, expectedArtifacts, 'artifact_matrix_invalid')

  const artifactByTarget = new Map(ledger.artifacts.map(value => [value.target, value.sha256]))
  for (const [target, filename] of Object.entries(RELEASE_ARTIFACT_FILES)) {
    const file = await exactFile(artifactDirectory, filename, MAX_ARTIFACT_BYTES, 'artifact_invalid')
    if (await digestFile(file) !== artifactByTarget.get(target)) {
      throw new ReleaseAttestationError('artifact_digest_mismatch')
    }
    requireTrustedAttestation(runGh, {
      file,
      signerWorkflow: BUILD_SIGNER,
      sourceDigest: ledger.commit,
    })
  }

  const expectedEvidence = ledger.evidence
    .map(record => evidenceFileName(record.target, record.gate_id))
    .sort()
  await requireExactFiles(evidenceDirectory, expectedEvidence, 'evidence_matrix_invalid')
  for (const record of ledger.evidence) {
    const file = await exactFile(
      evidenceDirectory,
      evidenceFileName(record.target, record.gate_id),
      MAX_EVIDENCE_BYTES,
      'evidence_invalid',
    )
    if (await digestFile(file) !== record.evidence_sha256) {
      throw new ReleaseAttestationError('evidence_digest_mismatch')
    }
    await requireEvidenceClaim(file, record, ledger)
    requireTrustedAttestation(runGh, {
      file,
      signerWorkflow: EVIDENCE_SIGNERS[record.evidence_class],
      sourceDigest: ledger.commit,
    })
  }
  return trustedCandidateResult(ledger)
}

async function requireEvidenceClaim(file, record, ledger) {
  let document
  try {
    document = parseStrictJson(await readFile(file, 'utf8'))
  } catch {
    throw new ReleaseAttestationError('evidence_claim_mismatch')
  }
  if (!plain(document)
    || Object.keys(document).sort().join('\0') !== ['commit', 'record', 'release_version', 'schema_version'].join('\0')
    || document.schema_version !== 1
    || document.release_version !== ledger.release_version
    || document.commit !== ledger.commit
    || !plain(document.record)
    || Object.keys(document.record).sort().join('\0') !== [...EVIDENCE_CLAIM_KEYS].sort().join('\0')) {
    throw new ReleaseAttestationError('evidence_claim_mismatch')
  }
  for (const key of EVIDENCE_CLAIM_KEYS) {
    if (document.record[key] !== record[key]) {
      throw new ReleaseAttestationError('evidence_claim_mismatch')
    }
  }
}

function plain(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function trustedCandidateResult(ledger) {
  const passed = new Set()
  const pending = new Set()
  const failed = new Set()
  for (const gateId of RELEASE_GATE_IDS) {
    const records = ledger.evidence.filter(record => record.gate_id === gateId)
    if (records.some(record => record.result_code === 'failed')) failed.add(gateId)
    else if (records.length !== ledger.artifacts.length
      || records.some(record => record.result_code === 'pending')) pending.add(gateId)
    else passed.add(gateId)
  }
  const status = failed.size > 0 ? 'failed' : pending.size > 0 ? 'pending' : 'passed'
  return Object.freeze({
    status,
    result_code: status === 'failed' ? 'gate_failed' : status === 'pending' ? 'evidence_pending' : 'passed',
    passed_gate_ids: Object.freeze([...passed].sort()),
    pending_gate_ids: Object.freeze([...pending].sort()),
    failed_gate_ids: Object.freeze([...failed].sort()),
  })
}

async function exactDirectory(input, code) {
  if (typeof input !== 'string' || !isAbsolute(input)) throw new ReleaseAttestationError(code)
  try {
    const canonical = await realpath(input)
    const status = await lstat(input)
    if (canonical !== resolve(input) || status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error()
    }
    return canonical
  } catch {
    throw new ReleaseAttestationError(code)
  }
}

async function requireExactFiles(root, expected, code) {
  try {
    const entries = await readdir(root, {withFileTypes: true})
    if (entries.some(entry => !entry.isFile())
      || entries.map(entry => entry.name).sort().join('\0') !== expected.join('\0')) {
      throw new Error()
    }
  } catch {
    throw new ReleaseAttestationError(code)
  }
}

async function exactFile(root, filename, maximumBytes, code) {
  const file = resolve(root, filename)
  try {
    const status = await lstat(file)
    if (status.isSymbolicLink() || !status.isFile() || status.size < 1 || status.size > maximumBytes
      || await realpath(file) !== file) throw new Error()
    return file
  } catch {
    throw new ReleaseAttestationError(code)
  }
}

function digestFile(file) {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(file)
    input.once('error', reject)
    input.on('data', chunk => hash.update(chunk))
    input.once('end', () => resolveDigest(hash.digest('hex')))
  })
}

function requireTrustedAttestation(runGh, {file, signerWorkflow, sourceDigest}) {
  const args = [
    'attestation', 'verify', file,
    '--repo', RELEASE_REPOSITORY,
    '--signer-workflow', signerWorkflow,
    '--source-digest', sourceDigest,
    '--format', 'json',
  ]
  let result
  try {
    result = runGh(Object.freeze({command: 'gh', args: Object.freeze(args)}))
  } catch {
    throw new ReleaseAttestationError('attestation_tool_failed')
  }
  if (result?.error !== undefined || result?.signal !== null || result?.status !== 0
    || typeof result.stdout !== 'string'
    || Buffer.byteLength(result.stdout, 'utf8') > GH_OUTPUT_BYTES) {
    throw new ReleaseAttestationError('attestation_untrusted')
  }
}

function defaultRunGh({command, args}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
    maxBuffer: GH_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function options(argv) {
  if (argv.length !== 6) throw new ReleaseAttestationError('usage_invalid')
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!['--ledger', '--artifact-root', '--evidence-root'].includes(name) || values.has(name)) {
      throw new ReleaseAttestationError('usage_invalid')
    }
    values.set(name, value)
  }
  return values
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  void (async () => {
    const values = options(process.argv.slice(2))
    const ledgerPath = resolve(values.get('--ledger'))
    const ledger = parseStrictJson(await readFile(ledgerPath, 'utf8'))
    const result = await verifyGitHubAttestedCandidate({
      ledger,
      artifactRoot: resolve(values.get('--artifact-root')),
      evidenceRoot: resolve(values.get('--evidence-root')),
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.status !== 'passed') process.exitCode = 1
  })().catch(() => {
    process.stderr.write('release attestation rejected\n')
    process.exitCode = 1
  })
}
