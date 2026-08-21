import { lstat, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { inspectAsarSnapshot, PackageInspectionError } from './inspect-package.mjs'

const root = resolve(import.meta.dirname, '../dist')
const targetId = process.platform === 'darwin'
  ? `darwin-${process.arch}`
  : process.platform === 'win32'
    ? `win32-${process.arch}`
    : `linux-${process.arch}-gnu`
let archive
if (process.platform === 'darwin') {
  const applicationRoot = resolve(root, `mac-${process.arch}`)
  const applications = (await readdir(applicationRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.endsWith('.app'))
  if (applications.length !== 1) throw new PackageInspectionError('produced application rejected')
  archive = resolve(applicationRoot, applications[0].name, 'Contents/Resources/app.asar')
} else {
  const unpacked = process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked'
  archive = resolve(root, unpacked, 'resources/app.asar')
}
let status
try {
  status = await lstat(archive)
} catch {
  throw new PackageInspectionError('produced application unavailable')
}
if (!status.isFile() || status.isSymbolicLink()) {
  throw new PackageInspectionError('produced application rejected')
}
const report = await inspectAsarSnapshot(archive, { targetId })
process.stdout.write(`${JSON.stringify({
  result_code: 'passed',
  target: targetId,
  asar_sha256: report.asar_sha256,
  unpacked_sha256: report.unpacked_sha256,
  file_count: report.file_count,
})}\n`)
