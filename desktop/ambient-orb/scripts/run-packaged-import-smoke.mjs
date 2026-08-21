import {spawnSync} from 'node:child_process'
import {resolve} from 'node:path'

export function runPackagedImportSmoke({appOutDir, resourcesRoot, platform, productFilename}) {
  const executable = platform === 'darwin'
    ? resolve(appOutDir, `${productFilename}.app/Contents/MacOS/${productFilename}`)
    : platform === 'win32'
      ? resolve(appOutDir, `${productFilename}.exe`)
      : resolve(appOutDir, 'nova-ambient-orb')
  const harness = resolve(import.meta.dirname, 'packaged-runtime-import-smoke.cjs')
  const result = spawnSync(executable, [harness, resourcesRoot], {
    encoding: 'utf8',
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},
    timeout: 20_000,
    maxBuffer: 16 * 1024,
    windowsHide: true,
  })
  if (
    result.error !== undefined
    || result.status !== 0
    || result.stdout !== 'packaged runtime import passed\n'
    || result.stderr.includes('packaged_import_child_forbidden')
  ) throw new Error('packaged runtime import rejected')
}
