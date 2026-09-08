import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {runWorkflowArtifactCandidateCli} from './installed-candidate-smoke.mjs'

export function classifyUnsignedCamera(camera) {
  if (camera === null || (camera?.status === 'passed' && Object.keys(camera).length === 1)) {
    return Object.freeze({installed: 'passed', camera: 'passed'})
  }
  if (camera?.status === 'pending' && camera?.result_code === 'chromium_codec_unavailable'
    && Object.keys(camera).length === 2) {
    return Object.freeze({installed: 'passed', camera: 'pending'})
  }
  throw new Error('unsigned_installed_smoke_failed')
}

async function runUnsignedInstalledSmoke(argv) {
  const camera = await runWorkflowArtifactCandidateCli(argv)
  return classifyUnsignedCamera(camera)
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  void runUnsignedInstalledSmoke(process.argv.slice(2)).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }).catch(() => {
    process.stderr.write('unsigned installed smoke rejected\n')
    process.exitCode = 1
  })
}
