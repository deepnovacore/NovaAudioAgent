import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { createRequire } from 'node:module'
import {
  chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, realpath, rm, symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, matchesGlob, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractAll, getRawHeader, listPackage } from '@electron/asar'

import {
  deriveLockedProductionClosure,
  readReleaseTargets,
} from './release-dependency-closure.mjs'
import {
  NativeResourceError,
  verifyNativeResourceManifest,
} from './native-resource-contract.mjs'
import { parseStrictJson } from './strict-json.mjs'

const RUNTIME_PACKAGE = '@nova-audio-agent/runtime'
const DESKTOP_PACKAGE = '@nova-audio-agent/ambient-orb'
const DESKTOP_MANIFEST_FILE = 'package.json'
const RUNTIME_MANIFEST_FILE = `node_modules/${RUNTIME_PACKAGE}/package.json`
const DEPENDENCY_REPORT_FILE = 'build/release/production-dependencies-v1.json'
const REQUIRED_CAMERA_FILE = 'src/renderer/camera.mjs'
const REQUIRED_RUNTIME_FILE = `node_modules/${RUNTIME_PACKAGE}/dist/src/desktop-entry.js`
const EXPECTED_RUNTIME_DEPENDENCIES = Object.freeze([
  '@livekit/agents',
  '@livekit/rtc-node',
  'undici',
  'ws',
  'zod',
])
const REQUIRED_RUNTIME_DEPENDENCY_FILES = Object.freeze(
  EXPECTED_RUNTIME_DEPENDENCIES.map(name => `node_modules/${name}/package.json`),
)
const MAX_INSPECTED_FILES = 10_000
const MAX_ARTIFACT_LIST_BYTES = 4 * 1024 * 1024
const MAX_ARTIFACT_MANIFEST_BYTES = 64 * 1024
const MAX_ASAR_BYTES = 512 * 1024 * 1024
const MAX_ASAR_HEADER_BYTES = 16 * 1024 * 1024
const MAX_DEPENDENCY_FILE_BYTES = 256 * 1024 * 1024
const MAX_CANDIDATE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_CANDIDATE_FILES = 50_000
const MAX_CANDIDATE_DEPTH = 64
const MAX_CANDIDATE_MILLISECONDS = 120_000
const MAX_CONTAINER_ENTRIES = 10_000
const MAX_CONTAINER_LISTING_BYTES = 8 * 1024 * 1024
const MAX_CONTAINER_LISTING_LINES = 100_000
const MAX_CONTAINER_LINE_BYTES = 16 * 1024
const MAX_CONTAINER_TOOL_BYTES = 16 * 1024 * 1024
const DEFAULT_PACKAGE_LOCK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../package-lock.json',
)
const CONTAINER_TOOL_MANIFEST = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../release/inspection-tools-v1.json',
)
const CONTAINER_TOOL_PACKAGE_NAMES = new Set(['7zip-bin', '@electron/7zip-bin'])
const CONTAINER_TOOL_TUPLES = Object.freeze({
  'darwin-arm64': Object.freeze({ path: 'mac/arm64/7za', binary_kind: 'macho' }),
  'darwin-x64': Object.freeze({ path: 'mac/x64/7za', binary_kind: 'macho' }),
  'linux-x64': Object.freeze({ path: 'linux/x64/7za', binary_kind: 'elf' }),
  'win32-x64': Object.freeze({ path: 'win/x64/7za.exe', binary_kind: 'pe' }),
})
const LINUX_SYSTEM_SEVEN_ZIP = '/usr/lib/7zip/7z'

export class PackageInspectionError extends Error {
  constructor(detail) {
    super(`desktop package contract rejected: ${detail}`)
    this.name = 'PackageInspectionError'
  }
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function normalized(path) {
  return path.split(sep).join('/').replace(/^\.\//u, '')
}

function validateRelativeFile(path) {
  const value = normalized(path)
  if (
    value === ''
    || value.startsWith('/')
    || /^[a-zA-Z]:/u.test(value)
    || value.split('/').includes('..')
    || value.includes('\\')
    || value.includes('\0')
  ) throw new PackageInspectionError(`unsafe package path: ${value || '<empty>'}`)
  return value
}

function parseRule(rule) {
  if (typeof rule !== 'string') throw new PackageInspectionError('non-string files rule')
  const negative = rule.startsWith('!')
  const pattern = negative ? rule.slice(1) : rule
  if (
    pattern === ''
    || pattern.startsWith('/')
    || pattern.split('/').includes('..')
    || pattern.includes('\\')
    || pattern.includes('\0')
    || /[\[\]{}()|]/u.test(pattern)
  ) throw new PackageInspectionError(`unsupported files rule: ${rule || '<empty>'}`)
  return { negative, pattern }
}

function matchesRule(file, pattern, directoryLiteral) {
  if (matchesGlob(file, pattern)) return true
  return directoryLiteral
    && !/[*?]/u.test(pattern)
    && file.startsWith(`${pattern.replace(/\/$/u, '')}/`)
}

function evaluateRules(files, rules, { directoryLiteral = false } = {}) {
  const parsed = rules.map(parseRule)
  if (!parsed.some(rule => !rule.negative)) {
    throw new PackageInspectionError('files rules require an explicit inclusion')
  }
  const included = []
  for (const rawFile of files) {
    const file = validateRelativeFile(rawFile)
    let selected = false
    for (const rule of parsed) {
      if (matchesRule(file, rule.pattern, directoryLiteral)) selected = !rule.negative
    }
    if (selected) included.push(file)
  }
  return [...new Set(included)].sort()
}

export function evaluateBuilderFiles(files, rules) {
  return evaluateRules(files, rules)
}

export function evaluatePackageFiles(files, rules) {
  if (!files.includes('package.json')) throw new PackageInspectionError('installed package has no manifest')
  const evaluated = evaluateRules(files, rules, { directoryLiteral: true })
  if (!evaluated.includes('package.json')) evaluated.push('package.json') // npm always packs its manifest
  return [...new Set(evaluated)].sort()
}

function yamlScalar(value) {
  const stripped = value.trim()
  if (
    (stripped.startsWith('"') && stripped.endsWith('"'))
    || (stripped.startsWith("'") && stripped.endsWith("'"))
  ) return stripped.slice(1, -1)
  return stripped
}

function topLevelYamlList(text, key) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line === `${key}:`)
  if (start < 0) throw new PackageInspectionError(`missing ${key} configuration`)
  const values = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line !== '' && !line.startsWith(' ')) break
    const item = /^  - (.+)$/u.exec(line)?.[1]
    if (item) values.push(yamlScalar(item))
  }
  if (values.length === 0) throw new PackageInspectionError(`empty ${key} configuration`)
  return values
}

function yamlResourceSources(text) {
  return [...text.matchAll(/^\s+- from: (.+)$/gmu)].map(match => yamlScalar(match[1]))
}

async function listFiles(root, { skipTopLevel = [], includeDirectories = false } = {}) {
  const files = []
  const directories = []
  const skipped = new Set(skipTopLevel)
  async function visit(directory, depth) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (depth === 0 && skipped.has(entry.name)) continue
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        if (includeDirectories) {
          directories.push(validateRelativeFile(relative(root, path)))
        }
        await visit(path, depth + 1)
      } else if (entry.isFile()) files.push(validateRelativeFile(relative(root, path)))
      else throw new PackageInspectionError('artifact entry type rejected')
      if (files.length + directories.length > MAX_INSPECTED_FILES) {
        throw new PackageInspectionError(`more than ${MAX_INSPECTED_FILES} files`)
      }
    }
  }
  await visit(root, 0)
  files.sort()
  directories.sort()
  return includeDirectories ? { files, directories } : files
}

function productionDependencyFile(file) {
  const lower = file.toLowerCase()
  const segments = lower.split('/')
  const builderExcludedNames = new Set([
    '.git', '.hg', '.svn', 'cvs', 'rcs', 'sccs', '__pycache__', '.ds_store', 'thumbs.db',
    '.gitignore', '.gitkeep', '.gitattributes', '.npmignore', '.idea', '.vs', '.flowconfig',
    '.jshintrc', '.eslintrc', '.circleci', '.yarn-integrity', '.yarn-metadata.json',
    'yarn-error.log', 'yarn.lock', 'package-lock.json', 'npm-debug.log', 'pnpm-lock.yaml',
    'bun.lock', 'bun.lockb', 'appveyor.yml', '.travis.yml', 'circle.yml', '.nyc_output',
    '.husky', '.github', 'electron-builder.env',
  ])
  return !segments.some(segment => builderExcludedNames.has(segment))
    && !/(?:^|\/)(?:test|tests|__tests__|fixtures|coverage|example|examples|powered-test)(?:\/|$)/u.test(lower)
    && !/\.test\.(?:c?m?js|tsx?)(?:\.map)?$/u.test(lower)
    && !/\.(?:iml|hprof|orig|pyc|pyo|rbc|swp|csproj|sln|suo|xproj|cc|d\.ts|mk|a|o|obj|forge-meta|pdb)$/u.test(lower)
    && !lower.endsWith('.map')
    && !lower.endsWith('.snap')
    && !lower.endsWith('.png')
    && !lower.endsWith('.ts')
    && !lower.endsWith('.cts')
    && !lower.endsWith('.mts')
}

async function readBoundedFile(path, maximumBytes, label) {
  let handle
  try {
    handle = await open(path, 'r')
    const status = await handle.stat()
    if (!status.isFile() || status.size > maximumBytes) {
      throw new PackageInspectionError(`${label} rejected`)
    }
    const body = Buffer.alloc(maximumBytes + 1)
    const { bytesRead } = await handle.read(body, 0, body.byteLength, 0)
    if (bytesRead > maximumBytes) throw new PackageInspectionError(`${label} rejected`)
    return body.subarray(0, bytesRead)
  } catch (error) {
    if (error instanceof PackageInspectionError) throw error
    throw new PackageInspectionError(`${label} unavailable`)
  } finally {
    await handle?.close().catch(() => {})
  }
}

function forbiddenPath(path) {
  const lower = path.toLowerCase()
  return lower.endsWith('.mp4')
    || lower.endsWith('.png')
    || lower.endsWith('.py')
    || lower.endsWith('.ts')
    || lower.endsWith('.cts')
    || lower.endsWith('.mts')
    || lower.endsWith('.map')
    || lower.endsWith('.snap')
    || lower === 'pyproject.toml'
    || lower === 'uv.lock'
    || lower.includes('/nova_audio_agent/')
    || lower.includes('cat-sofa-guard')
    || lower.includes('fake-app-server')
    || /(?:^|\/)(?:test|tests|__tests__|fixtures|coverage)(?:\/|$)/u.test(lower)
    || /\.test\.(?:c?m?js|tsx?|c?m?ts)(?:\.map)?$/u.test(lower)
    || /(?:^|\/)(?:ffmpeg|ffprobe)(?:\.exe)?$/u.test(lower)
    || /(?:^|\/)(?:lib)?(?:avcodec|avdevice|avfilter|avformat|avutil|swresample|swscale)(?:[-.]|$).*(?:\.dylib|\.so(?:\.\d+)*|\.dll)$/u.test(lower)
    || /node_modules\/[^/]*(?:opencv|ffmpeg-static|python-shell|camera|webcam|video[-_]?codec)[^/]*(?:\/|$)/u
      .test(lower)
}

