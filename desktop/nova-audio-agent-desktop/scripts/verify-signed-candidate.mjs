import {spawnSync} from 'node:child_process'
import {lstatSync, readFileSync, readdirSync, realpathSync} from 'node:fs'
import {isAbsolute, relative, resolve, sep} from 'node:path'
import {fileURLToPath} from 'node:url'

const OUTPUT_LIMIT = 64 * 1024

export function signedCandidateVerificationPlan({platform, distRoot, environment = process.env}) {
  if (typeof distRoot !== 'string' || !isAbsolute(distRoot)) {
    throw new Error('signed_candidate_verification_rejected')
  }
  const root = realpathSync(distRoot)
  if (platform === 'darwin') {
    const apps = findDirectories(root, value => value.endsWith('.app'))
    const dmgs = find(root, value => value.endsWith('.dmg'), false)
    if (apps.length !== 1 || dmgs.length !== 1) throw new Error('signed_candidate_verification_rejected')
    return Object.freeze([
      command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', apps[0]]),
      command('/usr/sbin/spctl', ['--assess', '--type', 'execute', apps[0]]),
      command('/usr/bin/xcrun', ['stapler', 'validate', apps[0]]),
      command('/usr/bin/xcrun', ['stapler', 'validate', dmgs[0]]),
    ])
  }
  if (platform === 'win32') {
    const signTool = resolveWindowsSignTool(environment)
    const unpacked = resolve(root, 'win-unpacked')
    const resources = resolve(unpacked, 'resources')
    const native = manifestSignedPaths(resources, 'win32-x64')
    const files = [...new Set([
      ...walk(root, value => value.endsWith('.exe')),
      ...native,
    ])]
    if (files.length < 4) throw new Error('signed_candidate_verification_rejected')
    return Object.freeze(files.sort().map(file => command(signTool, ['verify', '/pa', '/all', file])))
  }
  if (platform === 'linux') {
    const appimages = find(root, value => value.endsWith('.AppImage'), false)
    const debs = find(root, value => value.endsWith('.deb'), false)
    if (appimages.length !== 1 || debs.length !== 1) throw new Error('signed_candidate_verification_rejected')
    return Object.freeze([
      command('/usr/bin/dpkg-deb', ['--info', debs[0]]),
      command('/usr/bin/file', ['--brief', appimages[0]]),
    ])
  }
  throw new Error('signed_candidate_verification_rejected')
}

function resolveWindowsSignTool(environment) {
  const programFiles = environment?.['ProgramFiles(x86)']
  if (typeof programFiles !== 'string' || !isAbsolute(programFiles)) {
    throw new Error('signed_candidate_verification_rejected')
  }
  const kitBin = resolve(programFiles, 'Windows Kits', '10', 'bin')
  let entries
  try {
    const status = lstatSync(kitBin)
    if (status.isSymbolicLink() || !status.isDirectory() || realpathSync(kitBin) !== kitBin) {
      throw new Error()
    }
    entries = readdirSync(kitBin, {withFileTypes: true})
  } catch {
    throw new Error('signed_candidate_verification_rejected')
  }
  const tools = []
  for (const entry of entries) {
    const match = /^(\d{1,10})\.(\d{1,10})\.(\d{1,10})\.(\d{1,10})$/u.exec(entry.name)
    if (!entry.isDirectory() || match === null) continue
    const file = resolve(kitBin, entry.name, 'x64', 'signtool.exe')
    try {
      const status = lstatSync(file)
      if (status.isSymbolicLink() || !status.isFile() || realpathSync(file) !== file) continue
    } catch { continue }
    tools.push({file, version: match.slice(1).map(value => Number(value))})
  }
  tools.sort((left, right) => {
    for (let index = 0; index < 4; index += 1) {
      if (left.version[index] !== right.version[index]) {
        return right.version[index] - left.version[index]
      }
    }
    return 0
  })
  if (tools.length === 0) throw new Error('signed_candidate_verification_rejected')
  return tools[0].file
}

