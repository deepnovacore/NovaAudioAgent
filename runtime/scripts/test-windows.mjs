import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// These mixed suites still depend on POSIX permissions/process/filesystem behavior.
// Keep the inventory explicit until target-native Windows validation closes each gap;
// their individual Windows cases are also excluded by this file-level filter.
const posixTests = new Set([
  'codex-credential-snapshot.test.js',
  'codex-host-config.test.js',
  'codex-process-owner.test.js',
  'codex-project-store.test.js',
  'knowledge-store.test.js',
  'realtime-telemetry.test.js',
])
const directory = resolve(import.meta.dirname, '../dist/test')
const tests = readdirSync(directory)
  .filter(file => file.endsWith('.test.js') && !posixTests.has(file))
  .map(file => resolve(directory, file))
const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