function forbiddenRule(rule) {
  const lower = rule.toLowerCase()
  return lower.includes('assets/')
    || lower.includes('.mp4')
    || lower.includes('cat-sofa')
    || lower.includes('python')
    || lower.includes('opencv')
    || lower.includes('ffmpeg')
}

function forbiddenDependency(name) {
  return /opencv|ffmpeg|python|camera|webcam|video[-_]?codec|avcodec/iu.test(name)
}

function assertDependencyContract(productionDependencies, runtimeDependencies) {
  const production = [...productionDependencies].sort()
  const runtime = [...runtimeDependencies].sort()
  const violations = []
  if (production.length !== 1 || production[0] !== RUNTIME_PACKAGE) {
    violations.push(...production.filter(name => name !== RUNTIME_PACKAGE))
    if (!production.includes(RUNTIME_PACKAGE)) violations.push(RUNTIME_PACKAGE)
  }
  if (
    runtime.length !== EXPECTED_RUNTIME_DEPENDENCIES.length
    || runtime.some((name, index) => name !== EXPECTED_RUNTIME_DEPENDENCIES[index])
  ) {
    violations.push(
      ...EXPECTED_RUNTIME_DEPENDENCIES.filter(name => !runtime.includes(name)),
      ...runtime.filter(name => !EXPECTED_RUNTIME_DEPENDENCIES.includes(name)),
    )
  }
  violations.push(...production.filter(forbiddenDependency), ...runtime.filter(forbiddenDependency))
  if (violations.length > 0) throw new PackageInspectionError([...new Set(violations)].join(', '))
  return { production, runtime }
}

function isPlainJsonObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function manifestDependencies(manifest, expectedName, label) {
  if (!isPlainJsonObject(manifest)) {
    throw new PackageInspectionError(`${label} manifest rejected`)
  }
  if (manifest.name !== expectedName) throw new PackageInspectionError(`${label} manifest rejected`)
  const dependencies = manifest.dependencies ?? {}
  if (!isPlainJsonObject(dependencies)) {
    throw new PackageInspectionError(`${label} manifest dependencies rejected`)
  }
  for (const value of Object.values(dependencies)) {
    if (typeof value !== 'string' || value === '') {
      throw new PackageInspectionError(`${label} manifest dependencies rejected`)
    }
  }
  for (const field of ['optionalDependencies', 'bundledDependencies', 'bundleDependencies']) {
    const value = manifest[field]
    if (value === undefined) continue
    if (Array.isArray(value) && value.length === 0) continue
    if (
      isPlainJsonObject(value)
      && Object.keys(value).length === 0
    ) continue
    throw new PackageInspectionError(`${label} manifest dependency closure rejected`)
  }
  for (const field of ['peerDependencies', 'peerDependenciesMeta']) {
    const value = manifest[field]
    if (value === undefined) continue
    if (isPlainJsonObject(value) && Object.keys(value).length === 0) continue
    throw new PackageInspectionError(`${label} manifest peer closure rejected`)
  }
  return Object.keys(dependencies).sort()
}

function assertRuntimeFilesContract(files, runtimeManifest) {
  if (!Array.isArray(runtimeManifest.files)) {
    throw new PackageInspectionError('runtime manifest files rejected')
  }
  const prefix = `node_modules/${RUNTIME_PACKAGE}/`
  const runtimeFiles = files
    .filter(file => file.startsWith(prefix))
    .map(file => file.slice(prefix.length))
  let selected
  try {
    selected = evaluatePackageFiles(runtimeFiles, runtimeManifest.files)
  } catch {
    throw new PackageInspectionError('runtime manifest files rejected')
  }
  if (!selected.includes('dist/src/desktop-entry.js')) {
    throw new PackageInspectionError('runtime manifest entry rejected')
  }
  const actual = [...new Set(runtimeFiles)].sort()
  if (actual.some(file => !selected.includes(file))) {
    throw new PackageInspectionError('runtime manifest files rejected')
  }
}

function assertAllowedNodeModules(paths, allowedPackages, { directories = false } = {}) {
  for (const path of paths) {
    const segments = path.split('/')
    for (let index = 0; index < segments.length; index += 1) {
      if (segments[index] !== 'node_modules') continue
      const first = segments[index + 1]
      if (first === undefined) {
        if (directories) continue
        throw new PackageInspectionError('unexpected production package')
      }
      if (
        !directories
        && index === 0
        && first === '.package-lock.json'
        && segments.length === 2
      ) continue
      let name = first
      if (first.startsWith('@')) {
        const second = segments[index + 2]
        if (second === undefined) {
          if (directories && [...allowedPackages].some(value => value.startsWith(`${first}/`))) {
            continue
          }
          throw new PackageInspectionError('unexpected production package')
        }
        name = `${first}/${second}`
      }
      if (!name || name.endsWith('/') || !allowedPackages.has(name)) {
        throw new PackageInspectionError(`unexpected production package: ${name || '<invalid>'}`)
      }
    }
  }
}

export function inspectPackagedFileList(includedFiles, {
  desktopManifest,
  runtimeManifest,
  filePatterns = [],
  extraResources = [],
  directories = [],
  selectedPackages = [],
} = {}) {
  const files = [...new Set(includedFiles.map(validateRelativeFile))].sort()
  const artifactDirectories = [...new Set(directories.map(validateRelativeFile))].sort()
  const forbidden = []
  if (!files.includes(DESKTOP_MANIFEST_FILE)) forbidden.push(DESKTOP_MANIFEST_FILE)
  if (!files.includes(RUNTIME_MANIFEST_FILE)) forbidden.push(RUNTIME_MANIFEST_FILE)
  if (!files.includes(REQUIRED_CAMERA_FILE)) forbidden.push(REQUIRED_CAMERA_FILE)
  if (!files.includes(REQUIRED_RUNTIME_FILE)) forbidden.push(REQUIRED_RUNTIME_FILE)
  for (const required of REQUIRED_RUNTIME_DEPENDENCY_FILES) {
    if (!files.includes(required)) forbidden.push(required)
  }
  for (const file of files) if (forbiddenPath(file)) forbidden.push(file)
  for (const rule of [...filePatterns, ...extraResources]) {
    if (forbiddenRule(rule)) forbidden.push(rule)
  }
  const productionDependencies = manifestDependencies(
    desktopManifest,
    DESKTOP_PACKAGE,
    'desktop',
  )
  const runtimeDependencies = manifestDependencies(runtimeManifest, RUNTIME_PACKAGE, 'runtime')
  const dependencies = assertDependencyContract(productionDependencies, runtimeDependencies)
  assertRuntimeFilesContract(files, runtimeManifest)
  const selectedNames = selectedPackages.map(value => value.split('@').slice(0, -1).join('@'))
  const allowedPackages = new Set([
    ...dependencies.production,
    ...dependencies.runtime,
    ...selectedNames,
  ])
  assertAllowedNodeModules(files, allowedPackages)
  assertAllowedNodeModules(
    artifactDirectories,
    allowedPackages,
    { directories: true },
  )
  const uniqueForbidden = [...new Set(forbidden)]
  if (uniqueForbidden.length > 0) throw new PackageInspectionError(uniqueForbidden.join(', '))
  return Object.freeze({
    cameraIncluded: true,
    runtimeIncluded: true,
    includedFiles: Object.freeze(files),
    productionDependencies: Object.freeze(dependencies.production),
    selectedPackages: Object.freeze([...selectedPackages].sort()),
    forbidden: Object.freeze([]),
  })
}

async function findInstalledPackageRoot(packageRoot, name) {
  const require = createRequire(resolve(packageRoot, 'package.json'))
  let current
  try {
    current = dirname(require.resolve(name))
  } catch {
    throw new PackageInspectionError(`production dependency is not installed: ${name}`)
  }
  while (true) {
    try {
      const manifest = parseStrictJson(await readFile(resolve(current, 'package.json'), 'utf8'))
      if (manifest.name === name) return { root: current, manifest }
    } catch { /* continue toward the resolved package root */ }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new PackageInspectionError(`resolved production dependency has no manifest: ${name}`)
}

export async function inspectConfiguredPackage({
  packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  targetId = process.platform === 'darwin'
    ? `darwin-${process.arch}`
    : process.platform === 'win32'
      ? `win32-${process.arch}`
      : `linux-${process.arch}-gnu`,
} = {}) {
  const [builderText, packageText, desktopFiles] = await Promise.all([
    readFile(resolve(packageRoot, 'electron-builder.yml'), 'utf8'),
    readFile(resolve(packageRoot, 'package.json'), 'utf8'),
    listFiles(packageRoot, { skipTopLevel: ['build', 'dist', 'node_modules'] }),
  ])
  const packageJson = parseStrictJson(packageText)
  const filePatterns = topLevelYamlList(builderText, 'files')
  const desktopIncluded = evaluateBuilderFiles(desktopFiles, filePatterns)

  const runtime = await findInstalledPackageRoot(packageRoot, RUNTIME_PACKAGE)
  const runtimeFiles = await listFiles(runtime.root, { skipTopLevel: ['node_modules'] })
  const runtimeIncluded = evaluatePackageFiles(runtimeFiles, runtime.manifest.files ?? [])
    .filter(productionDependencyFile)
    .map(file => `node_modules/${RUNTIME_PACKAGE}/${file}`)
  const repositoryRoot = resolve(packageRoot, '../..')
  const closure = await deriveLockedProductionClosure({
    lockPath: resolve(repositoryRoot, 'package-lock.json'),
    targetId,
  })
  const dependencyIncluded = (await Promise.all(closure.packages
    .filter(value => value.name !== RUNTIME_PACKAGE)
    .map(async value => {
      const dependencyRoot = await realpath(resolve(repositoryRoot, value.installKey))
      const files = await listFiles(dependencyRoot, { skipTopLevel: ['node_modules'] })
      return files.filter(productionDependencyFile).map(file => `${value.installKey}/${file}`)
    }))).flat()

  return inspectPackagedFileList([...desktopIncluded, ...runtimeIncluded, ...dependencyIncluded], {
    desktopManifest: packageJson,
    runtimeManifest: runtime.manifest,
    filePatterns,
    extraResources: yamlResourceSources(builderText),
    selectedPackages: closure.packages.map(value => `${value.name}@${value.version}`),
  })
}

async function readArtifactManifests(artifactRoot, files) {
  if (typeof artifactRoot !== 'string' || artifactRoot === '') {
    throw new PackageInspectionError('artifact root required')
  }
  if (!files.includes(DESKTOP_MANIFEST_FILE) || !files.includes(RUNTIME_MANIFEST_FILE)) {
    throw new PackageInspectionError('artifact manifests missing')
  }
  const parse = async (file, label) => {
    const body = await readBoundedFile(
      resolve(artifactRoot, file),
      MAX_ARTIFACT_MANIFEST_BYTES,
      `${label} manifest`,
    )
    try {
      return parseStrictJson(body.toString('utf8'))
    } catch {
      throw new PackageInspectionError(`${label} manifest malformed`)
    }
  }
  const [desktopManifest, runtimeManifest] = await Promise.all([
    parse(DESKTOP_MANIFEST_FILE, 'desktop'),
    parse(RUNTIME_MANIFEST_FILE, 'runtime'),
  ])
  return { desktopManifest, runtimeManifest }
}

export async function inspectArtifactRoot(artifactRoot) {
  let entries
  try {
    entries = await listFiles(artifactRoot, { includeDirectories: true })
  } catch {
    throw new PackageInspectionError('artifact file list unavailable')
  }
  const manifests = await readArtifactManifests(artifactRoot, entries.files)
  return inspectPackagedFileList(entries.files, { ...manifests, directories: entries.directories })
}

async function readArtifactFileList(path) {
  const body = await readBoundedFile(path, MAX_ARTIFACT_LIST_BYTES, 'artifact file list')
  const text = body.toString('utf8')
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) {
      throw new PackageInspectionError('artifact JSON must be an array of paths')
    }
    return parsed
  } catch (error) {
    if (error instanceof PackageInspectionError) throw error
    return text.split(/\r?\n/u).filter(Boolean)
  }
}