function findDirectories(root, predicate) {
  const result = []
  const visit = directory => {
    let entries
    try { entries = readdirSync(directory, {withFileTypes: true}) }
    catch { throw new Error('signed_candidate_verification_rejected') }
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      const status = lstatSync(path)
      if (status.isSymbolicLink() || realpathSync(path) !== path) {
        throw new Error('signed_candidate_verification_rejected')
      }
      if (!entry.isDirectory()) {
        if (!entry.isFile()) throw new Error('signed_candidate_verification_rejected')
        continue
      }
      if (predicate(entry.name)) result.push(path)
      else visit(path)
    }
  }
  visit(root)
  return result
}

function manifestSignedPaths(resourcesRoot, target) {
  let manifest
  try { manifest = JSON.parse(readFileSync(resolve(resourcesRoot, 'native-resources-v1.json'), 'utf8')) }
  catch { throw new Error('signed_candidate_verification_rejected') }
  if (manifest?.schema_version !== 1 || manifest?.target !== target || !Array.isArray(manifest.resources)) {
    throw new Error('signed_candidate_verification_rejected')
  }
  const paths = []
  for (const record of manifest.resources) {
    if (!['executable', 'node_addon', 'shared_library'].includes(record?.kind)) continue
    if (typeof record.relative_path !== 'string' || record.platform !== 'win32') {
      throw new Error('signed_candidate_verification_rejected')
    }
    const file = resolve(resourcesRoot, record.relative_path)
    const relativePath = relative(resourcesRoot, file)
    if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`)
      || isAbsolute(relativePath) || realpathSync(file) !== file) {
      throw new Error('signed_candidate_verification_rejected')
    }
    paths.push(file)
  }
  if (paths.length === 0) throw new Error('signed_candidate_verification_rejected')
  return paths
}

function walk(root, predicate) {
  const result = []
  const visit = directory => {
    let entries
    try { entries = readdirSync(directory, {withFileTypes: true}) }
    catch { throw new Error('signed_candidate_verification_rejected') }
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      const status = lstatSync(path)
      if (status.isSymbolicLink() || realpathSync(path) !== path) {
        throw new Error('signed_candidate_verification_rejected')
      }
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && predicate(entry.name)) result.push(path)
      else if (!entry.isFile()) throw new Error('signed_candidate_verification_rejected')
    }
  }
  visit(root)
  return result
}

export function verifySignedCandidate(input, {run = defaultRun} = {}) {
  const plan = signedCandidateVerificationPlan(input)
  for (const step of plan) {
    const result = run(step)
    if (result?.error !== undefined || result?.signal !== null || result?.status !== 0) {
      throw new Error('signed_candidate_verification_rejected')
    }
  }
}

function find(root, predicate, directories) {
  let entries
  try { entries = readdirSync(root, {withFileTypes: true}) } catch { return [] }
  return entries
    .filter(entry => directories ? entry.isDirectory() : entry.isFile())
    .filter(entry => predicate(entry.name))
    .map(entry => {
      const path = resolve(root, entry.name)
      const status = lstatSync(path)
      if (status.isSymbolicLink() || realpathSync(path) !== path) {
        throw new Error('signed_candidate_verification_rejected')
      }
      return path
    })
}

function command(executable, args) {
  return Object.freeze({command: executable, args: Object.freeze(args)})
}

function defaultRun({command: executable, args}) {
  return spawnSync(executable, args, {
    encoding: 'utf8', timeout: 120_000, maxBuffer: OUTPUT_LIMIT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const platformIndex = process.argv.indexOf('--platform')
    const distIndex = process.argv.indexOf('--dist-root')
    if (platformIndex < 0 || distIndex < 0) throw new Error()
    verifySignedCandidate({
      platform: process.argv[platformIndex + 1],
      distRoot: resolve(process.argv[distIndex + 1]),
    })
    process.stdout.write('signed candidate verification passed\n')
  } catch {
    process.stderr.write('signed candidate verification rejected\n')
    process.exitCode = 1
  }
}
