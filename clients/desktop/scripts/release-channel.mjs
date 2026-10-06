import assert from 'node:assert/strict'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

export function releaseChannel(version) {
  assert.match(version ?? '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/u, 'expected stable semver or X.Y.Z-preview.N')
  return version.includes('-preview.') ? 'preview' : 'latest'
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) console.log(releaseChannel(process.argv[2]))
