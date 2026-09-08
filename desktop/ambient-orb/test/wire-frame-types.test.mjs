import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {WIRE_FRAME_TYPES as runtimeTypes} from '@nova-audio-agent/runtime/desktop'
import * as renderer from '../src/renderer/wire-frame-types.mjs'
import {wireFrameTypesSource} from '../scripts/build-contract.mjs'

test('generated browser wire set equals the runtime and every type has a renderer consumer', async () => {
  assert.deepEqual(new Set(renderer.WIRE_FRAME_TYPES), new Set(runtimeTypes))
  assert.equal(renderer.WIRE_FRAME_TYPES.length, new Set(runtimeTypes).size)
  assert.equal(await readFile(new URL('../src/renderer/wire-frame-types.mjs', import.meta.url), 'utf8'),
    wireFrameTypesSource(runtimeTypes), 'regenerate with the desktop build')
  const source = (await Promise.all(['index', 'confirmation-controls', 'bubbles', 'camera'].map(name =>
    readFile(new URL(`../src/renderer/${name}.mjs`, import.meta.url), 'utf8')))).join('\n')
  const consumed = consumedTypes(source)
  // desktop.ready is the transport bootstrap marker; the orb intentionally ignores its payload.
  assert.deepEqual(consumed, new Set(runtimeTypes.filter(type => type !== renderer.DESKTOP_READY)), 'a renamed or unhandled frame must fail the contract')
})

function consumedTypes(source) {
  const comparisons = [...source.matchAll(/(?:message|frame|parsed\.value)\.type\s*[!=]==\s*(['"][^'"]+['"]|[A-Z_]+)/g)]
  return new Set(comparisons.map(([, type]) => {
    assert.ok(!/^['"]/.test(type), `unshared wire discriminant: ${type}`)
    assert.equal(typeof renderer[type], 'string', `unknown wire constant: ${type}`)
    return renderer[type]
  }))
}

test('wire coverage refuses a literal branch or unknown constant instead of silently ignoring it', () => {
  assert.throws(() => consumedTypes("message.type === 'future.frame'"), /unshared wire discriminant/)
  assert.throws(() => consumedTypes('frame.type !== UNKNOWN_WIRE_FRAME'), /unknown wire constant/)
})