export async function inspectArtifactFileList(fileListPath, artifactRoot) {
  const listed = await readArtifactFileList(fileListPath)
  return await inspectListedArtifactRoot(listed, artifactRoot)
}

async function inspectListedArtifactRoot(listed, artifactRoot, { selectedPackages = [] } = {}) {
  if (typeof artifactRoot !== 'string' || artifactRoot === '') {
    throw new PackageInspectionError('artifact root required')
  }
  if (listed.length > MAX_INSPECTED_FILES) {
    throw new PackageInspectionError(`more than ${MAX_INSPECTED_FILES} artifact entries`)
  }
  const files = []
  const directories = []
  const listPath = value => (
    typeof value === 'string' && (value.startsWith('/') || value.startsWith('\\'))
      ? value.slice(1)
      : value
  )
  for (const entry of new Set(listed.map(listPath).map(validateRelativeFile))) {
    let status
    try {
      status = await lstat(resolve(artifactRoot, entry))
    } catch {
      throw new PackageInspectionError('artifact entry unavailable')
    }
    if (status.isFile()) files.push(entry)
    else if (status.isDirectory()) directories.push(entry)
    else throw new PackageInspectionError('artifact entry type rejected')
  }
  const manifests = await readArtifactManifests(artifactRoot, files)
  return inspectPackagedFileList(files, { ...manifests, directories, selectedPackages })
}

function dependencyReportKeys(record, expected, label) {
  if (
    !isPlainJsonObject(record)
    || Object.keys(record).sort().join('\0') !== [...expected].sort().join('\0')
  ) throw new PackageInspectionError(`${label} rejected`)
}

async function hashDependencyFile(path) {
  let handle
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  } catch {
    throw new PackageInspectionError('production dependency file unavailable')
  }
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size < 0 || before.size > MAX_DEPENDENCY_FILE_BYTES) {
      throw new PackageInspectionError('production dependency file rejected')
    }
    return Object.freeze({
      byte_size: before.size,
      sha256: await hashHandle(handle, before.size, 'production dependency file'),
    })
  } finally {
    await handle.close().catch(() => {})
  }
}

function signingMutableNativeDependency(file) {
  const lower = file.toLowerCase()
  return lower.endsWith('.node')
    || lower.endsWith('.dylib')
    || /\.so(?:\.\d+)*$/u.test(lower)
    || lower.endsWith('.dll')
}

async function dependencyInventory(packageRoot, identity) {
  let files = (await listFiles(packageRoot, { skipTopLevel: ['node_modules'] }))
    .filter(productionDependencyFile)
  if (identity.name === RUNTIME_PACKAGE) {
    let manifest
    try {
      manifest = parseStrictJson(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
      files = evaluatePackageFiles(files, manifest.files ?? []).filter(productionDependencyFile)
    } catch {
      throw new PackageInspectionError('production dependency inventory rejected')
    }
  }
  if (identity.name === '@livekit/agents') {
    files = files.filter(file => !/^resources\/[^/]+\.ogg$/u.test(file))
  }
  const records = []
  for (const file of files.sort()) {
    const hashed = await hashDependencyFile(resolve(packageRoot, file))
    records.push(Object.freeze(signingMutableNativeDependency(file)
      ? {path: file, integrity_owner: 'native_manifest'}
      : {path: file, ...hashed}))
  }
  return Object.freeze({
    files: Object.freeze(records),
    content_sha256: createHash('sha256').update(JSON.stringify(records)).digest('hex'),
  })
}

export async function buildDependencyReport(repositoryRoot, closure) {
  const roots = new Set()
  const packages = []
  for (const identity of [...closure.packages].sort((left, right) => (
    left.installKey < right.installKey ? -1 : left.installKey > right.installKey ? 1 : 0
  ))) {
    const installKey = validateRelativeFile(identity.installKey)
    if (!installKey.startsWith('node_modules/')) {
      throw new PackageInspectionError('production dependency install key rejected')
    }
    let packageRoot
    try {
      packageRoot = await realpath(resolve(repositoryRoot, installKey))
    } catch {
      throw new PackageInspectionError('production dependency unavailable')
    }
    if (roots.has(packageRoot)) {
      throw new PackageInspectionError('production dependency realpath duplicate')
    }
    roots.add(packageRoot)
    const inventory = await dependencyInventory(packageRoot, identity)
    packages.push(Object.freeze({
      install_key: installKey,
      name: identity.name,
      version: identity.version,
      lock_identity_sha256: identity.content_sha256,
      content_sha256: inventory.content_sha256,
      files: inventory.files,
    }))
  }
  return Object.freeze({
    schema_version: 1,
    target: closure.target,
    packages: Object.freeze(packages),
  })
}

function installKeysInArtifact(entries) {
  const keys = new Set()
  for (const entry of entries) {
    const segments = entry.split('/')
    for (let index = 0; index < segments.length; index += 1) {
      if (segments[index] !== 'node_modules') continue
      const first = segments[index + 1]
      if (!first || first === '.bin') continue
      const end = first.startsWith('@') ? index + 3 : index + 2
      if (first.startsWith('@') && !segments[index + 2]) continue
      keys.add(segments.slice(0, end).join('/'))
    }
  }
  return keys
}

export async function assertArtifactDependencyReport(artifactRoot, closure) {
  let parsed
  try {
    const body = await readBoundedFile(
      resolve(artifactRoot, DEPENDENCY_REPORT_FILE),
      MAX_ARTIFACT_LIST_BYTES,
      'dependency report',
    )
    parsed = parseStrictJson(body.toString('utf8'))
  } catch (error) {
    if (error instanceof PackageInspectionError) throw error
    throw new PackageInspectionError('dependency report rejected')
  }
  dependencyReportKeys(parsed, ['schema_version', 'target', 'packages'], 'dependency report')
  if (
    parsed.schema_version !== 1
    || parsed.target !== closure.target
    || !Array.isArray(parsed.packages)
    || parsed.packages.length !== closure.packages.length
  ) {
    throw new PackageInspectionError('dependency report rejected')
  }
  const locked = new Map(closure.packages.map(value => [value.installKey, value]))
  const reported = new Set()
  for (const record of parsed.packages) {
    dependencyReportKeys(record, [
      'install_key', 'name', 'version', 'lock_identity_sha256', 'content_sha256', 'files',
    ], 'dependency report package')
    const identity = locked.get(record.install_key)
    if (
      !identity
      || reported.has(record.install_key)
      || record.name !== identity.name
      || record.version !== identity.version
      || record.lock_identity_sha256 !== identity.content_sha256
      || !/^[0-9a-f]{64}$/u.test(record.content_sha256)
      || !Array.isArray(record.files)
    ) throw new PackageInspectionError('dependency report rejected')
    reported.add(record.install_key)
    const inventory = await dependencyInventory(resolve(artifactRoot, record.install_key), identity)
    if (
      inventory.content_sha256 !== record.content_sha256
      || JSON.stringify(inventory.files) !== JSON.stringify(record.files)
    ) throw new PackageInspectionError('production dependency inventory rejected')
  }
  if ([...locked.keys()].some(installKey => !reported.has(installKey))) {
    throw new PackageInspectionError('dependency report rejected')
  }
  const artifactEntries = await listFiles(artifactRoot, { includeDirectories: true })
  const foundInstallKeys = installKeysInArtifact([
    ...artifactEntries.files,
    ...artifactEntries.directories,
  ])
  if (
    foundInstallKeys.size !== locked.size
    || [...foundInstallKeys].some(installKey => !locked.has(installKey))
  ) {
    throw new PackageInspectionError('production dependency install key rejected')
  }
  return parsed
}

async function copyAndHashHandle(source, destination, expectedSize) {
  const output = await open(destination, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o400)
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let position = 0
  try {
    while (position < expectedSize) {
      const amount = Math.min(buffer.byteLength, expectedSize - position)
      const { bytesRead } = await source.read(buffer, 0, amount, position)
      if (bytesRead === 0) throw new PackageInspectionError('ASAR snapshot changed')
      hash.update(buffer.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, position + written)
        if (result.bytesWritten === 0) throw new PackageInspectionError('ASAR snapshot unavailable')
        written += result.bytesWritten
      }
      position += bytesRead
    }
    await output.sync()
    return hash.digest('hex')
  } finally {
    await output.close().catch(() => {})
  }
}

function readAppImageInteger(buffer, offset, bytes, littleEndian) {
  if (bytes === 2) return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset)
  if (bytes === 4) return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
  if (bytes === 8) {
    const value = littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PackageInspectionError('AppImage ELF layout rejected')
    }
    return Number(value)
  }
  throw new PackageInspectionError('AppImage ELF layout rejected')
}

async function readExactHandle(handle, length, position, detail) {
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const {bytesRead} = await handle.read(buffer, read, length - read, position + read)
    if (bytesRead === 0) throw new PackageInspectionError(detail)
    read += bytesRead
  }
  return buffer
}

