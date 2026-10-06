import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const electron = require('electron')
// Cold Electron startup plus all scale/edge layouts can exceed 15 seconds on CI.
const probeTimeout = 30_000
const probe = fileURLToPath(new URL('../scripts/orb-transparency-probe.cjs', import.meta.url))

async function runProbe() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'nova-orb-launch-'))
  try {
    for (const name of ['home', 'codex', 'tmp']) await mkdir(join(root, name), { mode: 0o700 })
    const { stdout } = await execFileAsync(electron, [probe], { timeout: probeTimeout, env: {
      PATH: '/opt/homebrew/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8',
      HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), CODEX_HOME: join(root, 'codex'), TMPDIR: join(root, 'tmp'),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    } })
    const result = JSON.parse(stdout.trim().split('\n').at(-1)), { isolation } = result
    assert.ok(isolation.fixtureRoot.startsWith(join(root, 'tmp') + sep))
    assert.equal((await stat(isolation.fixtureRoot)).mode & 0o777, 0o700)
    assert.deepEqual(Object.keys(isolation.paths), ['home', 'appData', 'userData', 'temp', 'cache', 'logs', 'sessionData', 'crashDumps'])
    for (const [name, path] of Object.entries(isolation.paths)) {
      assert.equal(path, join(isolation.fixtureRoot, name))
      assert.equal((await stat(path)).mode & 0o777, 0o700)
    }
    assert.equal(isolation.persistent, false)
    assert.deepEqual(isolation.preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, preloadLoaded: true })
    // Chromium checks availability on each of the three page loads; all return false.
    assert.deepEqual(isolation.permissionChecks, { media: 6, 'web-app-installation': 3, geolocation: 3 })
    assert.ok(isolation.credentialMethods.includes('isEncryptionAvailable'))
    assert.deepEqual(isolation.denied, { credentials: 0, network: 0, permissions: 0, windows: 0, navigation: 0 })
    return result
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

test('message reservations keep the full orb inside the native window at screen edges', {
  skip: process.platform !== 'darwin',
}, async () => {
  const result = await runProbe()
  const natural = result.naturalProject
  assert.ok(natural['codex-label'].top >= natural['state-label'].bottom)
  assert.ok(natural['codex-label'].top >= natural['orb-rail'].bottom, 'restored workspace must clear controls')
  assert.ok(natural['codex-label'].bottom <= 160)
  for (const layout of result.bubbleLayouts) {
    assert.equal(layout.actual.width, layout.expected.width)
    assert.equal(layout.actual.height, layout.expected.height)
    assert.ok(layout.orb.left >= -0.75 && layout.orb.right <= layout.width + 0.75)
    assert.ok(layout.orb.top >= -0.75 && layout.orb.bottom <= layout.height + 0.75)
    const project = layout.surfaces.find(surface => surface.selector === '#codex-label')
    const status = layout.surfaces.find(surface => surface.selector === '#state-label')
    assert.ok(project.top >= status.bottom, 'workspace banner must stay below status')
    assert.equal(layout.placement, 'above')
    assert.equal(layout.tail.content, '""')
    assert.ok(Math.abs(layout.tail.x - (layout.orb.left + layout.orb.width / 2)) <= 0.75, 'tail must point at orb center')
    assert.ok(Math.abs(layout.tail.bottom - layout.orb.top) <= 0.75, 'tail must touch orb')
    for (const [index, a] of layout.surfaces.entries()) {
      assert.ok(a.left >= -0.75 && a.right <= layout.width + 0.75, `${a.selector} clipped horizontally`)
      assert.ok(a.top >= -0.75 && a.bottom <= layout.height + 0.75, `${a.selector} clipped vertically`)
      for (const b of layout.surfaces.slice(index + 1)) {
        assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
          `${a.selector} overlaps ${b.selector}`)
      }
    }
  }
})

test('transparent orb renders without an outer shadow', {
  skip: process.platform !== 'darwin',
}, async () => {
  const result = await runProbe()

  assert.equal(result.boxShadow, 'none')
})

