import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('renderer clears captions on disconnect and on every playback clear', async () => {
  const source = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  // The assistant caption clears before the racy clear() verdict, never inside it.
  assert.match(
    source,
    /if \(message\.type === 'playback\.clear'\) \{\n    clearAssistantCaption\(\)/,
  )
  // A dead socket must not leave speculative text on screen.
  const disconnectHandler = source.slice(
    source.indexOf('onCurrentClose: ({socket: closedSocket}) => {'),
    source.indexOf('const backendRecovery = new BackendReconnectController'),
  )
  assert.match(disconnectHandler, /playback\.disconnect\(\)/)
  assert.match(disconnectHandler, /clearCaption\(\)/)
  // Continuous speech keeps refreshing the floor hold with the same utterance id.
  assert.match(source, /new OnsetTracker\(/)
})

test('renderer stops the guard tone before replacement PCM and local onset', async () => {
  const source = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  assert.match(source, /message\.type === 'playback\.alert'/)
  const handler = source.indexOf('async function handleSocketMessage(event, delivery)')
  const toneStop = source.indexOf('alertTone.stop()', handler)
  const decode = source.indexOf('decodeAudioFrame', handler)
  assert.ok(handler >= 0 && toneStop > handler && decode > toneStop)
  assert.match(source, /if \(verdict\) \{\n    alertTone\.stop\(\)\n    send\(/)
})

test('renderer accepts the closed public Codex project message', async () => {
  const source = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  assert.match(source, /message\.type === 'codex\.project'/)
  assert.match(source, /workspace_display_name/)
  assert.match(source, /pending_confirmation/)
  assert.match(source, /pending_confirmation_id/)
  assert.match(source, /pending_confirmation_busy/)
  assert.match(source, /ConfirmationDecisionController/)
  assert.match(source, /windowLayout\.setConfirmationMode\(state\.confirmationVisible\)/u)
  assert.match(source, /shell\.dataset\.confirmationPlacement = placement/u)
  const markup = await readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
  assert.match(markup, /id="codex-confirm"[^>]*aria-label="确认工作区操作"/u)
  assert.match(markup, /id="codex-cancel"[^>]*aria-label="取消工作区操作"/u)
  assert.match(source, /pending_action/)
  assert.match(source, /pending_workspace_display_name/)
  assert.match(source, /pending_expires_in_seconds/)
  assert.match(source, /\[\.\.\.workspace\]\.length <= 120/)
  assert.match(source, /\[\.\.\.session\]\.length <= 120/)
  assert.match(source, /const PROJECT_CONFIRMATION_TTL_SECONDS = 360/)
  assert.match(source, /pendingExpires <= PROJECT_CONFIRMATION_TTL_SECONDS/)
  assert.match(source, /setText\(codexSummary, state\.projectLabel\)/)
  assert.match(source, /codexLabel\.dataset\.mode = state\.codexMode/)
  assert.match(source, /setAttribute\(codexLabel, 'aria-label', state\.codexLabel\)/u)
})

test('confirmation uses a fixed natural orb and a compact text-section capsule', async () => {
  const css = await readFile(new URL('../src/renderer/index.css', import.meta.url), 'utf8')

  assert.doesNotMatch(css, /#shell:has\(#codex-label\[data-mode='confirmation'\]\)[\s\S]{0,220}clamp\(/u)
  assert.doesNotMatch(css, /@media \(max-height:[\s\S]{0,260}#orb[\s\S]{0,100}display:\s*none/u)
  assert.match(css, /#codex-label\[data-mode='confirmation'\]\s*\{[^}]*height:\s*48px;[^}]*border-radius:\s*999px;/su)
  assert.match(css, /#codex-label\[data-mode='confirmation'\] #codex-operation\s*\{[^}]*white-space:\s*nowrap;[^}]*text-overflow:\s*ellipsis;/su)
  assert.match(css, /#shell:has\(#codex-label\[data-mode='confirmation'\]\) #state-label\s*\{[^}]*display:\s*none;/su)
})
