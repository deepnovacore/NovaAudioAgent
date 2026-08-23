import {spawnSync} from 'node:child_process'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {CAMERA_CAPABILITY_PENDING} from './installed-candidate-smoke.mjs'

const OUTPUT_LIMIT = 64 * 1024
const TIMEOUT_MS = 10 * 60 * 1000

export function classifyUnsignedSmoke(result) {
  if (result?.error === undefined && result?.signal === null && result?.stderr === '') {
    if (result.status === 0 && result.stdout === 'installed candidate smoke passed\n') {
      return Object.freeze({installed: 'passed', camera: 'passed'})
    }
    if (result.status === 75 && result.stdout === `${CAMERA_CAPABILITY_PENDING}\n`) {
      return Object.freeze({installed: 'passed', camera: 'pending'})
    }
  }
  throw new Error('unsigned_installed_smoke_failed')
}

function runUnsignedInstalledSmoke(argv) {
  const result = spawnSync(process.execPath, [
    resolve(import.meta.dirname, 'installed-candidate-smoke.mjs'),
    ...argv,
  ], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: OUTPUT_LIMIT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return classifyUnsignedSmoke(result)
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(runUnsignedInstalledSmoke(process.argv.slice(2)))}\n`)
  } catch {
    process.stderr.write('unsigned installed smoke rejected\n')
    process.exitCode = 1
  }
}
