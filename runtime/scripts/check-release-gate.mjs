import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'

export const RELEASE_REQUIREMENTS = Object.freeze([
  'm1', 'm15', 'm2', 'm3', 'm4', 'voice', 'approvals', 'cascaded', 'wake-word',
  'darwin-arm64', 'darwin-x64', 'win32-x64',
])

/** Validate the reviewed acceptance declarations; hardware evidence is supplied by the operator. */
export function releaseGateFailures(markdown) {
  const rows = [...markdown.matchAll(/^\|\s*([a-z0-9-]+)\s*\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|\s*$/gmu)]
  return RELEASE_REQUIREMENTS.filter(id => {
    const matches = rows.filter(row => row[1] === id)
    return matches.length !== 1 || matches[0][2] !== 'passed'
      || !/\[[^\]]+\]\([^\s)]+\)/u.test(matches[0][3])
  })
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const failures = releaseGateFailures(readFileSync(new URL('../../docs/specs/v0.2.0/RELEASE-GATE.md', import.meta.url), 'utf8'))
  if (failures.length > 0) {
    process.stderr.write(`Release acceptance pending or invalid: ${failures.join(', ')}\n`)
    process.exitCode = 1
  } else process.stdout.write('Release acceptance declarations complete\n')
}
