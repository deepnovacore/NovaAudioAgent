import { readdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNTIME_PACKAGE = '@nova-audio-agent/runtime'
const REQUIRED_CAMERA_FILE = 'src/renderer/camera.mjs'
const REQUIRED_RUNTIME_FILE = `node_modules/${RUNTIME_PACKAGE}/dist/src/desktop-entry.js`
const MAX_INSPECTED_FILES = 10_000

export class PackageInspectionError extends Error {
  constructor(detail) {
    super(`desktop package contract rejected: ${detail}`)
    this.name = 'PackageInspectionError'
  }
}

function normalized(path) {
  return path.split(sep).join('/')
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
  if (start < 0) return []
  const values = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line !== '' && !line.startsWith(' ')) break
    const item = /^  - (.+)$/u.exec(line)?.[1]
    if (item) values.push(yamlScalar(item))
  }
  return values
}

function yamlResourceSources(text) {
  return [...text.matchAll(/^\s+- from: (.+)$/gmu)].map(match => yamlScalar(match[1]))
}

async function listFiles(root) {
  const files = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(normalized(relative(root, path)))
      if (files.length > MAX_INSPECTED_FILES) {
        throw new PackageInspectionError(`more than ${MAX_INSPECTED_FILES} files`)
      }
    }
  }
  await visit(root)
  return files
}

function forbiddenPath(path) {
  const lower = path.toLowerCase()
  return lower.endsWith('.mp4')
    || lower.endsWith('.py')
    || lower === 'pyproject.toml'
    || lower === 'uv.lock'
    || lower.includes('/nova_audio_agent/')
    || lower.includes('cat-sofa-guard')
    || /(?:^|\/)(?:python|ffmpeg|opencv)(?:$|[._/-])/u.test(lower)
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

export function inspectPackageGraph(graph) {
  const includedFiles = [...graph.includedFiles]
  const filePatterns = [...graph.filePatterns]
  const extraResources = [...graph.extraResources]
  const dependencies = Object.keys(graph.dependencies).sort()
  const runtimeDependencies = Object.keys(graph.runtimePackage.dependencies).sort()
  const forbidden = []

  if (!includedFiles.includes(REQUIRED_CAMERA_FILE)) forbidden.push(REQUIRED_CAMERA_FILE)
  if (!includedFiles.includes(REQUIRED_RUNTIME_FILE)) forbidden.push(REQUIRED_RUNTIME_FILE)
  for (const file of includedFiles) if (forbiddenPath(file)) forbidden.push(file)
  for (const rule of [...filePatterns, ...extraResources]) {
    if (forbiddenRule(rule)) forbidden.push(rule)
  }
  if (dependencies.length !== 1 || dependencies[0] !== RUNTIME_PACKAGE) {
    forbidden.push(...dependencies.filter(name => name !== RUNTIME_PACKAGE))
    if (!dependencies.includes(RUNTIME_PACKAGE)) forbidden.push(RUNTIME_PACKAGE)
  }
  for (const name of dependencies) if (forbiddenDependency(name)) forbidden.push(name)
  const expectedRuntimeDependencies = ['ws', 'zod']
  if (
    runtimeDependencies.length !== expectedRuntimeDependencies.length
    || runtimeDependencies.some((name, index) => name !== expectedRuntimeDependencies[index])
  ) {
    forbidden.push(...runtimeDependencies.filter(name => !expectedRuntimeDependencies.includes(name)))
  }
  for (const name of runtimeDependencies) if (forbiddenDependency(name)) forbidden.push(name)
  if (!graph.runtimePackage.files.includes('dist/src')) forbidden.push('runtime:dist/src')

  const uniqueForbidden = [...new Set(forbidden)]
  if (uniqueForbidden.length > 0) throw new PackageInspectionError(uniqueForbidden.join(', '))
  return Object.freeze({
    cameraIncluded: true,
    runtimeIncluded: true,
    productionDependencies: Object.freeze(dependencies),
    forbidden: Object.freeze([]),
  })
}

export async function inspectConfiguredPackage({
  packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
} = {}) {
  const repositoryRoot = resolve(packageRoot, '../..')
  const runtimeRoot = resolve(repositoryRoot, 'runtime')
  const [builderText, packageText, runtimePackageText, sourceFiles] = await Promise.all([
    readFile(resolve(packageRoot, 'electron-builder.yml'), 'utf8'),
    readFile(resolve(packageRoot, 'package.json'), 'utf8'),
    readFile(resolve(runtimeRoot, 'package.json'), 'utf8'),
    listFiles(resolve(packageRoot, 'src')),
  ])
  const packageJson = JSON.parse(packageText)
  const runtimePackage = JSON.parse(runtimePackageText)
  await readFile(resolve(runtimeRoot, 'dist/src/desktop-entry.js'), 'utf8')

  const includedFiles = sourceFiles.map(file => `src/${file}`)
  includedFiles.push('package.json', REQUIRED_RUNTIME_FILE)
  return inspectPackageGraph({
    includedFiles,
    filePatterns: topLevelYamlList(builderText, 'files'),
    extraResources: yamlResourceSources(builderText),
    dependencies: packageJson.dependencies ?? {},
    runtimePackage: {
      files: runtimePackage.files ?? [],
      dependencies: runtimePackage.dependencies ?? {},
    },
  })
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  inspectConfiguredPackage().then(
    result => process.stdout.write(`${JSON.stringify(result)}\n`),
    error => {
      process.stderr.write(`${error instanceof Error ? error.message : 'package inspection failed'}\n`)
      process.exitCode = 1
    },
  )
}
