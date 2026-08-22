import {realpathSync} from 'node:fs'
import {resolve} from 'node:path'

import {resolveProvisionedCodexBinary} from './release-codex-tool.mjs'
import {runPackagedCodexCompositionSmoke} from './run-packaged-codex-smoke.mjs'

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null
}

try {
  const installRoot = option('--install-root')
  const distRoot = option('--dist-root')
  const workspace = process.env.GITHUB_WORKSPACE ?? option('--workspace')
  if (installRoot === null || distRoot === null || workspace === null) throw new Error()
  const binary = resolveProvisionedCodexBinary({installRoot: realpathSync(resolve(installRoot))})
  runPackagedCodexCompositionSmoke({
    distRoot: realpathSync(resolve(distRoot)),
    binary,
    workspace: realpathSync(resolve(workspace)),
  })
  process.stdout.write('release candidate Codex composition passed\n')
} catch {
  process.stderr.write('release candidate Codex composition rejected\n')
  process.exitCode = 1
}
