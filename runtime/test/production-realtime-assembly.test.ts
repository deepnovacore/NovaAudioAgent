import assert from 'node:assert/strict'
import {test} from 'node:test'

import {ConfigurationError, loadSettings, type Settings} from '../src/config.js'
import {
  buildProductionRealtimeAssembly,
  type BuildProductionRealtimeAssemblyOptions,
} from '../src/production-realtime-assembly.js'
import type {RealtimeAssembly} from '../src/realtime-assembly.js'

function options(settings: Settings): BuildProductionRealtimeAssemblyOptions {
  return {settings}
}

test('production selector constructs only the integrated branch', () => {
  const expected = {kind: 'integrated'} as unknown as RealtimeAssembly
  const actual = buildProductionRealtimeAssembly(options(loadSettings({
    NOVA_AUDIO_AGENT_PIPELINE_MODE: 'integrated',
  })), {
    integrated: () => expected,
    cascaded: () => { throw new Error('unselected') },
  })
  assert.equal(actual, expected)
})

test('production selector constructs only the cascaded branch', () => {
  const expected = {kind: 'cascaded'} as unknown as RealtimeAssembly
  const actual = buildProductionRealtimeAssembly(options(loadSettings({
    NOVA_AUDIO_AGENT_PIPELINE_MODE: 'cascaded',
  })), {
    integrated: () => { throw new Error('unselected') },
    cascaded: () => expected,
  })
  assert.equal(actual, expected)
})

test('production selector reads only pipeline_mode before invoking the selected builder', () => {
  for (const mode of ['integrated', 'cascaded'] as const) {
    const settings = new Proxy({pipeline_mode: mode} as Settings, {
      get(target, property, receiver) {
        if (property !== 'pipeline_mode') throw new Error(`unexpected setting read: ${String(property)}`)
        return Reflect.get(target, property, receiver)
      },
    })
    const expected = {mode} as unknown as RealtimeAssembly
    const actual = buildProductionRealtimeAssembly({settings}, {
      integrated: () => mode === 'integrated' ? expected : (() => { throw new Error('unselected') })(),
      cascaded: () => mode === 'cascaded' ? expected : (() => { throw new Error('unselected') })(),
    })
    assert.equal(actual, expected)
  }
})

test('production selector never resolves the unselected builder property', () => {
  const expected = {kind: 'integrated'} as unknown as RealtimeAssembly
  const builders = Object.create(null) as {
    integrated: () => RealtimeAssembly
    cascaded: () => RealtimeAssembly
  }
  Object.defineProperties(builders, {
    integrated: {value: () => expected, enumerable: true},
    cascaded: {get: () => { throw new Error('unselected builder resolved') }, enumerable: true},
  })
  assert.equal(buildProductionRealtimeAssembly(options(loadSettings({})), builders), expected)
})

test('selected branch failures never fail over and invalid modes are credential-safe', () => {
  const failure = new Error('selected branch failed')
  assert.throws(
    () => buildProductionRealtimeAssembly(options(loadSettings({
      NOVA_AUDIO_AGENT_PIPELINE_MODE: 'cascaded',
    })), {
      integrated: () => { throw new Error('unselected') },
      cascaded: () => { throw failure },
    }),
    error => error === failure,
  )

  const invalid = {
    ...loadSettings({}), pipeline_mode: 'renderer-controlled-value',
  } as unknown as Settings
  assert.throws(
    () => buildProductionRealtimeAssembly(options(invalid), {
      integrated: () => { throw new Error('unselected') },
      cascaded: () => { throw new Error('unselected') },
    }),
    error => error instanceof ConfigurationError
      && error.message === 'NOVA_AUDIO_AGENT_PIPELINE_MODE 无效'
      && !error.message.includes('renderer-controlled-value'),
  )
})