test('the dormant bubble stays centred in the shrunken window', {
  skip: process.platform !== 'darwin',
}, async () => {
  const result = await runProbe()
  const layout = result.dormantLayout

  // The window shrinks around its centre, so the drawing has to agree. #shell
  // centres its tracks vertically but not horizontally, and once the window is
  // narrower than the orb's 98px column that column overflows to the right
  // instead of straddling the centre — which parked the bubble ~28px off-axis
  // until a dormancy-scoped justify-content fixed it.
  assert.ok(
    Math.abs(layout.orbCenterX - layout.shellCenterX) <= 0.75,
    `bubble is off the horizontal centre: ${layout.orbCenterX} vs ${layout.shellCenterX}`,
  )
  assert.ok(
    Math.abs(layout.orbCenterY - layout.shellCenterY) <= 0.75,
    `bubble is off the vertical centre: ${layout.orbCenterY} vs ${layout.shellCenterY}`,
  )
  // display, not opacity: a merely transparent pill would still claim a grid
  // row and push the disc back off the centre it was just aligned to.
  assert.equal(layout.stateDisplay, 'none')
  // The real width, not a scaled transform: a transform leaves the 98px layout
  // box for the 64px window to clip into a square with two hard corners, and
  // border-radius computed on that untouched box cannot round it back.
  assert.equal(layout.orbWidth, 40)
  // The capture dot is sized for the full disc: 11px of it covers 28% of a
  // 40px bubble, which reads as a blemish rather than an indicator. Resting
  // has nothing for it to report — the mic is not capturing.
  assert.equal(layout.indicatorDisplay, 'none')

  // A resting orb is the bubble and nothing else. Asserted over every sibling
  // rather than a named few: the shell has six that each appear on their own
  // schedule, and the workspace pill reached production hanging under a 40px
  // bubble precisely because the rule that hid them was a list.
  const visible = Object.entries(layout.siblingDisplays)
    .filter(([, display]) => display !== 'none')
    .map(([id]) => id)
  assert.deepEqual(visible, [], `resting must show only the disc, but showed: ${visible}`)
  assert.ok(
    Object.keys(layout.siblingDisplays).length >= 5,
    'the fixture must actually carry the siblings this is guarding',
  )
})

test('bubble mode outranks resting so a stale attribute cannot hide the orb', {
  skip: process.platform !== 'darwin',
}, async () => {
  const result = await runProbe()
  const collided = result.dormantWithBubbles

  // Bubble mode absolutely positions the orb against coordinates computed for
  // its full size while resting shrinks it, and the two selectors carry equal
  // specificity — so whichever came later in the stylesheet would win. With
  // both attributes set the orb must stay full size, or a stale data-dormant
  // renders as a 40px disc at 98px coordinates: an orb that looks gone.
  assert.equal(collided.orbWidth, 98)
  assert.equal(collided.orbHeight, 98)
})

test('the standby states yield their softened styling to high contrast', {
  skip: process.platform !== 'darwin',
}, async () => {
  const result = await runProbe()
  const { normal, highContrast } = result.standbyStyles

  // Normally the two standby states recede: a fainter rim and a less opaque
  // ground than idle's, and disconnected carries the amber semantic colour.
  assert.equal(normal.idle.orbBorderColor, 'rgba(255, 255, 255, 0.07)')
  for (const state of ['muted', 'disconnected']) {
    assert.equal(normal[state].orbBorderColor, 'rgba(255, 255, 255, 0.04)', `${state} rim`)
    assert.equal(normal[state].orbBackground, 'rgba(7, 6, 11, 0.72)', `${state} ground`)
  }
  assert.equal(normal.muted.labelColor, 'rgb(245, 245, 247)')
  assert.equal(normal.disconnected.labelColor, 'rgb(240, 192, 122)')

  // Under prefers-contrast the fallback must win outright. These selectors
  // out-specify the plain #orb rule, so without explicit neutralization the
  // standby states would keep a 4%-opaque rim while the canvas that draws
  // their only other boundary is hidden — leaving no visible edge at all.
  // With the canvas hidden, #orb::after is the orb's entire content under this
  // media query. Its inset is a fixed margin sized for the 98px box, so
  // resting's 40px box left a 2px speck inside an empty white ring until the
  // inset was scoped. Assert the disc keeps a usable share of whatever box it
  // is in rather than a fixed pixel size.
  const { natural, resting } = result.contrastDiscSizes
  for (const [label, sample] of [['natural', natural], ['resting', resting]]) {
    const box = Number.parseFloat(sample.box)
    const disc = Number.parseFloat(sample.disc)
    assert.ok(disc >= box * 0.4, `${label}: disc ${disc}px is lost inside a ${box}px orb`)
  }
  assert.ok(
    Number.parseFloat(resting.box) < Number.parseFloat(natural.box),
    'the resting sample must actually be the shrunken box',
  )

  for (const state of ['idle', 'muted', 'disconnected']) {
    assert.equal(highContrast[state].orbBorderColor, 'rgb(255, 255, 255)', `${state} rim`)
    assert.equal(highContrast[state].orbBorderWidth, '2px', `${state} rim width`)
    assert.equal(highContrast[state].orbBackground, 'rgb(0, 0, 0)', `${state} ground`)
    assert.equal(highContrast[state].labelColor, 'rgb(255, 255, 255)', `${state} label`)
  }
})

