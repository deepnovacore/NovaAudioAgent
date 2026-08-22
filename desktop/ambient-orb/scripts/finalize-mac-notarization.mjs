import {spawnSync} from 'node:child_process'
import {lstatSync, readdirSync, realpathSync} from 'node:fs'
import {isAbsolute, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const OUTPUT_LIMIT = 64 * 1024
const TIMEOUT_MS = 30 * 60 * 1000
const CREDENTIALS = Object.freeze([
  'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID',
])

export function macContainerNotarizationPlan({distRoot, environment = process.env}) {
  if (typeof distRoot !== 'string' || !isAbsolute(distRoot)) {
    throw new Error('mac_container_notarization_rejected')
  }
  const root = realpathSync(distRoot)
  const dmgs = readdirSync(root, {withFileTypes: true})
    .filter(entry => entry.isFile() && entry.name.endsWith('.dmg'))
  if (dmgs.length !== 1) throw new Error('mac_container_notarization_rejected')
  const dmg = resolve(root, dmgs[0].name)
  const status = lstatSync(dmg)
  if (status.isSymbolicLink() || !status.isFile() || status.size < 1 || realpathSync(dmg) !== dmg) {
    throw new Error('mac_container_notarization_rejected')
  }
  const values = Object.fromEntries(CREDENTIALS.map(name => {
    const value = environment[name]
    if (typeof value !== 'string' || value === '' || value.length > 64 * 1024
      || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error('mac_container_notarization_rejected')
    }
    return [name, value]
  }))
  return Object.freeze([
    Object.freeze({
      command: '/usr/bin/xcrun',
      args: Object.freeze([
        'notarytool', 'submit', dmg,
        '--apple-id', values.APPLE_ID,
        '--password', values.APPLE_APP_SPECIFIC_PASSWORD,
        '--team-id', values.APPLE_TEAM_ID,
        '--wait',
      ]),
    }),
    Object.freeze({
      command: '/usr/bin/xcrun',
      args: Object.freeze(['stapler', 'staple', dmg]),
    }),
  ])
}

export function finalizeMacContainerNotarization(input, {run = defaultRun} = {}) {
  for (const step of macContainerNotarizationPlan(input)) {
    const result = run(step)
    if (result?.error !== undefined || result?.signal !== null || result?.status !== 0) {
      throw new Error('mac_container_notarization_rejected')
    }
  }
}

function defaultRun({command, args}) {
  return spawnSync(command, args, {
    encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf('--dist-root')
    if (index < 0 || index + 1 >= process.argv.length || process.argv.length !== 4) throw new Error()
    finalizeMacContainerNotarization({distRoot: resolve(process.argv[index + 1])})
    process.stdout.write('mac container notarization passed\n')
  } catch {
    process.stderr.write('mac container notarization rejected\n')
    process.exitCode = 1
  }
}
