import {createHash} from 'node:crypto'
import {readdir, readFile, writeFile} from 'node:fs/promises'
import {extname, relative, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import ts from 'typescript'

const mode = process.argv[2]
if (mode !== '--check' && mode !== '--write') {
  process.stderr.write('Usage: node runtime/scripts/node-parity-audit.mjs --check|--write\n')
  process.exitCode = 2
} else {
  const runtimeRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const repositoryRoot = resolve(runtimeRoot, '..')
  const manifestPath = resolve(runtimeRoot, 'node-parity-audit.json')
  const sourceFiles = [
    ...await sourceTree(resolve(runtimeRoot, 'src'), new Set(['.ts'])),
    ...await sourceTree(resolve(repositoryRoot, 'desktop/ambient-orb/src'), new Set(['.js', '.mjs', '.ts'])),
  ].filter(path => relative(repositoryRoot, path) !== 'runtime/src/unicode-tables.ts')
    .sort(compareStrings)
  const configPath = resolve(runtimeRoot, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, runtimeRoot, {
    allowJs: true,
    checkJs: false,
    noEmit: true,
  }, configPath)
  const program = ts.createProgram({rootNames: sourceFiles, options: parsed.options})
  const checker = program.getTypeChecker()
  const occurrences = []
  for (const absolute of sourceFiles) {
    const source = program.getSourceFile(absolute)
    if (source === undefined) throw new Error(`typed audit source unavailable: ${absolute}`)
    const file = relative(repositoryRoot, absolute).replaceAll('\\', '/')
    visitSource(source, checker, file, occurrences)
  }
  const files = sourceFiles.map(path => relative(repositoryRoot, path).replaceAll('\\', '/'))
  const current = {schema_version: 1, files, occurrences}
  if (mode === '--write') {
    const document = {
      ...current,
      occurrences: occurrences.map(occurrence => ({
        ...occurrence,
        disposition: defaultDisposition(occurrence.kind),
        test: 'runtime/test/node-parity-audit.test.ts',
      })),
    }
    await writeFile(manifestPath, `${JSON.stringify(document, null, 2)}\n`)
    process.stdout.write(`wrote Node parity audit: ${files.length} files, ${occurrences.length} occurrences\n`)
  } else {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    validateManifest(manifest, current)
    process.stdout.write(`Node parity audit passed: ${files.length} files, ${occurrences.length} occurrences\n`)
  }
}

async function sourceTree(root, extensions) {
  const files = []
  for (const entry of await readdir(root, {withFileTypes: true})) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) files.push(...await sourceTree(path, extensions))
    else if (entry.isFile() && extensions.has(extname(entry.name))) files.push(path)
  }
  return files
}

function visitSource(source, checker, file, output) {
  let occurrenceIndex = 0
  const add = (kind, node) => {
    const snippet = node.getText(source)
    output.push({
      file,
      kind,
      occurrence_index: occurrenceIndex,
      snippet_sha256: createHash('sha256').update(snippet).digest('hex'),
    })
    occurrenceIndex += 1
  }
  const visit = node => {
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text
      if (name === 'length' && isStringType(checker.getTypeAtLocation(node.expression))) {
        add('string_length', node)
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const target = node.expression.expression
      const method = node.expression.name.text
      if (isStringType(checker.getTypeAtLocation(target))) {
        if (method === 'trim') add('string_trim', node)
        if (['localeCompare', 'toLocaleLowerCase', 'toLocaleUpperCase', 'toLowerCase', 'toUpperCase', 'normalize'].includes(method)) {
          add('locale_unicode', node)
        }
      }
      if (['toFixed', 'toPrecision', 'toExponential'].includes(method)
        && isNumberType(checker.getTypeAtLocation(target))) add('number_format', node)
      if (ts.isIdentifier(target) && target.text === 'Intl' && method === 'NumberFormat') {
        add('number_format', node)
      }
      if (ts.isIdentifier(target) && target.text === 'JSON' && method === 'stringify'
        && /(?:prompt|evidence)/u.test(file)) add('raw_json', node)
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'String' && node.arguments.length > 0
      && isNumberType(checker.getTypeAtLocation(node.arguments[0]))) add('numeric_string', node)
    if (ts.isTemplateSpan(node) && isNumberType(checker.getTypeAtLocation(node.expression))) {
      add('numeric_template', node.expression)
    }
    if (ts.isRegularExpressionLiteral(node) && /\\p\{/u.test(node.text)) {
      add('unicode_property_regex', node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

function isStringType(type) {
  if (type.isUnion()) return type.types.every(isStringType)
  return (type.flags & ts.TypeFlags.StringLike) !== 0
}

function isNumberType(type) {
  if (type.isUnion()) return type.types.every(isNumberType)
  return (type.flags & ts.TypeFlags.NumberLike) !== 0
}

function defaultDisposition(kind) {
  if (kind === 'string_length') return 'intentional_utf16'
  if (kind === 'string_trim' || kind === 'locale_unicode' || kind === 'unicode_property_regex') {
    return 'host_only_unicode'
  }
  return 'wire_json'
}

function validateManifest(manifest, current) {
  if (manifest?.schema_version !== 1 || !Array.isArray(manifest.files)
    || !Array.isArray(manifest.occurrences)) throw new Error('invalid Node parity audit manifest')
  if (JSON.stringify(manifest.files) !== JSON.stringify(current.files)) {
    throw new Error('Node parity audit source-file inventory changed')
  }
  const allowed = new Set(['byte_length', 'array_length', 'wire_json', 'host_only_unicode', 'intentional_utf16'])
  if (manifest.occurrences.length !== current.occurrences.length) {
    throw new Error('Node parity audit occurrence count changed')
  }
  for (let index = 0; index < current.occurrences.length; index += 1) {
    const expected = manifest.occurrences[index]
    const actual = current.occurrences[index]
    for (const field of ['file', 'kind', 'occurrence_index', 'snippet_sha256']) {
      if (expected?.[field] !== actual[field]) throw new Error(`Node parity audit drift: ${actual.file}`)
    }
    if (!allowed.has(expected.disposition) || typeof expected.test !== 'string' || expected.test === '') {
      throw new Error(`invalid Node parity audit disposition: ${actual.file}`)
    }
  }
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
