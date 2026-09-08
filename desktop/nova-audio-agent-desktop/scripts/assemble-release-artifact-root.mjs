import {copyFile, lstat, mkdir, readdir, realpath, rm} from 'node:fs/promises'
import {resolve} from 'node:path'

import {RELEASE_ARTIFACT_FILES} from './verify-github-release-attestations.mjs'

const inputIndex = process.argv.indexOf('--input')
const outputIndex = process.argv.indexOf('--output')

void (async () => {
  if (inputIndex < 0 || outputIndex < 0) throw new Error()
  const input = await realpath(resolve(process.argv[inputIndex + 1]))
  const output = resolve(process.argv[outputIndex + 1])
  await rm(output, {recursive: true, force: true})
  await mkdir(output, {recursive: true, mode: 0o700})
  const found = new Map()
  for (const artifactDirectory of await findArtifactDirectories(input)) {
    for (const entry of await readdir(artifactDirectory, {withFileTypes: true})) {
      if (!entry.isFile() || !Object.values(RELEASE_ARTIFACT_FILES).includes(entry.name)
        || found.has(entry.name)) throw new Error()
      const source = resolve(artifactDirectory, entry.name)
      const status = await lstat(source)
      if (status.isSymbolicLink() || await realpath(source) !== source) throw new Error()
      found.set(entry.name, source)
    }
  }
  if ([...found.keys()].sort().join('\0')
    !== Object.values(RELEASE_ARTIFACT_FILES).sort().join('\0')) throw new Error()
  await Promise.all([...found].map(([name, source]) => copyFile(source, resolve(output, name))))
  process.stdout.write('release artifact root assembled\n')
})().catch(() => {
  process.stderr.write('release artifact root rejected\n')
  process.exitCode = 1
})

async function findArtifactDirectories(root) {
  const found = []
  for (const entry of await readdir(root, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue
    const directory = resolve(root, entry.name, 'release-artifacts')
    try {
      const status = await lstat(directory)
      if (status.isSymbolicLink() || !status.isDirectory()
        || await realpath(directory) !== directory) throw new Error()
      found.push(directory)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return found
}
