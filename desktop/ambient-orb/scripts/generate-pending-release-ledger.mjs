import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {lstat, readFile, readdir, realpath, writeFile} from 'node:fs/promises'
import {isAbsolute, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {RELEASE_ARTIFACT_FILES} from './verify-github-release-attestations.mjs'

export async function generatePendingLedger({
  artifactRoot,
  releaseVersion,
  commit,
  applicationVersion,
}) {
  const releaseMatch = typeof releaseVersion === 'string'
    ? /^(\d+\.\d+\.\d+)(?:-rc\.\d+)?$/u.exec(releaseVersion)
    : null
  if (typeof artifactRoot !== 'string' || !isAbsolute(artifactRoot)
    || releaseMatch === null
    || typeof applicationVersion !== 'string'
    || !/^\d+\.\d+\.\d+$/u.test(applicationVersion)
    || releaseMatch[1] !== applicationVersion
    || typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error('pending_release_ledger_rejected')
  }
  const root = await realpath(artifactRoot)
  const entries = await readdir(root, {withFileTypes: true})
  const expected = Object.values(RELEASE_ARTIFACT_FILES).sort()
  if (entries.some(entry => !entry.isFile())
    || entries.map(entry => entry.name).sort().join('\0') !== expected.join('\0')) {
    throw new Error('pending_release_ledger_rejected')
  }
  const artifacts = []
  for (const [target, filename] of Object.entries(RELEASE_ARTIFACT_FILES)) {
    const file = resolve(root, filename)
    const status = await lstat(file)
    if (status.isSymbolicLink() || !status.isFile() || status.size < 1
      || await realpath(file) !== file) throw new Error('pending_release_ledger_rejected')
    artifacts.push(Object.freeze({target, sha256: await digestFile(file)}))
  }
  return Object.freeze({
    schema_version: 1,
    release_version: releaseVersion,
    commit,
    artifacts: Object.freeze(artifacts),
    evidence: Object.freeze([]),
  })
}

function digestFile(path) {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(path)
    input.once('error', reject)
    input.on('data', chunk => hash.update(chunk))
    input.once('end', () => resolveDigest(hash.digest('hex')))
  })
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  void (async () => {
    const packageManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const ledger = await generatePendingLedger({
      artifactRoot: resolve(option('--artifact-root') ?? ''),
      releaseVersion: option('--release-version'),
      commit: option('--commit'),
      applicationVersion: packageManifest?.version,
    })
    const output = resolve(option('--output') ?? '')
    await writeFile(output, `${JSON.stringify(ledger)}\n`, {encoding: 'utf8', mode: 0o600})
    process.stdout.write('pending release ledger generated\n')
  })().catch(() => {
    process.stderr.write('pending release ledger rejected\n')
    process.exitCode = 1
  })
}
