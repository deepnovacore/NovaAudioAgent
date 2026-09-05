import {readFile, writeFile} from 'node:fs/promises'
import ts from 'typescript'
const source = new URL('../src/capability-registry.ts', import.meta.url)
const target = new URL('../../cli/src/capability-registry.mjs', import.meta.url)
const output = '// Generated from runtime/src/capability-registry.ts; run node runtime/scripts/check-capabilities.mjs --write.\n'
  + ts.transpileModule(await readFile(source, 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext},
  }).outputText
if (process.argv[2] === '--write') await writeFile(target, output)
else if (await readFile(target, 'utf8') !== output) throw new Error('CLI capability validator is stale; run node runtime/scripts/check-capabilities.mjs --write')
else process.stdout.write('Shared capability validator drift check passed\n')