test('transparent orb hides every secondary text row', {
  skip: process.platform !== 'darwin',
}, async () => {
  const result = await runProbe()

  assert.deepEqual(result.secondaryDisplays, {
    'codex-label': 'none',
    'aec-label': 'none',
    caption: 'none',
  })
})

test('confirmation capsule keeps a natural orb and compact controls visible through 150% zoom', {
  skip: process.platform !== 'darwin',
}, async () => {
  const result = await runProbe()

  for (const layout of result.confirmationLayouts) {
    const tolerance = 0.75
    assert.equal(layout.controls.length, 4)
    for (const button of layout.controls) {
      assert.ok(button.top >= -tolerance && button.bottom <= layout.viewport.height + tolerance, `${button.id} clipped vertically`)
      assert.ok(button.left >= -tolerance && button.right <= layout.viewport.width + tolerance, `${button.id} clipped horizontally`)
      assert.ok(button.bottom <= layout.card.top || button.top >= layout.card.bottom, `${button.id} overlaps approval`)
      assert.equal(button.hit, button.id, `${button.id} must receive pointer input`)
    }
    assert.ok(layout.card.left >= -tolerance, `${layout.zoomFactor}: card left`)
    assert.ok(layout.card.right <= layout.viewport.width + tolerance, `${layout.zoomFactor}: card right`)
    assert.ok(layout.orb.top >= -tolerance, `${layout.zoomFactor}: orb top`)
    assert.ok(Math.abs(layout.orb.width - 98) <= tolerance, `${layout.zoomFactor}: orb width`)
    assert.ok(Math.abs(layout.orb.height - 98) <= tolerance, `${layout.zoomFactor}: orb height`)
    assert.ok(layout.card.bottom <= layout.viewport.height + tolerance, `${layout.zoomFactor}: card bottom`)
    assert.ok(Math.abs(layout.card.height - 48) <= tolerance, `${layout.zoomFactor}: capsule height`)
    assert.equal(layout.card.borderRadius, '999px', `${layout.zoomFactor}: capsule radius`)
    assert.equal(layout.state.display, 'none', `${layout.zoomFactor}: duplicate state pill hidden`)
    assert.ok(layout.actions.left >= layout.card.left - tolerance, `${layout.zoomFactor}: actions left`)
    assert.ok(layout.actions.right <= layout.card.right + tolerance, `${layout.zoomFactor}: actions right`)
    assert.ok(layout.confirm.bottom <= layout.card.bottom + tolerance, `${layout.zoomFactor}: confirm bottom`)
    assert.ok(layout.cancel.bottom <= layout.card.bottom + tolerance, `${layout.zoomFactor}: cancel bottom`)
    assert.equal(layout.cancel.color, 'rgb(255, 119, 127)', `${layout.zoomFactor}: cancel is red`)
    assert.ok(
      layout.operation.scrollWidth > layout.operation.clientWidth,
      `${layout.zoomFactor}: the long target must be visibly ellipsized`,
    )
    assert.ok(layout.expiry.scrollWidth <= layout.expiry.clientWidth, `${layout.zoomFactor}: compact expiry`)
  }
})
