import {realpathSync} from 'node:fs'
import {isAbsolute, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {resolveProvisionedCodexBinary} from './release-codex-tool.mjs'
import {runPackagedCodexCompositionSmoke} from './run-packaged-codex-smoke.mjs'

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null
}

export function releaseCandidateWorkspace(environment = process.env) {
  const configured = environment.GITHUB_WORKSPACE
  if (configured !== undefined && (typeof configured !== 'string' || !isAbsolute(configured))) {
    throw new Error('release_candidate_workspace_rejected')
  }
  return realpathSync(configured ?? resolve(import.meta.dirname, '../../..'))
}

function main() {
try {
  const installRoot = option('--install-root')
  const distRoot = option('--dist-root')
  const workspace = option('--workspace') === null
    ? releaseCandidateWorkspace()
    : realpathSync(resolve(option('--workspace')))
  if (installRoot === null || distRoot === null) throw new Error()
  const binary = resolveProvisionedCodexBinary({installRoot: realpathSync(resolve(installRoot))})
  runPackagedCodexCompositionSmoke({
    distRoot: realpathSync(resolve(distRoot)),
    binary,
    workspace: realpathSync(resolve(workspace)),
  })
  process.stdout.write('release candidate Codex composition passed\n')
} catch (error) {
  const stage = typeof error?.code === 'string' && /^[a-z_]+$/u.test(error.code)
    ? error.code
    : 'unknown'
  process.stderr.write(`release candidate Codex composition rejected stage=${stage}\n`)
  process.exitCode = 1
}
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main()
