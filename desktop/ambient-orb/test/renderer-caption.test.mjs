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
  assert.match(source, /socket\.onclose = \(\) => \{[^}]*clearCaption\(\)/s)
  // Continuous speech keeps refreshing the floor hold with the same utterance id.
  assert.match(source, /new OnsetTracker\(/)
})

test('renderer stops the guard tone before replacement PCM and local onset', async () => {
  const source = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  assert.match(source, /message\.type === 'playback\.alert'/)
  const handler = source.indexOf('async function handleSocketMessage(event)')
  const toneStop = source.indexOf('alertTone.stop()', handler)
  const decode = source.indexOf('decodeAudioFrame', handler)
  assert.ok(handler >= 0 && toneStop > handler && decode > toneStop)
  assert.match(source, /if \(verdict\) \{\n    alertTone\.stop\(\)\n    send\(/)
})

test('renderer serializes replacement PCM behind native alert clear acknowledgement', async () => {
  const source = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')

  assert.match(source, /let socketMessageTail = Promise\.resolve\(\)/)
  assert.match(
    source,
    /socketMessageTail = socketMessageTail\.then\(\(\) => handleSocketMessage\(event\)\)/,
  )
  assert.match(source, /async function handleSocketMessage\(event\)/)
  assert.match(source, /await handleControl\(JSON\.parse\(event\.data\)\)/)
})
