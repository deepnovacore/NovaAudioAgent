import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {createReadStream} from 'node:fs'
import {copyFile, lstat, mkdir, readdir, realpath, rm, writeFile} from 'node:fs/promises'
import {isAbsolute, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {RELEASE_ARTIFACT_FILES} from './verify-github-release-attestations.mjs'

const OUTPUT_LIMIT = 64 * 1024

export async function collectReleaseArtifacts({
  targetId,
  distRoot,
  outputRoot,
  digestRoot = resolve(outputRoot, '..', 'release-digests'),
}, {
  run = defaultRun,
  archiveCreated = async () => {},
} = {}) {
  if (!['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64-gnu'].includes(targetId)) {
    throw new Error('release_artifact_collection_rejected')
  }
  for (const value of [distRoot, outputRoot, digestRoot]) {
    if (typeof value !== 'string' || !isAbsolute(value)) {
      throw new Error('release_artifact_collection_rejected')
    }
  }
  const source = await realpath(distRoot)
  await Promise.all([
    rm(outputRoot, {recursive: true, force: true}),
    rm(digestRoot, {recursive: true, force: true}),
  ])
  await Promise.all([
    mkdir(outputRoot, {recursive: true, mode: 0o700}),
    mkdir(digestRoot, {recursive: true, mode: 0o700}),
  ])
  const inputs = await candidateInputs(targetId, source)
  const records = []
  for (const input of inputs) {
    const filename = RELEASE_ARTIFACT_FILES[input.target]
    const destination = resolve(outputRoot, filename)
    if (input.kind === 'app') {
      const result = run(Object.freeze({
        command: '/usr/bin/ditto',
        args: Object.freeze(['-c', '-k', '--sequesterRsrc', '--keepParent', input.path, destination]),
      }))
      if (result?.error !== undefined || result?.signal !== null || result?.status !== 0) {
        throw new Error('release_artifact_collection_rejected')
      }
      await archiveCreated(destination)
    } else {
      await copyFile(input.path, destination)
    }
    const status = await lstat(destination)
    if (!status.isFile() || status.isSymbolicLink() || status.size < 1) {
      throw new Error('release_artifact_collection_rejected')
    }
    const sha256 = await digestFile(destination)
    await writeFile(resolve(digestRoot, `${filename}.sha256`), `${sha256}\n`, {
      encoding: 'utf8', mode: 0o600,
    })
    records.push(Object.freeze({target: input.target, filename, sha256}))
  }
  return Object.freeze(records)
}

async function candidateInputs(targetId, distRoot) {
  const entries = await readdir(distRoot, {withFileTypes: true})
  if (targetId.startsWith('darwin-')) {
    const arch = targetId.slice('darwin-'.length)
    const app = resolve(
      distRoot,
      arch === 'arm64' ? 'mac-arm64' : 'mac',
      'Nova Audio Agent Ambient Orb.app',
    )
    const appStatus = await lstat(app)
    const dmgs = entries.filter(entry => entry.isFile() && entry.name.endsWith('.dmg'))
    if (!appStatus.isDirectory() || appStatus.isSymbolicLink() || dmgs.length !== 1) {
      throw new Error('release_artifact_collection_rejected')
    }
    return [
      {target: `${targetId}:app`, kind: 'app', path: app},
      {target: `${targetId}:dmg`, kind: 'file', path: resolve(distRoot, dmgs[0].name)},
    ]
  }
  if (targetId === 'win32-x64') {
    const installers = entries.filter(entry => entry.isFile() && entry.name.endsWith('.exe'))
    if (installers.length !== 1) throw new Error('release_artifact_collection_rejected')
    return [{target: `${targetId}:nsis`, kind: 'file', path: resolve(distRoot, installers[0].name)}]
  }
  const appimages = entries.filter(entry => entry.isFile() && entry.name.endsWith('.AppImage'))
  const debs = entries.filter(entry => entry.isFile() && entry.name.endsWith('.deb'))
  if (appimages.length !== 1 || debs.length !== 1) {
    throw new Error('release_artifact_collection_rejected')
  }
  return [
    {target: `${targetId}:appimage`, kind: 'file', path: resolve(distRoot, appimages[0].name)},
    {target: `${targetId}:deb`, kind: 'file', path: resolve(distRoot, debs[0].name)},
  ]
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

function defaultRun({command, args}) {
  return spawnSync(command, args, {
    encoding: 'utf8', timeout: 120_000, maxBuffer: OUTPUT_LIMIT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--target-id')
  const targetId = index >= 0 ? process.argv[index + 1] : undefined
  void collectReleaseArtifacts({
    targetId,
    distRoot: resolve(import.meta.dirname, '../dist'),
    outputRoot: resolve(import.meta.dirname, '../build/release-artifacts'),
  }).then(
    records => process.stdout.write(`${JSON.stringify(records)}\n`),
    () => {
      process.stderr.write('release artifact collection rejected\n')
      process.exitCode = 1
    },
  )
}