export async function captureAppImageFilesystem(sourcePath, destinationPath) {
  let source
  try {
    source = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  } catch {
    throw new PackageInspectionError('AppImage snapshot unavailable')
  }
  try {
    const before = await source.stat()
    if (!before.isFile() || before.size <= 64 || before.size > MAX_CANDIDATE_BYTES) {
      throw new PackageInspectionError('AppImage snapshot rejected')
    }
    const header = await readExactHandle(source, 64, 0, 'AppImage ELF header rejected')
    if (
      !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      || !header.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 0x02]))
      || ![1, 2].includes(header[4])
      || ![1, 2].includes(header[5])
    ) throw new PackageInspectionError('AppImage ELF header rejected')
    const is64 = header[4] === 2
    const littleEndian = header[5] === 1
    const sectionHeaderOffset = readAppImageInteger(header, is64 ? 40 : 32, is64 ? 8 : 4, littleEndian)
    const sectionHeaderSize = readAppImageInteger(header, is64 ? 58 : 46, 2, littleEndian)
    const sectionHeaderCount = readAppImageInteger(header, is64 ? 60 : 48, 2, littleEndian)
    const minimumSectionHeaderSize = is64 ? 64 : 40
    if (
      sectionHeaderOffset < (is64 ? 64 : 52)
      || sectionHeaderSize < minimumSectionHeaderSize
      || sectionHeaderCount < 1
      || sectionHeaderCount > 4096
    ) throw new PackageInspectionError('AppImage ELF layout rejected')
    const sectionTableBytes = sectionHeaderSize * sectionHeaderCount
    const sectionTableEnd = sectionHeaderOffset + sectionTableBytes
    const lastSectionHeaderOffset = sectionTableEnd - sectionHeaderSize
    if (
      !Number.isSafeInteger(sectionTableBytes)
      || !Number.isSafeInteger(sectionTableEnd)
      || lastSectionHeaderOffset < sectionHeaderOffset
      || sectionTableEnd >= before.size
    ) throw new PackageInspectionError('AppImage ELF layout rejected')
    const lastSection = await readExactHandle(
      source,
      minimumSectionHeaderSize,
      lastSectionHeaderOffset,
      'AppImage ELF section rejected',
    )
    const lastSectionOffset = readAppImageInteger(lastSection, is64 ? 24 : 16, is64 ? 8 : 4, littleEndian)
    const lastSectionSize = readAppImageInteger(lastSection, is64 ? 32 : 20, is64 ? 8 : 4, littleEndian)
    const lastSectionEnd = lastSectionOffset + lastSectionSize
    const filesystemOffset = Math.max(sectionTableEnd, lastSectionEnd)
    if (
      !Number.isSafeInteger(lastSectionEnd)
      || !Number.isSafeInteger(filesystemOffset)
      || filesystemOffset <= 0
      || filesystemOffset + 4 >= before.size
    ) throw new PackageInspectionError('AppImage ELF layout rejected')
    const squashfsMagic = await readExactHandle(
      source,
      4,
      filesystemOffset,
      'AppImage filesystem rejected',
    )
    if (!squashfsMagic.equals(Buffer.from('hsqs'))) {
      throw new PackageInspectionError('AppImage filesystem rejected')
    }
    await copyAndHashHandle(
      {
        read: (buffer, offset, length, position) => source.read(
          buffer,
          offset,
          length,
          filesystemOffset + position,
        ),
      },
      destinationPath,
      before.size - filesystemOffset,
    )
    const after = await source.stat()
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      throw new PackageInspectionError('AppImage snapshot changed')
    }
    await chmod(destinationPath, 0o400)
    return Object.freeze({offset: filesystemOffset, size: before.size - filesystemOffset})
  } finally {
    await source?.close().catch(() => {})
  }
}

async function hashHandle(handle, expectedSize, label = 'ASAR snapshot') {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let position = 0
  while (position < expectedSize) {
    const amount = Math.min(buffer.byteLength, expectedSize - position)
    const { bytesRead } = await handle.read(buffer, 0, amount, position)
    if (bytesRead === 0) throw new PackageInspectionError(`${label} changed`)
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return hash.digest('hex')
}

async function preflightAsarHeader(snapshot, archiveSize) {
  let handle
  try {
    handle = await open(snapshot, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const prefix = Buffer.alloc(8)
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
    if (bytesRead !== prefix.length) throw new PackageInspectionError('ASAR header rejected')
    const headerSize = prefix.readUInt32LE(4)
    if (
      prefix.readUInt32LE(0) !== 4
      || headerSize <= 0
      || headerSize > MAX_ASAR_HEADER_BYTES
      || headerSize + 8 > archiveSize
    ) throw new PackageInspectionError('ASAR header rejected')
  } finally {
    await handle?.close().catch(() => {})
  }

  let raw
  let header
  try {
    raw = getRawHeader(snapshot)
    header = parseStrictJson(raw.headerString)
  } catch {
    throw new PackageInspectionError('ASAR header rejected')
  }
  if (
    raw.headerSize <= 0
    || raw.headerSize > MAX_ASAR_HEADER_BYTES
    || !isPlainJsonObject(header)
    || Object.keys(header).join('\0') !== 'files'
    || !isPlainJsonObject(header.files)
  ) throw new PackageInspectionError('ASAR header rejected')

  const unpackedFiles = []
  const packedRanges = []
  let count = 0
  let declaredBytes = 0
  const visit = (files, prefix, depth, inheritedUnpacked = false) => {
    if (depth > 32 || !isPlainJsonObject(files)) {
      throw new PackageInspectionError('ASAR header rejected')
    }
    for (const [name, node] of Object.entries(files)) {
      if (
        name === ''
        || name === '.'
        || name === '..'
        || name.includes('/')
        || name.includes('\\')
        || name.includes('\0')
        || !isPlainJsonObject(node)
      ) throw new PackageInspectionError('ASAR header rejected')
      count += 1
      if (count > MAX_INSPECTED_FILES) throw new PackageInspectionError('ASAR header rejected')
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (node.link !== undefined) throw new PackageInspectionError('ASAR header rejected')
      if (node.files !== undefined) {
        const keys = Object.keys(node).sort().join('\0')
        if (keys !== 'files' && keys !== 'files\0unpacked') {
          throw new PackageInspectionError('ASAR header rejected')
        }
        if (node.unpacked !== undefined && node.unpacked !== true) {
          throw new PackageInspectionError('ASAR header rejected')
        }
        visit(node.files, path, depth + 1, inheritedUnpacked || node.unpacked === true)
        continue
      }
      const keys = Object.keys(node)
      if (
        !keys.includes('size')
        || keys.some(key => !['size', 'offset', 'integrity', 'unpacked', 'executable'].includes(key))
        || !Number.isSafeInteger(node.size)
        || node.size < 0
        || node.size > MAX_ASAR_BYTES
        || (node.executable !== undefined && typeof node.executable !== 'boolean')
      ) throw new PackageInspectionError('ASAR header rejected')
      declaredBytes += node.size
      if (declaredBytes > MAX_ASAR_BYTES) throw new PackageInspectionError('ASAR header rejected')
      const unpacked = inheritedUnpacked || node.unpacked === true
      if (unpacked) {
        if (node.offset !== undefined || (node.unpacked !== undefined && node.unpacked !== true)) {
          throw new PackageInspectionError('ASAR header rejected')
        }
        unpackedFiles.push(path)
        continue
      }
      if (typeof node.offset !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(node.offset)) {
        throw new PackageInspectionError('ASAR header rejected')
      }
      const offset = Number(node.offset)
      if (!Number.isSafeInteger(offset)) throw new PackageInspectionError('ASAR header rejected')
      packedRanges.push({ offset, end: offset + node.size })
    }
  }
  visit(header.files, '', 1)
  const payloadBytes = archiveSize - 8 - raw.headerSize
  packedRanges.sort((left, right) => left.offset - right.offset)
  let priorEnd = 0
  for (const range of packedRanges) {
    if (range.offset < priorEnd || range.end > payloadBytes) {
      throw new PackageInspectionError('ASAR header rejected')
    }
    priorEnd = range.end
  }
  return Object.freeze({ count, unpackedFiles: Object.freeze(unpackedFiles.sort()) })
}

async function snapshotUnpackedTree(sourceRoot, destinationRoot) {
  let rootStatus
  try {
    rootStatus = await lstat(sourceRoot)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({ count: 0, sha256: null, files: Object.freeze([]) })
    }
    throw new PackageInspectionError('ASAR unpacked tree unavailable')
  }
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new PackageInspectionError('ASAR unpacked tree rejected')
  }
  await mkdir(destinationRoot, { mode: 0o700 })
  const records = []
  let totalBytes = 0
  async function visit(sourceDirectory, destinationDirectory, prefix, depth) {
    if (depth > 32) throw new PackageInspectionError('ASAR unpacked tree rejected')
    let entries
    try {
      entries = await readdir(sourceDirectory, { withFileTypes: true })
    } catch {
      throw new PackageInspectionError('ASAR unpacked tree unavailable')
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const relativePath = validateRelativeFile(prefix === '' ? entry.name : `${prefix}/${entry.name}`)
      const sourcePath = resolve(sourceDirectory, entry.name)
      const destinationPath = resolve(destinationDirectory, entry.name)
      if (entry.isSymbolicLink()) throw new PackageInspectionError('ASAR unpacked tree rejected')
      if (entry.isDirectory()) {
        await mkdir(destinationPath, { mode: 0o700 })
        await visit(sourcePath, destinationPath, relativePath, depth + 1)
        continue
      }
      if (!entry.isFile()) throw new PackageInspectionError('ASAR unpacked tree rejected')
      let handle
      try {
        handle = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      } catch {
        throw new PackageInspectionError('ASAR unpacked tree unavailable')
      }
      try {
        const before = await handle.stat()
        if (!before.isFile() || before.size < 0) {
          throw new PackageInspectionError('ASAR unpacked tree rejected')
        }
        totalBytes += before.size
        if (totalBytes > MAX_ASAR_BYTES || records.length >= MAX_INSPECTED_FILES) {
          throw new PackageInspectionError('ASAR unpacked tree rejected')
        }
        const sha256 = await copyAndHashHandle(handle, destinationPath, before.size)
        const after = await handle.stat()
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
          throw new PackageInspectionError('ASAR unpacked tree changed')
        }
        records.push({ path: relativePath, size: before.size, sha256 })
      } finally {
        await handle.close().catch(() => {})
      }
    }
  }
  await visit(sourceRoot, destinationRoot, '', 0)
  const sha256 = createHash('sha256').update(JSON.stringify(records)).digest('hex')
  return Object.freeze({
    count: records.length,
    sha256,
    files: Object.freeze(records.map(record => record.path)),
  })
}

