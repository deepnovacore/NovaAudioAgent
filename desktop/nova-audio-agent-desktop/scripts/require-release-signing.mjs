import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const REQUIRED = Object.freeze({
  darwin: Object.freeze([
    'CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID',
  ]),
  win32: Object.freeze(['CSC_LINK', 'CSC_KEY_PASSWORD']),
  linux: Object.freeze([]),
})

export function requireReleaseSigning(platform, environment = process.env) {
  const names = REQUIRED[platform]
  if (names === undefined) throw new Error('release_signing_configuration_rejected')
  for (const name of names) {
    const value = environment[name]
    if (typeof value !== 'string' || value === '' || value.length > 64 * 1024
      || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error('release_signing_configuration_rejected')
    }
  }
  return Object.freeze({platform, configured: true})
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf('--platform')
    if (index < 0 || index + 1 >= process.argv.length) throw new Error()
    requireReleaseSigning(process.argv[index + 1])
    process.stdout.write('release signing configuration accepted\n')
  } catch {
    process.stderr.write('release signing configuration rejected\n')
    process.exitCode = 1
  }
}
