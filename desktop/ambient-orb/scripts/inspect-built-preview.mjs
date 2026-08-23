import { lstat, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { inspectBuiltArtifact, PackageInspectionError } from './inspect-package.mjs'

async function main() {
if (process.argv.length > 3 || (process.argv.length === 3 && process.argv[2] !== '--require-target-matrix')) {
  throw new PackageInspectionError('usage rejected')
}
const root = resolve(import.meta.dirname, '../dist')
const targetId = process.platform === 'darwin'
  ? `darwin-${process.arch}`
  : process.platform === 'win32'
    ? `win32-${process.arch}`
    : `linux-${process.arch}-gnu`
const candidates = []
  if (process.platform === 'darwin') {
  const applicationRoot = resolve(root, process.arch === 'arm64' ? 'mac-arm64' : 'mac')
  const applications = (await readdir(applicationRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.endsWith('.app'))
    if (applications.length !== 1) throw new PackageInspectionError('produced application rejected')
    candidates.push({ path: resolve(applicationRoot, applications[0].name), format: 'app' })
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.dmg')) {
        candidates.push({ path: resolve(root, entry.name), format: 'dmg' })
      }
    }
} else {
  const entries = await readdir(root, { withFileTypes: true })
  if (process.platform === 'win32') {
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.exe')) {
        candidates.push({ path: resolve(root, entry.name), format: 'nsis' })
      }
    }
  } else {
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (entry.name.endsWith('.AppImage')) {
        candidates.push({ path: resolve(root, entry.name), format: 'appimage' })
      } else if (entry.name.endsWith('.deb')) {
        candidates.push({ path: resolve(root, entry.name), format: 'deb' })
      }
    }
  }
}
  const requireTargetMatrix = process.argv.length === 3
    && process.argv[2] === '--require-target-matrix'
  const expectedCount = process.platform === 'linux' || (process.platform === 'darwin' && requireTargetMatrix)
    ? 2
    : 1
if (candidates.length !== expectedCount) {
  throw new PackageInspectionError('produced candidate matrix rejected')
}
const reports = []
for (const candidate of candidates.sort((left, right) => (
  left.format < right.format ? -1 : left.format > right.format ? 1 : 0
))) {
  const status = await lstat(candidate.path)
  if (status.isSymbolicLink()) throw new PackageInspectionError('produced candidate rejected')
  reports.push(await inspectBuiltArtifact(candidate.path, {
    targetId,
    format: candidate.format,
  }))
}
  const result = Object.freeze({
    schema_version: 1,
    result_code: 'passed',
    target: targetId,
    artifacts: reports,
  })
  await writeFile(
    resolve(root, `release-inspection-${targetId}.json`),
    `${JSON.stringify(result)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

main().catch(error => {
  const detail = error instanceof PackageInspectionError
    ? error.message.replace(/^desktop package contract rejected: /u, '')
    : ''
  const diagnostic = process.env.NOVA_RELEASE_INSPECTION_DIAGNOSTICS === '1'
    && /^[a-zA-Z0-9 @._:+/<>,= -]{1,256}$/u.test(detail)
    ? `: ${detail}`
    : ''
  process.stderr.write(`desktop package inspection rejected${diagnostic}\n`)
  process.exitCode = 1
})