function candidateDeadline() {
  return Date.now() + MAX_CANDIDATE_MILLISECONDS
}

function assertCandidateDeadline(deadline) {
  if (Date.now() > deadline) throw new PackageInspectionError('candidate snapshot timed out')
}

function assertSafeSymlink(relativePath, target) {
  if (
    typeof target !== 'string'
    || target === ''
    || target.includes('\0')
    || target.includes('\\')
    || target.startsWith('/')
  ) throw new PackageInspectionError('candidate snapshot link rejected')
  // Container inventories and link targets always use archive/POSIX syntax,
  // regardless of which host is performing the inspection.
  const sentinel = '/candidate-snapshot'
  const destination = posix.resolve(sentinel, posix.dirname(relativePath), target)
  if (destination !== sentinel && !destination.startsWith(`${sentinel}/`)) {
    throw new PackageInspectionError('candidate snapshot link rejected')
  }
}

async function candidateTreeInventory(root, deadline) {
  const records = []
  let totalBytes = 0
  const visit = async (directory, prefix, depth) => {
    assertCandidateDeadline(deadline)
    if (depth > MAX_CANDIDATE_DEPTH) {
      throw new PackageInspectionError('candidate snapshot depth rejected')
    }
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      throw new PackageInspectionError('candidate snapshot unavailable')
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const relativePath = validateRelativeFile(prefix === '' ? entry.name : `${prefix}/${entry.name}`)
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        records.push({ path: relativePath, type: 'directory' })
        await visit(path, relativePath, depth + 1)
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(path)
        assertSafeSymlink(relativePath, target)
        records.push({
          path: relativePath,
          type: 'link',
          sha256: createHash('sha256').update(target).digest('hex'),
        })
      } else if (entry.isFile()) {
        let handle
        try {
          handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
          const status = await handle.stat()
          if (!status.isFile() || status.size < 0) {
            throw new PackageInspectionError('candidate snapshot file rejected')
          }
          totalBytes += status.size
          if (totalBytes > MAX_CANDIDATE_BYTES) {
            throw new PackageInspectionError('candidate snapshot bytes rejected')
          }
          records.push({
            path: relativePath,
            type: 'file',
            size: status.size,
            sha256: await hashHandle(handle, status.size, 'candidate snapshot file'),
          })
        } finally {
          await handle?.close().catch(() => {})
        }
      } else throw new PackageInspectionError('candidate snapshot entry rejected')
      if (records.length > MAX_CANDIDATE_FILES) {
        throw new PackageInspectionError('candidate snapshot entries rejected')
      }
    }
  }
  await visit(root, '', 0)
  return Object.freeze({
    records: Object.freeze(records),
    sha256: createHash('sha256').update(JSON.stringify(records)).digest('hex'),
  })
}

async function captureCandidateDirectory(sourceRoot, destinationRoot, deadline) {
  const initial = await candidateTreeInventory(sourceRoot, deadline)
  await mkdir(destinationRoot, { mode: 0o700 })
  const copy = async (sourceDirectory, destinationDirectory, prefix, depth) => {
    assertCandidateDeadline(deadline)
    if (depth > MAX_CANDIDATE_DEPTH) {
      throw new PackageInspectionError('candidate snapshot depth rejected')
    }
    const entries = await readdir(sourceDirectory, { withFileTypes: true })
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const relativePath = validateRelativeFile(prefix === '' ? entry.name : `${prefix}/${entry.name}`)
      const sourcePath = resolve(sourceDirectory, entry.name)
      const destinationPath = resolve(destinationDirectory, entry.name)
      if (entry.isDirectory()) {
        await mkdir(destinationPath, { mode: 0o700 })
        await copy(sourcePath, destinationPath, relativePath, depth + 1)
        await chmod(destinationPath, 0o500)
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(sourcePath)
        assertSafeSymlink(relativePath, target)
        await symlink(target, destinationPath)
      } else if (entry.isFile()) {
        let source
        try {
          source = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
          const before = await source.stat()
          if (!before.isFile() || before.size < 0) {
            throw new PackageInspectionError('candidate snapshot file rejected')
          }
          await copyAndHashHandle(source, destinationPath, before.size)
          await chmod(destinationPath, (before.mode & 0o111) === 0 ? 0o400 : 0o500)
          const after = await source.stat()
          const pathAfter = await lstat(sourcePath)
          if (
            after.dev !== before.dev
            || after.ino !== before.ino
            || after.size !== before.size
            || pathAfter.dev !== before.dev
            || pathAfter.ino !== before.ino
            || pathAfter.size !== before.size
          ) throw new PackageInspectionError('candidate snapshot changed')
        } finally {
          await source?.close().catch(() => {})
        }
      } else throw new PackageInspectionError('candidate snapshot entry rejected')
    }
  }
  await copy(sourceRoot, destinationRoot, '', 0)
  await chmod(destinationRoot, 0o500)
  const [sourceAfter, snapshot] = await Promise.all([
    candidateTreeInventory(sourceRoot, deadline),
    candidateTreeInventory(destinationRoot, deadline),
  ])
  if (
    JSON.stringify(sourceAfter.records) !== JSON.stringify(initial.records)
    || JSON.stringify(snapshot.records) !== JSON.stringify(initial.records)
  ) throw new PackageInspectionError('candidate snapshot changed')
  return snapshot
}

async function captureCandidateFile(sourcePath, destinationPath) {
  let source
  try {
    source = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  } catch {
    throw new PackageInspectionError('candidate artifact unavailable')
  }
  try {
    const before = await source.stat()
    if (!before.isFile() || before.size <= 0 || before.size > MAX_CANDIDATE_BYTES) {
      throw new PackageInspectionError('candidate artifact rejected')
    }
    const sha256 = await copyAndHashHandle(source, destinationPath, before.size)
    const after = await source.stat()
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      throw new PackageInspectionError('candidate artifact changed')
    }
    await chmod(destinationPath, 0o400)
    return Object.freeze({ size: before.size, sha256 })
  } finally {
    await source?.close().catch(() => {})
  }
}

function containerListingRejected(reason = '') {
  const error = new PackageInspectionError('candidate container listing rejected')
  if (reason !== '') {
    Object.defineProperty(error, 'diagnosticCode', {value: reason})
  }
  throw error
}

function canonicalContainerPath(path, reason = 'path') {
  if (
    typeof path !== 'string'
    || path === ''
    || path.length > 4096
    || path.includes('\0')
    || /[\u0000-\u001f\u007f]/u.test(path)
    || path.startsWith('/')
    || path.startsWith('\\')
    || /^[a-zA-Z]:/u.test(path)
    || path.startsWith('-')
  ) containerListingRejected(reason)
  const stripped = path.startsWith('./') ? path.slice(2) : path
  const segments = stripped.split(/[\\/]/u)
  if (
    segments.length === 0
    || segments.length > MAX_CANDIDATE_DEPTH
    || segments.some(segment => (
      segment === ''
      || segment === '.'
      || segment === '..'
      || segment.includes(':')
      || segment.endsWith('.')
      || segment.endsWith(' ')
    ))
  ) containerListingRejected(reason)
  return segments.join('/')
}

function boundedListingLines(listing) {
  if (
    typeof listing !== 'string'
    || Buffer.byteLength(listing, 'utf8') > MAX_CONTAINER_LISTING_BYTES
  ) containerListingRejected()
  const lines = listing.split(/\r?\n/u)
  if (
    lines.length > MAX_CONTAINER_LISTING_LINES
    || lines.some(line => Buffer.byteLength(line, 'utf8') > MAX_CONTAINER_LINE_BYTES)
  ) containerListingRejected()
  return lines
}

function parseSevenZipListing(listing) {
  const lines = boundedListingLines(listing)
  const allowedKeys = new Set([
    'Path', 'Size', 'Packed Size', 'Modified', 'Created', 'Accessed', 'Attributes',
    'CRC', 'Encrypted', 'Method', 'Block', 'Folder', 'Host OS', 'Version',
    'Characteristics', 'Offset', 'Physical Size', 'Headers Size', 'Tail Size',
    'Embedded Stub Size', 'SubType', 'Comment', 'Symbolic Link', 'Hard Link',
    'Mode', 'User', 'Group', 'User ID', 'Group ID', 'Device Major', 'Device Minor',
  ])
  const records = []
  let fields = new Map()
  const flush = () => {
    if (fields.size === 0) return
    if (
      (fields.has('Hard Link') && fields.get('Hard Link') !== '')
      || !fields.has('Path')
      || !fields.has('Size')
    ) containerListingRejected('sevenzip-fields')
    const attributes = fields.get('Attributes') ?? fields.get('Mode') ?? ''
    const posixMode = /(?:^|\s)([bcdlps-][rwxStTs-]{9})(?:\s|$)/u.exec(attributes)?.[1]
    const symbolicTarget = fields.get('Symbolic Link') || undefined
    if (
      posixMode !== undefined
      && posixMode[0] !== '-'
      && posixMode[0] !== 'd'
      && posixMode[0] !== 'l'
    ) {
      containerListingRejected('sevenzip-type')
    }
    const folderField = fields.get('Folder')
    if (folderField !== undefined && folderField !== '+' && folderField !== '-') {
      containerListingRejected('sevenzip-folder')
    }
    const folder = folderField === '+'
      || /(?:^|\s)D(?:\s|$)/u.test(attributes)
      || posixMode?.[0] === 'd'
    if (folderField === '-' && folder) containerListingRejected('sevenzip-folder-conflict')
    const listedPath = fields.get('Path')
    const rawPath = folder && /[\\/]$/u.test(listedPath) ? listedPath.slice(0, -1) : listedPath
    if (folder && (rawPath === '' || rawPath === '.')) {
      fields = new Map()
      return
    }
    const path = canonicalContainerPath(rawPath, 'sevenzip-path')
    const rawSize = fields.get('Size')
    if (!/^(?:0|[1-9]\d*)$/u.test(rawSize)) containerListingRejected('sevenzip-size')
    const size = Number(rawSize)
    if (!Number.isSafeInteger(size) || size < 0) containerListingRejected('sevenzip-size')
    const linkAttributes = posixMode?.[0] === 'l' || /(?:^|\s)L(?:\s|$)/u.test(attributes)
    if (symbolicTarget !== undefined || linkAttributes) {
      if (posixMode !== undefined && posixMode[0] !== 'l') {
        containerListingRejected('sevenzip-link')
      }
      if (symbolicTarget !== undefined) assertSafeSymlink(path, symbolicTarget)
      records.push({
        path,
        raw_path: rawPath,
        type: 'link',
        size: 0,
        ...(symbolicTarget === undefined ? {} : { target: symbolicTarget }),
      })
      fields = new Map()
      return
    }
    if (folder && size !== 0) containerListingRejected('sevenzip-folder-size')
    records.push({ path, raw_path: rawPath, type: folder ? 'directory' : 'file', size })
    fields = new Map()
  }
  for (const line of lines) {
    if (line === '') {
      flush()
      continue
    }
    const match = /^([^=]{1,64}) = (.*)$/u.exec(line)
    if (!match || !allowedKeys.has(match[1]) || fields.has(match[1])) {
      containerListingRejected('sevenzip-line')
    }
    fields.set(match[1], match[2])
  }
  flush()
  return records
}

