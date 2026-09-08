import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {lstat, readFile, readdir, realpath, writeFile} from 'node:fs/promises'
import {isAbsolute, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {RELEASE_ARTIFACT_FILES, RELEASE_VERSION} from './verify-github-release-attestations.mjs'

export async function generateReleaseManifest({artifactRoot, commit, output}) {
  if (![artifactRoot, output].every(value => typeof value === 'string' && isAbsolute(value))
    || typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error('release_manifest_rejected')
  }
  const root = await realpath(artifactRoot)
  const expected = Object.values(RELEASE_ARTIFACT_FILES).sort()
  const entries = await readdir(root, {withFileTypes: true})
  if (entries.some(entry => !entry.isFile())
    || entries.map(entry => entry.name).sort().join('\0') !== expected.join('\0')) {
    throw new Error('release_manifest_rejected')
  }
  const assets = []
  for (const [target, filename] of Object.entries(RELEASE_ARTIFACT_FILES)) {
    const file = resolve(root, filename)
    const status = await lstat(file)
    if (!status.isFile() || status.isSymbolicLink() || status.size < 1
      || await realpath(file) !== file) throw new Error('release_manifest_rejected')
    const sha256 = await digestFile(file)
    assets.push({target, filename, size: status.size, sha256})
    await writeFile(resolve(root, `${filename}.sha256`), `${sha256}  ${filename}\n`, {
      encoding: 'utf8', mode: 0o600,
    })
  }
  const manifest = {
    schema_version: 1,
    version: RELEASE_VERSION,
    commit,
    signed: false,
    assets,
  }
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, {encoding: 'utf8', mode: 0o600})
  const manifestName = output.split(/[\\/]/u).at(-1)
  await writeFile(`${output}.sha256`, `${await digestFile(output)}  ${manifestName}\n`, {
    encoding: 'utf8', mode: 0o600,
  })
  return manifest
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
  void generateReleaseManifest({
    artifactRoot: resolve(option('--artifact-root') ?? ''),
    commit: option('--commit'),
    output: resolve(option('--output') ?? ''),
  }).then(
    manifest => process.stdout.write(`${JSON.stringify({assets: manifest.assets.length})}\n`),
    () => {
      process.stderr.write('release manifest rejected\n')
      process.exitCode = 1
    },
  )
}
