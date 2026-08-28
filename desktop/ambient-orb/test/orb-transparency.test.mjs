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

test('confirmation card keeps its decision and expiry visible for long targets at 150% zoom', {
  skip: process.platform !== 'darwin',
}, async () => {
  const { stdout } = await execFileAsync(electron, [probe], {
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    timeout: 15_000,
  })
  const result = JSON.parse(stdout.trim().split('\n').at(-1))

  for (const layout of result.confirmationLayouts) {
    const tolerance = 0.75
    assert.ok(layout.card.left >= -tolerance, `${layout.zoomFactor}: card left`)
    assert.ok(layout.card.right <= layout.viewport.width + tolerance, `${layout.zoomFactor}: card right`)
    assert.ok(layout.orb.top >= -tolerance, `${layout.zoomFactor}: orb top`)
    assert.ok(layout.card.bottom <= layout.viewport.height + tolerance, `${layout.zoomFactor}: card bottom`)
    assert.ok(layout.actions.left >= layout.card.left - tolerance, `${layout.zoomFactor}: actions left`)
    assert.ok(layout.actions.right <= layout.card.right + tolerance, `${layout.zoomFactor}: actions right`)
    assert.ok(layout.confirm.bottom <= layout.card.bottom + tolerance, `${layout.zoomFactor}: confirm bottom`)
    assert.ok(layout.cancel.bottom <= layout.card.bottom + tolerance, `${layout.zoomFactor}: cancel bottom`)
    assert.equal(layout.cancel.color, 'rgb(255, 119, 127)', `${layout.zoomFactor}: cancel is red`)
    assert.ok(
      layout.operation.scrollWidth > layout.operation.clientWidth,
      `${layout.zoomFactor}: the long target must be visibly ellipsized`,
    )
    assert.ok(
      layout.expiry.scrollWidth <= layout.expiry.clientWidth,
      `${layout.zoomFactor}: expiry must remain complete`,
    )
  }
})