function parseDebListing(listing) {
  const records = []
  for (const line of boundedListingLines(listing)) {
    if (line === '') continue
    const match = /^([bcdlps-][rwxStTs-]{9})\s+\S+\/\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/u.exec(line)
    if (!match || (match[1][0] !== 'd' && match[1][0] !== '-' && match[1][0] !== 'l')) {
      containerListingRejected()
    }
    const directory = match[1][0] === 'd'
    const link = match[1][0] === 'l'
    const linkMatch = link ? /^(.*?) -> (.+)$/u.exec(match[3]) : undefined
    if (link && !linkMatch) containerListingRejected()
    const listedPath = linkMatch?.[1] ?? match[3]
    const rawPath = directory && listedPath.endsWith('/') ? listedPath.slice(0, -1) : listedPath
    if (directory && (rawPath === '' || rawPath === '.')) continue
    const path = canonicalContainerPath(rawPath, 'deb-path')
    const size = Number(match[2])
    if (!Number.isSafeInteger(size) || size < 0 || (directory && size !== 0)) {
      containerListingRejected()
    }
    if (link) {
      const target = linkMatch[2]
      assertSafeSymlink(path, target)
      records.push({ path, raw_path: rawPath, type: 'link', size: 0, target })
    } else {
      records.push({ path, raw_path: rawPath, type: directory ? 'directory' : 'file', size })
    }
  }
  return records
}

export function preflightContainerListing({ format, listing }) {
  const records = format === 'deb'
    ? parseDebListing(listing)
    : format === 'nsis' || format === 'appimage'
      ? parseSevenZipListing(listing)
      : containerListingRejected()
  if (records.length === 0 || records.length > MAX_CONTAINER_ENTRIES) {
    containerListingRejected('entry-count')
  }
  const paths = new Set()
  const collisionKeys = new Set()
  const recordTypes = new Map()
  let expandedBytes = 0
  for (const record of records) {
    const collisionKey = record.path.normalize('NFC').toLowerCase()
    if (paths.has(record.path) || collisionKeys.has(collisionKey)) {
      containerListingRejected('path-collision')
    }
    paths.add(record.path)
    collisionKeys.add(collisionKey)
    recordTypes.set(record.path, record.type)
    expandedBytes += record.size
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_CANDIDATE_BYTES) {
      containerListingRejected('expanded-bytes')
    }
  }
  for (const record of records) {
    const segments = record.path.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      if (recordTypes.get(segments.slice(0, index).join('/')) === 'file') {
        containerListingRejected('file-parent')
      }
    }
  }
  return Object.freeze(records.map(record => Object.freeze(record)))
}

function expectedContainerPaths(records) {
  const expected = new Map()
  for (const record of records) {
    const segments = record.path.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join('/')
      if (!expected.has(parent)) expected.set(parent, { type: 'directory', size: undefined })
    }
    const prior = expected.get(record.path)
    if (prior && prior.type !== record.type) containerListingRejected()
    expected.set(record.path, {
      type: record.type,
      size: record.size,
      sha256: record.type === 'link'
        && record.target !== undefined
        ? createHash('sha256').update(record.target).digest('hex')
        : undefined,
    })
    if (expected.size > MAX_CANDIDATE_FILES) containerListingRejected()
  }
  return expected
}

export async function extractPreflightedContainer({
  format,
  listing,
  destinationRoot,
  extract,
  extractEntry,
}) {
  const records = preflightContainerListing({ format, listing })
  const expected = expectedContainerPaths(records)
  const operation = extract ?? extractEntry
  if (typeof destinationRoot !== 'string' || destinationRoot === '' || typeof operation !== 'function') {
    containerListingRejected()
  }
  await mkdir(destinationRoot, { mode: 0o700 })
  try {
    await operation(records)
    const inventory = await candidateTreeInventory(destinationRoot, candidateDeadline())
    if (inventory.records.length !== expected.size) containerListingRejected()
    for (const actual of inventory.records) {
      const wanted = expected.get(actual.path)
      if (
        !wanted
        || actual.type !== wanted.type
        || (actual.type === 'file' && actual.size !== wanted.size)
        || (actual.type === 'link' && wanted.sha256 !== undefined && actual.sha256 !== wanted.sha256)
      ) containerListingRejected()
    }
    return Object.freeze({ records, sha256: inventory.sha256 })
  } catch (error) {
    if (error instanceof PackageInspectionError) throw error
    throw new PackageInspectionError('candidate container extraction rejected')
  }
}

export function runBoundedListing(command, arguments_, workingDirectory) {
  const result = spawnSync(command, arguments_, {
    cwd: workingDirectory,
    encoding: 'utf8',
    maxBuffer: MAX_CONTAINER_LISTING_BYTES,
    timeout: MAX_CANDIDATE_MILLISECONDS,
    windowsHide: true,
  })
  if (result.error) {
    const code = /^[A-Z0-9_]{1,32}$/u.test(result.error.code ?? '')
      ? result.error.code.toLowerCase().replaceAll('_', '-')
      : 'unknown'
    containerListingRejected(`tool-error-${code}`)
  }
  if (result.status !== 0) {
    const status = Number.isInteger(result.status) && result.status >= 0 && result.status <= 255
      ? result.status
      : 'signal'
    containerListingRejected(`tool-status-${status}`)
  }
  if (typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
    containerListingRejected('tool-output-type')
  }
  if (Buffer.byteLength(result.stdout, 'utf8') > MAX_CONTAINER_LISTING_BYTES) {
    containerListingRejected('tool-stdout-limit')
  }
  if (Buffer.byteLength(result.stderr, 'utf8') > MAX_CONTAINER_LISTING_BYTES) {
    containerListingRejected('tool-stderr-limit')
  }
  boundedListingLines(result.stdout)
  return result.stdout
}

function containerToolRejected() {
  throw new PackageInspectionError('candidate container tool rejected')
}

function assertContainerToolKeys(record, expected) {
  if (
    !isPlainJsonObject(record)
    || Object.keys(record).sort().join('\0') !== [...expected].sort().join('\0')
  ) containerToolRejected()
}

async function readImmutableContainerToolJson(path, maximumBytes) {
  let handle
  try {
    const pathBefore = await lstat(path)
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size > maximumBytes) {
      containerToolRejected()
    }
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const before = await handle.stat()
    if (
      !before.isFile()
      || before.dev !== pathBefore.dev
      || before.ino !== pathBefore.ino
      || before.size !== pathBefore.size
    ) containerToolRejected()
    const buffer = Buffer.alloc(before.size + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)
    const after = await handle.stat()
    const pathAfter = await lstat(path)
    if (
      bytesRead !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || pathAfter.dev !== before.dev
      || pathAfter.ino !== before.ino
      || pathAfter.size !== before.size
    ) containerToolRejected()
    return Object.freeze({
      parsed: parseStrictJson(buffer.subarray(0, bytesRead).toString('utf8')),
      resolvedPath: await realpath(path),
    })
  } catch {
    containerToolRejected()
  } finally {
    await handle?.close().catch(() => {})
  }
}

function assertOwnedContainerToolEntry(status, { directory = false } = {}) {
  if (
    (directory ? !status.isDirectory() : !status.isFile())
    || status.isSymbolicLink()
  ) containerToolRejected()
  if (process.platform !== 'win32') {
    if ((status.mode & 0o022) !== 0) containerToolRejected()
    const uid = process.getuid?.()
    if (uid !== undefined && status.uid !== uid) containerToolRejected()
  }
}

function verifyContainerToolBinary(header, { binary_kind: kind, architecture }) {
  if (kind === 'macho') {
    const cpu = architecture === 'arm64' ? 0x0100000c
      : architecture === 'x64' ? 0x01000007 : -1
    if (header.length < 8 || header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== cpu) {
      containerToolRejected()
    }
    return
  }
  if (kind === 'elf') {
    const machine = architecture === 'x64' ? 62 : -1
    if (
      header.length < 20
      || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      || header[4] !== 2
      || header[5] !== 1
      || header.readUInt16LE(18) !== machine
    ) containerToolRejected()
    return
  }
  if (kind === 'pe') {
    if (header.length < 64 || header[0] !== 0x4d || header[1] !== 0x5a) containerToolRejected()
    const offset = header.readUInt32LE(0x3c)
    const machine = architecture === 'x64' ? 0x8664 : -1
    if (
      offset > header.length - 6
      || header.readUInt32LE(offset) !== 0x00004550
      || header.readUInt16LE(offset + 4) !== machine
    ) containerToolRejected()
    return
  }
  containerToolRejected()
}

export function assertCurrentHostSevenZipBinary(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_CONTAINER_TOOL_BYTES) {
      containerToolRejected()
    }
    const tuple = CONTAINER_TOOL_TUPLES[`${process.platform}-${process.arch}`]
    if (tuple === undefined) containerToolRejected()
    verifyContainerToolBinary(bytes.subarray(0, Math.min(bytes.length, 4096)), {
      ...tuple,
      architecture: process.arch,
    })
    return true
  } catch {
    containerToolRejected()
  }
}

