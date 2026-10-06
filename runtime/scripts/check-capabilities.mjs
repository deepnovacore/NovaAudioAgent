import {readFile, writeFile} from 'node:fs/promises'
import ts from 'typescript'
const source = new URL('../src/config/capability-registry.ts', import.meta.url)
const target = new URL('../../cli/src/capability-registry.mjs', import.meta.url)
const output = '// Generated from runtime/src/config/capability-registry.ts; run node runtime/scripts/check-capabilities.mjs --write.\n'
  + ts.transpileModule(await readFile(source, 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext},
  }).outputText
// The CLI has no dependencies, so the desktop key probe is copied rather than imported.
const probeSource = new URL('../../clients/desktop/src/main/key-probe.mjs', import.meta.url)
const probeTarget = new URL('../../cli/src/key-probe.mjs', import.meta.url)
const probeOutput = '// Generated from clients/desktop/src/main/key-probe.mjs; run node runtime/scripts/check-capabilities.mjs --write.\n'
  + await readFile(probeSource, 'utf8')
if (process.argv[2] === '--write') {
  await writeFile(target, output)
  await writeFile(probeTarget, probeOutput)
} else if (await readFile(target, 'utf8') !== output) throw new Error('CLI capability validator is stale; run node runtime/scripts/check-capabilities.mjs --write')
else if (await readFile(probeTarget, 'utf8').catch(() => '') !== probeOutput) throw new Error('CLI key probe is stale; run node runtime/scripts/check-capabilities.mjs --write')
else process.stdout.write('Shared capability validator drift check passed\n')
