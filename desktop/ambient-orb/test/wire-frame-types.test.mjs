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
  const source = (await Promise.all(['index', 'confirmation-controls', 'bubbles'].map(name =>
    readFile(new URL(`../src/renderer/${name}.mjs`, import.meta.url), 'utf8')))).join('\n')
  const consumed = new Set([...source.matchAll(/\.type\s*[!=]==\s*([A-Z_]+)/g)].map(match => renderer[match[1]]))
  assert.deepEqual(consumed, new Set(runtimeTypes), 'a renamed or unhandled frame must fail the contract')
})