async function verifySnapshottedSevenZipTool(tool) {
  let handle
  try {
    handle = await open(tool.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const status = await handle.stat()
    const pathStatus = await lstat(tool.path)
    if (
      !status.isFile()
      || status.dev !== tool.dev
      || status.ino !== tool.ino
      || status.size !== tool.size
      || pathStatus.dev !== tool.dev
      || pathStatus.ino !== tool.ino
      || pathStatus.size !== tool.size
      || await hashHandle(handle, tool.size, 'candidate container tool') !== tool.sha256
    ) containerToolRejected()
    const header = Buffer.alloc(Math.min(tool.size, 4096))
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    verifyContainerToolBinary(header.subarray(0, bytesRead), tool)
  } catch {
    containerToolRejected()
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function trustedLinuxSystemSevenZip() {
  if (process.platform !== 'linux' || process.arch !== 'x64') containerToolRejected()
  try {
    const resolvedPath = await realpath(LINUX_SYSTEM_SEVEN_ZIP)
    if (!resolvedPath.startsWith('/usr/bin/') && !resolvedPath.startsWith('/usr/lib/')) {
      containerToolRejected()
    }
    const status = await lstat(resolvedPath)
    if (
      !status.isFile()
      || status.isSymbolicLink()
      || status.uid !== 0
      || (status.mode & 0o022) !== 0
      || (status.mode & 0o111) === 0
      || status.size <= 0
      || status.size > MAX_CONTAINER_TOOL_BYTES
    ) containerToolRejected()
    let handle
    try {
      handle = await open(resolvedPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      const opened = await handle.stat()
      if (
        opened.dev !== status.dev
        || opened.ino !== status.ino
        || opened.size !== status.size
      ) containerToolRejected()
      const header = Buffer.alloc(Math.min(status.size, 4096))
      const {bytesRead} = await handle.read(header, 0, header.length, 0)
      verifyContainerToolBinary(header.subarray(0, bytesRead), {
        binary_kind: 'elf',
        architecture: 'x64',
      })
    } finally {
      await handle?.close().catch(() => {})
    }
    return Object.freeze({
      path: resolvedPath,
      dev: status.dev,
      ino: status.ino,
      size: status.size,
    })
  } catch {
    containerToolRejected()
  }
}

async function verifyTrustedLinuxSystemSevenZip(tool) {
  try {
    const status = await lstat(tool.path)
    if (
      !status.isFile()
      || status.isSymbolicLink()
      || status.uid !== 0
      || (status.mode & 0o022) !== 0
      || (status.mode & 0o111) === 0
      || status.dev !== tool.dev
      || status.ino !== tool.ino
      || status.size !== tool.size
    ) containerToolRejected()
  } catch {
    containerToolRejected()
  }
}

export async function snapshotLockedSevenZipTool({
  lockPath = DEFAULT_PACKAGE_LOCK,
  privateRoot,
} = {}) {
  try {
    const manifestPath = CONTAINER_TOOL_MANIFEST
    const platform = process.platform
    const architecture = process.arch
    if (typeof privateRoot !== 'string' || privateRoot === '') containerToolRejected()
    const tuple = CONTAINER_TOOL_TUPLES[`${platform}-${architecture}`]
    if (tuple === undefined) containerToolRejected()
    const [lockDocument, toolDocument] = await Promise.all([
      readImmutableContainerToolJson(lockPath, MAX_ARTIFACT_LIST_BYTES),
      readImmutableContainerToolJson(manifestPath, MAX_ARTIFACT_MANIFEST_BYTES),
    ])
    const lock = lockDocument.parsed
    const manifest = toolDocument.parsed
    assertContainerToolKeys(manifest, ['schema_version', 'package', 'tools'])
    assertContainerToolKeys(manifest.package, ['name', 'version', 'resolved', 'integrity'])
    if (
      manifest.schema_version !== 1
      || !CONTAINER_TOOL_PACKAGE_NAMES.has(manifest.package.name)
      || typeof manifest.package.version !== 'string'
      || typeof manifest.package.resolved !== 'string'
      || typeof manifest.package.integrity !== 'string'
      || !Array.isArray(manifest.tools)
    ) containerToolRejected()
    const tools = new Map()
    for (const record of manifest.tools) {
      assertContainerToolKeys(record, [
        'platform', 'architecture', 'path', 'size', 'sha256', 'binary_kind',
      ])
      const key = `${record.platform}-${record.architecture}`
      const expected = CONTAINER_TOOL_TUPLES[key]
      if (
        expected === undefined
        || tools.has(key)
        || record.path !== expected.path
        || record.binary_kind !== expected.binary_kind
        || !Number.isSafeInteger(record.size)
        || record.size <= 0
        || record.size > MAX_CONTAINER_TOOL_BYTES
        || !/^[0-9a-f]{64}$/u.test(record.sha256)
      ) containerToolRejected()
      tools.set(key, record)
    }
    const selected = tools.get(`${platform}-${architecture}`)
    if (selected === undefined) containerToolRejected()
    if (
      !isPlainJsonObject(lock)
      || lock.lockfileVersion !== 3
      || !isPlainJsonObject(lock.packages)
    ) containerToolRejected()
    const suffix = `/node_modules/${manifest.package.name}`
    const matches = Object.entries(lock.packages).filter(([installKey]) => (
      installKey === `node_modules/${manifest.package.name}` || installKey.endsWith(suffix)
    ))
    if (matches.length !== 1) containerToolRejected()
    const [installKey, lockRecord] = matches[0]
    if (
      validateRelativeFile(installKey) !== installKey
      || !isPlainJsonObject(lockRecord)
      || lockRecord.version !== manifest.package.version
      || lockRecord.resolved !== manifest.package.resolved
      || lockRecord.integrity !== manifest.package.integrity
      || lockRecord.dev !== true
    ) containerToolRejected()
    const lockRoot = dirname(lockDocument.resolvedPath)
    const packagePath = resolve(lockRoot, installKey)
    const packageRoot = await realpath(packagePath)
    if (packageRoot !== packagePath) containerToolRejected()
    assertOwnedContainerToolEntry(await lstat(packageRoot), { directory: true })
    const packageJson = await readImmutableContainerToolJson(
      resolve(packageRoot, 'package.json'),
      MAX_ARTIFACT_MANIFEST_BYTES,
    )
    if (
      packageJson.parsed.name !== manifest.package.name
      || packageJson.parsed.version !== manifest.package.version
    ) containerToolRejected()
    let current = packageRoot
    const segments = selected.path.split('/')
    for (let index = 0; index < segments.length; index += 1) {
      current = resolve(current, segments[index])
      const status = await lstat(current)
      assertOwnedContainerToolEntry(status, {
        directory: index < segments.length - 1,
      })
    }
    const toolRoot = await realpath(current)
    if (toolRoot !== current || !toolRoot.startsWith(`${packageRoot}${sep}`)) containerToolRejected()
    await mkdir(privateRoot, { recursive: true, mode: 0o700 })
    const privateStatus = await lstat(privateRoot)
    assertOwnedContainerToolEntry(privateStatus, { directory: true })
    if ((await readdir(privateRoot)).length !== 0) containerToolRejected()
    const destination = resolve(privateRoot, platform === 'win32' ? '7za.exe' : '7za')
    let source
    try {
      source = await open(toolRoot, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      const before = await source.stat()
      assertOwnedContainerToolEntry(before)
      if (before.size !== selected.size) containerToolRejected()
      const sha256 = await copyAndHashHandle(source, destination, before.size)
      const after = await source.stat()
      const pathAfter = await lstat(toolRoot)
      if (
        sha256 !== selected.sha256
        || after.dev !== before.dev
        || after.ino !== before.ino
        || after.size !== before.size
        || pathAfter.dev !== before.dev
        || pathAfter.ino !== before.ino
        || pathAfter.size !== before.size
      ) containerToolRejected()
    } finally {
      await source?.close().catch(() => {})
    }
    if (process.platform !== 'win32') await chmod(destination, 0o500)
    const snapshotStatus = await lstat(destination)
    const result = Object.freeze({
      path: destination,
      size: selected.size,
      sha256: selected.sha256,
      binary_kind: selected.binary_kind,
      architecture,
      dev: snapshotStatus.dev,
      ino: snapshotStatus.ino,
    })
    await verifySnapshottedSevenZipTool(result)
    return result
  } catch {
    containerToolRejected()
  }
}

function runExtractor(command, arguments_, workingDirectory) {
  const result = spawnSync(command, arguments_, {
    cwd: workingDirectory,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: MAX_CANDIDATE_MILLISECONDS,
    windowsHide: true,
  })
  if (result.status !== 0 || result.error) {
    throw new PackageInspectionError('candidate container extraction rejected')
  }
}

async function extractCandidateContainer(snapshot, format, privateRoot, deadline, lockPath) {
  const raw = resolve(privateRoot, 'container-raw')
  const immutable = resolve(privateRoot, 'container-snapshot')
  if (format === 'dmg') {
    if (process.platform !== 'darwin') {
      throw new PackageInspectionError('candidate container platform rejected')
    }
    const metadata = runBoundedListing(
      '/usr/bin/hdiutil',
      ['imageinfo', '-plist', snapshot],
      privateRoot,
    )
    if (
      !metadata.startsWith('<?xml')
      || !metadata.includes('<plist')
      || !metadata.includes('</plist>')
    ) containerListingRejected()
    const mount = resolve(privateRoot, 'mounted')
    await mkdir(mount, { mode: 0o700 })
    runExtractor('/usr/bin/hdiutil', [
      'attach', snapshot, '-readonly', '-nobrowse', '-mountpoint', mount,
    ], privateRoot)
    try {
      await candidateTreeInventory(mount, deadline)
      const identity = await captureCandidateDirectory(mount, immutable, deadline)
      return Object.freeze({ root: immutable, identity })
    } finally {
      runExtractor('/usr/bin/hdiutil', ['detach', mount, '-force'], privateRoot)
    }
  }
  if (format === 'deb') {
    if (process.platform !== 'linux') {
      throw new PackageInspectionError('candidate container platform rejected')
    }
    const metadata = runBoundedListing('/usr/bin/dpkg-deb', ['--info', snapshot], privateRoot)
    if (
      !/^ new Debian package, version 2\.0\./mu.test(metadata)
      || !/^ Package: [a-z0-9][a-z0-9+.-]*$/mu.test(metadata)
    ) containerListingRejected()
    const listing = runBoundedListing('/usr/bin/dpkg-deb', ['--contents', snapshot], privateRoot)
    await extractPreflightedContainer({
      format,
      listing,
      destinationRoot: raw,
      extract: async () => {
        runExtractor('/usr/bin/dpkg-deb', ['--extract', snapshot, raw], privateRoot)
      },
    })
  } else {
    const systemTool = format === 'appimage'
    const tool = systemTool
      ? await trustedLinuxSystemSevenZip()
      : await snapshotLockedSevenZipTool({
        lockPath,
        privateRoot: resolve(privateRoot, 'container-tool'),
      })
    const verifyTool = systemTool
      ? verifyTrustedLinuxSystemSevenZip
      : verifySnapshottedSevenZipTool
    await verifyTool(tool)
    const containerSnapshot = format === 'appimage'
      ? resolve(privateRoot, 'candidate.squashfs')
      : snapshot
    if (format === 'appimage') {
      await captureAppImageFilesystem(snapshot, containerSnapshot)
    }
    const listing = runBoundedListing(
      tool.path,
      ['l', '-slt', '-ba', '-bd', '--', containerSnapshot],
      privateRoot,
    )
    await verifyTool(tool)
    await extractPreflightedContainer({
      format,
      listing,
      destinationRoot: raw,
      extract: async () => {
        await verifyTool(tool)
        runExtractor(tool.path, ['x', '-bd', '-y', `-o${raw}`, '--', containerSnapshot], privateRoot)
        await verifyTool(tool)
      },
    })
  }
  const identity = await captureCandidateDirectory(raw, immutable, deadline)
  return Object.freeze({ root: immutable, identity })
}

async function locateApplicationResources(applicationRoot, targetId, deadline) {
  const inventory = await candidateTreeInventory(applicationRoot, deadline)
  const expectedSuffix = targetId.startsWith('darwin-')
    ? 'Contents/Resources/app.asar'
    : 'resources/app.asar'
  const archives = inventory.records.filter(record => (
    record.type === 'file'
    && (record.path === expectedSuffix || record.path.endsWith(`/${expectedSuffix}`))
  ))
  const everyAsar = inventory.records.filter(record => (
    record.type === 'file' && basename(record.path) === 'app.asar'
  ))
  if (archives.length !== 1 || everyAsar.length !== 1) {
    throw new PackageInspectionError('candidate application resource tree rejected')
  }
  return resolve(applicationRoot, dirname(archives[0].path))
}

async function requireNativeManifest(resourcesRoot) {
  try {
    const status = await lstat(resolve(resourcesRoot, 'native-resources-v1.json'))
    if (!status.isFile() || status.isSymbolicLink()) throw new Error('invalid')
  } catch {
    throw new PackageInspectionError('native resource manifest missing')
  }
}

async function makePrivateTreeRemovable(root) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw new PackageInspectionError('private candidate cleanup failed')
  }
  await chmod(root, 0o700)
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    await makePrivateTreeRemovable(resolve(root, entry.name))
  }
}

export async function inspectBuiltArtifact(candidatePath, {
  targetId,
  format,
  lockPath = DEFAULT_PACKAGE_LOCK,
} = {}) {
  const targets = await readReleaseTargets()
  const target = targets.targets.find(value => value.id === targetId)
  if (!target || !target.installers.includes(format)) {
    throw new PackageInspectionError('candidate target or format rejected')
  }
  const deadline = candidateDeadline()
  const privateRoot = await mkdtemp(resolve(tmpdir(), 'nova-release-candidate-'))
  let snapshotRoot
  let snapshotIdentity
  let artifactIdentity
  let fileSnapshot
  try {
    let status
    try {
      status = await lstat(candidatePath)
    } catch {
      throw new PackageInspectionError('candidate artifact unavailable')
    }
    if (format === 'app') {
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new PackageInspectionError('candidate application rejected')
      }
      snapshotRoot = resolve(privateRoot, 'application-snapshot')
      artifactIdentity = await captureCandidateDirectory(candidatePath, snapshotRoot, deadline)
      snapshotIdentity = artifactIdentity
    } else {
      if (!status.isFile() || status.isSymbolicLink()) {
        throw new PackageInspectionError('candidate installer rejected')
      }
      const expectedExtension = format === 'dmg' ? '.dmg'
        : format === 'nsis' ? '.exe'
          : format === 'appimage' ? '.AppImage' : '.deb'
      if (!candidatePath.endsWith(expectedExtension)) {
        throw new PackageInspectionError('candidate installer format rejected')
      }
      fileSnapshot = resolve(privateRoot, `candidate${expectedExtension}`)
      artifactIdentity = await captureCandidateFile(candidatePath, fileSnapshot)
      const container = await extractCandidateContainer(
        fileSnapshot,
        format,
        privateRoot,
        deadline,
        lockPath,
      )
      snapshotRoot = container.root
      snapshotIdentity = container.identity
    }
    const resourcesRoot = await locateApplicationResources(snapshotRoot, targetId, deadline)
    await requireNativeManifest(resourcesRoot)
    const report = await inspectAsarSnapshot(resolve(resourcesRoot, 'app.asar'), {
      targetId,
      lockPath,
      resourcesRoot,
      requireNative: true,
    })
    const snapshotAfter = await candidateTreeInventory(snapshotRoot, deadline)
    if (snapshotAfter.sha256 !== snapshotIdentity.sha256) {
      throw new PackageInspectionError('candidate snapshot changed')
    }
    if (format !== 'app') {
      const handle = await open(fileSnapshot, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      try {
        if (await hashHandle(handle, artifactIdentity.size, 'candidate artifact') !== artifactIdentity.sha256) {
          throw new PackageInspectionError('candidate artifact changed')
        }
      } finally {
        await handle.close().catch(() => {})
      }
    }
    return Object.freeze({
      schema_version: 1,
      result_code: 'passed',
      target: targetId,
      format,
      artifact_sha256: artifactIdentity.sha256,
      asar_sha256: report.asar_sha256,
      unpacked_sha256: report.unpacked_sha256,
      file_count: report.file_count,
      native_resource_count: report.native_resource_count,
      dependency_report_sha256: report.dependency_report_sha256,
      dependency_identities: report.dependency_identities,
      native_manifest_sha256: report.native_manifest_sha256,
      native_resources: report.native_resources,
    })
  } finally {
    await makePrivateTreeRemovable(privateRoot)
    await rm(privateRoot, { recursive: true, force: true })
    try {
      await lstat(privateRoot)
      throw new PackageInspectionError('private candidate cleanup failed')
    } catch (error) {
      if (error instanceof PackageInspectionError) throw error
      if (error?.code !== 'ENOENT') throw new PackageInspectionError('private candidate cleanup failed')
    }
  }
}

export async function inspectAsarSnapshot(archivePath, {
  targetId,
  lockPath = DEFAULT_PACKAGE_LOCK,
  resourcesRoot,
  requireNative = false,
} = {}) {
  if (typeof archivePath !== 'string' || archivePath === '' || basename(archivePath) === '') {
    throw new PackageInspectionError('ASAR artifact required')
  }
  const privateRoot = await mkdtemp(resolve(tmpdir(), 'nova-release-asar-'))
  const snapshot = resolve(privateRoot, 'app.asar')
  const extracted = resolve(privateRoot, 'extracted')
  let source
  try {
    try {
      source = await open(archivePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    } catch {
      throw new PackageInspectionError('ASAR artifact unavailable')
    }
    const before = await source.stat()
    if (!before.isFile() || before.size <= 0 || before.size > MAX_ASAR_BYTES) {
      throw new PackageInspectionError('ASAR artifact rejected')
    }
    const asarSha256 = await copyAndHashHandle(source, snapshot, before.size)
    const afterCopy = await source.stat()
    if (afterCopy.dev !== before.dev || afterCopy.ino !== before.ino || afterCopy.size !== before.size) {
      throw new PackageInspectionError('ASAR artifact changed')
    }
    await source.close()
    source = undefined
    await chmod(snapshot, 0o400)
    const header = await preflightAsarHeader(snapshot, before.size)
    const unpacked = await snapshotUnpackedTree(`${archivePath}.unpacked`, `${snapshot}.unpacked`)
    if (!sameArray(header.unpackedFiles, unpacked.files)) {
      throw new PackageInspectionError('ASAR unpacked tree rejected')
    }

    let listed
    try {
      listed = listPackage(snapshot)
      if (listed.length !== header.count) throw new PackageInspectionError('ASAR header rejected')
      extractAll(snapshot, extracted)
    } catch (error) {
      if (error instanceof PackageInspectionError) throw error
      throw new PackageInspectionError('ASAR snapshot rejected')
    }
    const snapshotHandle = await open(snapshot, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    let verifiedHash
    try {
      const snapshotStatus = await snapshotHandle.stat()
      if (!snapshotStatus.isFile() || snapshotStatus.size !== before.size) {
        throw new PackageInspectionError('ASAR snapshot changed')
      }
      verifiedHash = await hashHandle(snapshotHandle, before.size)
    } finally {
      await snapshotHandle.close().catch(() => {})
    }
    if (verifiedHash !== asarSha256) throw new PackageInspectionError('ASAR snapshot changed')
    let selectedPackages = []
    let dependencyReport
    let nativeResourceCount = 0
    let nativeManifestSha256 = null
    let nativeResources = []
    if (targetId !== undefined) {
      const closure = await deriveLockedProductionClosure({ lockPath, targetId })
      dependencyReport = await assertArtifactDependencyReport(extracted, closure)
      selectedPackages = closure.packages.map(value => `${value.name}@${value.version}`)
    }
    const inspected = await inspectListedArtifactRoot(listed, extracted, { selectedPackages })
    if (requireNative) {
      if (typeof resourcesRoot !== 'string' || resourcesRoot === '') {
        throw new PackageInspectionError('native resource root required')
      }
      try {
        const native = await verifyNativeResourceManifest({ resourcesRoot, targetId, dependencyReport })
        nativeResourceCount = native.resource_count
        nativeManifestSha256 = native.manifest_sha256
        nativeResources = native.resources
      } catch (error) {
        if (error instanceof NativeResourceError) {
          throw new PackageInspectionError(error.code.replaceAll('_', ' '))
        }
        throw error
      }
    }
    return Object.freeze({
      asar_sha256: asarSha256,
      cameraIncluded: inspected.cameraIncluded,
      runtimeIncluded: inspected.runtimeIncluded,
      file_count: inspected.includedFiles.length,
      unpacked_file_count: unpacked.count,
      unpacked_sha256: unpacked.sha256,
      native_resource_count: nativeResourceCount,
      native_manifest_sha256: nativeManifestSha256,
      native_resources: nativeResources,
      dependency_report_sha256: dependencyReport === undefined
        ? null
        : createHash('sha256').update(JSON.stringify(dependencyReport)).digest('hex'),
      dependency_identities: dependencyReport === undefined
        ? Object.freeze([])
        : Object.freeze(dependencyReport.packages.map(record => Object.freeze({
          install_key: record.install_key,
          name: record.name,
          version: record.version,
          content_sha256: record.content_sha256,
        }))),
      productionDependencies: inspected.productionDependencies,
    })
  } finally {
    await source?.close().catch(() => {})
    await rm(privateRoot, { recursive: true, force: true })
    try {
      await lstat(privateRoot)
      throw new PackageInspectionError('private extraction cleanup failed')
    } catch (error) {
      if (error instanceof PackageInspectionError) throw error
      if (error?.code !== 'ENOENT') throw new PackageInspectionError('private extraction cleanup failed')
    }
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  const run = process.argv.length === 2
    ? inspectConfiguredPackage()
    : process.argv.length === 8
      && process.argv[2] === '--artifact'
      && process.argv[4] === '--target'
      && process.argv[6] === '--format'
      ? inspectBuiltArtifact(process.argv[3], {
        targetId: process.argv[5],
        format: process.argv[7],
      })
    : Promise.reject(new PackageInspectionError(
      'release inspection requires one produced artifact',
    ))
  run.then(
    result => process.stdout.write(`${JSON.stringify(result)}\n`),
    error => {
      process.stderr.write(`${error instanceof Error ? error.message : 'package inspection failed'}\n`)
      process.exitCode = 1
    },
  )
}
