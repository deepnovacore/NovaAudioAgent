import { createRequire } from 'node:module'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, matchesGlob, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNTIME_PACKAGE = '@nova-audio-agent/runtime'
const REQUIRED_CAMERA_FILE = 'src/renderer/camera.mjs'
const REQUIRED_RUNTIME_FILE = `node_modules/${RUNTIME_PACKAGE}/dist/src/desktop-entry.js`
const EXPECTED_RUNTIME_DEPENDENCIES = Object.freeze(['ws', 'zod'])
const REQUIRED_RUNTIME_DEPENDENCY_FILES = Object.freeze(
  EXPECTED_RUNTIME_DEPENDENCIES.map(name => `node_modules/${name}/package.json`),
)
const MAX_INSPECTED_FILES = 10_000
const MAX_ARTIFACT_LIST_BYTES = 4 * 1024 * 1024

export class PackageInspectionError extends Error {
  constructor(detail) {
    super(`desktop package contract rejected: ${detail}`)
    this.name = 'PackageInspectionError'
  }
}

function normalized(path) {
  return path.split(sep).join('/').replace(/^\.\//u, '')
}

function validateRelativeFile(path) {
  const value = normalized(path)
  if (
    value === ''
    || value.startsWith('/')
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

async function listFiles(root, { skipTopLevel = [] } = {}) {
  const files = []
  const skipped = new Set(skipTopLevel)
  async function visit(directory, depth) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (depth === 0 && skipped.has(entry.name)) continue
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await visit(path, depth + 1)
      else if (entry.isFile()) files.push(validateRelativeFile(relative(root, path)))
      if (files.length > MAX_INSPECTED_FILES) {
        throw new PackageInspectionError(`more than ${MAX_INSPECTED_FILES} files`)
      }
    }
  }
  await visit(root, 0)
  return files.sort()
}

function forbiddenPath(path) {
  const lower = path.toLowerCase()
  return lower.endsWith('.mp4')
    || lower.endsWith('.py')
    || lower === 'pyproject.toml'
    || lower === 'uv.lock'
    || lower.includes('/nova_audio_agent/')
    || lower.includes('cat-sofa-guard')
    || /(?:^|\/)(?:ffmpeg|opencv)(?:$|[._/-])/u.test(lower)
    || /node_modules\/[^/]*(?:opencv|ffmpeg|python|camera|webcam|video[-_]?codec)[^/]*(?:\/|$)/u
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

export function inspectPackagedFileList(includedFiles, {
  productionDependencies = [RUNTIME_PACKAGE],
  runtimeDependencies = EXPECTED_RUNTIME_DEPENDENCIES,
  filePatterns = [],
  extraResources = [],
} = {}) {
  const files = [...new Set(includedFiles.map(validateRelativeFile))].sort()
  const forbidden = []
  if (!files.includes(REQUIRED_CAMERA_FILE)) forbidden.push(REQUIRED_CAMERA_FILE)
  if (!files.includes(REQUIRED_RUNTIME_FILE)) forbidden.push(REQUIRED_RUNTIME_FILE)
  for (const required of REQUIRED_RUNTIME_DEPENDENCY_FILES) {
    if (!files.includes(required)) forbidden.push(required)
  }
  for (const file of files) if (forbiddenPath(file)) forbidden.push(file)
  for (const rule of [...filePatterns, ...extraResources]) {
    if (forbiddenRule(rule)) forbidden.push(rule)
  }
  const dependencies = assertDependencyContract(productionDependencies, runtimeDependencies)
  const uniqueForbidden = [...new Set(forbidden)]
  if (uniqueForbidden.length > 0) throw new PackageInspectionError(uniqueForbidden.join(', '))
  return Object.freeze({
    cameraIncluded: true,
    runtimeIncluded: true,
    includedFiles: Object.freeze(files),
    productionDependencies: Object.freeze(dependencies.production),
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
      const manifest = JSON.parse(await readFile(resolve(current, 'package.json'), 'utf8'))
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
} = {}) {
  const [builderText, packageText, desktopFiles] = await Promise.all([
    readFile(resolve(packageRoot, 'electron-builder.yml'), 'utf8'),
    readFile(resolve(packageRoot, 'package.json'), 'utf8'),
    listFiles(packageRoot, { skipTopLevel: ['build', 'dist', 'node_modules'] }),
  ])
  const packageJson = JSON.parse(packageText)
  const productionDependencies = Object.keys(packageJson.dependencies ?? {}).sort()
  const filePatterns = topLevelYamlList(builderText, 'files')
  const desktopIncluded = evaluateBuilderFiles(desktopFiles, filePatterns)

  const runtime = await findInstalledPackageRoot(packageRoot, RUNTIME_PACKAGE)
  const runtimeFiles = await listFiles(runtime.root, { skipTopLevel: ['node_modules'] })
  const runtimeIncluded = evaluatePackageFiles(runtimeFiles, runtime.manifest.files ?? [])
    .map(file => `node_modules/${RUNTIME_PACKAGE}/${file}`)
  const runtimeDependencies = Object.keys(runtime.manifest.dependencies ?? {}).sort()
  const dependencyIncluded = (await Promise.all(runtimeDependencies.map(async name => {
    const dependency = await findInstalledPackageRoot(runtime.root, name)
    const files = await listFiles(dependency.root, { skipTopLevel: ['node_modules'] })
    return files.map(file => `node_modules/${name}/${file}`)
  }))).flat()

  return inspectPackagedFileList([...desktopIncluded, ...runtimeIncluded, ...dependencyIncluded], {
    productionDependencies,
    runtimeDependencies,
    filePatterns,
    extraResources: yamlResourceSources(builderText),
  })
}

async function readArtifactFileList(path) {
  const body = await readFile(path)
  if (body.byteLength > MAX_ARTIFACT_LIST_BYTES) {
    throw new PackageInspectionError('artifact file list exceeds four MiB')
  }
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

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  const run = process.argv.length === 2
    ? inspectConfiguredPackage()
    : process.argv.length === 4 && process.argv[2] === '--file-list'
      ? readArtifactFileList(process.argv[3]).then(inspectPackagedFileList)
      : Promise.reject(new PackageInspectionError('usage: inspect-package [--file-list path]'))
  run.then(
    result => process.stdout.write(`${JSON.stringify(result)}\n`),
    error => {
      process.stderr.write(`${error instanceof Error ? error.message : 'package inspection failed'}\n`)
      process.exitCode = 1
    },
  )
}
