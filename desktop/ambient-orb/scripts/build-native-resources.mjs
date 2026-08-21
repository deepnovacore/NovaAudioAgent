import { chmod, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateNativeResourceManifest, NativeResourceError } from './native-resource-contract.mjs'

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  const resourcesRoot = option('--resources-root')
  const targetId = option('--target')
  const output = option('--output')
  const run = !resourcesRoot || !targetId || !output
    ? Promise.reject(new NativeResourceError('usage_invalid'))
    : generateNativeResourceManifest({ resourcesRoot, targetId }).then(async manifest => {
      const destination = resolve(output)
      const temporary = resolve(dirname(destination), '.native-resources-v1.json.tmp')
      await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, destination)
      return manifest
    })
  run.then(
    manifest => process.stdout.write(`${JSON.stringify({
      result_code: 'passed',
      resource_count: manifest.resources.length,
      target: manifest.target,
    })}\n`),
    () => {
      process.stderr.write('native resource build rejected\n')
      process.exitCode = 1
    },
  )
}
