import assert from 'node:assert/strict'
import {join} from 'node:path'
import {test} from 'node:test'
import {ESLint} from 'eslint'

const repositoryRoot = join(import.meta.dirname, '../../..')
const CORE_PROBE = 'runtime/src/boundary-negative-probe.ts'
const EXECUTOR_PROBE = 'runtime/src/executors/codex/eslint-boundary-negative.ts'
/** Probes are linted in memory (never written under `runtime/src`, which the parity audit scans concurrently). */
const eslint = new ESLint({
  overrideConfigFile: join(repositoryRoot, 'eslint.config.mjs'),
  cwd: repositoryRoot,
  overrideConfig: {
    languageOptions: {
      parserOptions: {projectService: {allowDefaultProject: [CORE_PROBE, EXECUTOR_PROBE]}, tsconfigRootDir: repositoryRoot},
    },
  },
})

async function lintVirtual(relativePath: string, source: string) {
  const results = await eslint.lintText(source, {filePath: join(repositoryRoot, relativePath)})
  return results[0]?.messages.filter(message => message.ruleId === 'no-restricted-imports') ?? []
}

test('eslint blocks core imports of a concrete executor package', async () => {
  const violations = await lintVirtual(CORE_PROBE, "import {CodexAdapter} from './executors/codex/adapter.js'\n")
  assert.ok(violations.length > 0, violations.map(item => item.message).join('; '))
})

test('eslint blocks executor imports of the realtime layer', async () => {
  const violations = await lintVirtual(EXECUTOR_PROBE, "import {RealtimeService} from '../../realtime/service.js'\n")
  assert.ok(violations.length > 0, violations.map(item => item.message).join('; '))
})
