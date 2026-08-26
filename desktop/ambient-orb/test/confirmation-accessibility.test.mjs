import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { deriveOrbState } from '../src/renderer/state.mjs'

test('visual countdown ticks never change the accessible confirmation wording', () => {
  const input = {
    booting: false,
    activated: true,
    capture: 'idle',
    playback: 'idle',
    codex: 'idle',
    connected: true,
    error: '',
    audioMode: 'voice_processing_io',
    pendingConfirmation: true,
    pendingAction: 'create_workspace',
    pendingWorkspace: 'alpha',
    pendingSession: '',
  }
  const atNinety = deriveOrbState({...input, pendingExpiresInSeconds: 90})
  const atEightyNine = deriveOrbState({...input, pendingExpiresInSeconds: 89})

  assert.equal(atNinety.accessibleCodexLabel, atEightyNine.accessibleCodexLabel)
  assert.doesNotMatch(atNinety.accessibleCodexLabel, /\d/u)
})

test('only semantic confirmation status is live and the visual expiry is hidden from assistive tech', async () => {
  const html = await readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
  const shell = html.match(/<main id="shell"[^>]*>/u)?.[0] ?? ''

  assert.doesNotMatch(shell, /aria-live/u)
  assert.match(html, /id="state-label"[^>]*role="status"[^>]*aria-live="polite"/u)
  assert.match(html, /id="codex-expiry" aria-hidden="true"/u)
  assert.match(
    html,
    /id="confirmation-announcement" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"/u,
  )
})
