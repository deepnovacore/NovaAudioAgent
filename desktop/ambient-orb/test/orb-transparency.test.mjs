import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const electron = require('electron')
const probe = fileURLToPath(new URL('../scripts/orb-transparency-probe.cjs', import.meta.url))

test('transparent orb renders without an outer shadow', {
  skip: process.platform !== 'darwin',
}, async () => {
  const { stdout } = await execFileAsync(electron, [probe], {
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    timeout: 15_000,
  })
  const result = JSON.parse(stdout.trim().split('\n').at(-1))

  assert.equal(result.boxShadow, 'none')
})

test('transparent orb hides every secondary text row', {
  skip: process.platform !== 'darwin',
}, async () => {
  const { stdout } = await execFileAsync(electron, [probe], {
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    timeout: 15_000,
  })
  const result = JSON.parse(stdout.trim().split('\n').at(-1))

  assert.deepEqual(result.secondaryDisplays, {
    'codex-label': 'none',
    'aec-label': 'none',
    caption: 'none',
  })
})
