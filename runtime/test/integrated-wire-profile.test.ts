import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createStepFunWireProfile, qwenWireProfile} from '../src/realtime/integrated-wire-profile.js'

test('Qwen 3.1 keeps the Qwen wire contract and selects its matching voice', () => {
  const session = qwenWireProfile.session([], 'longanqian_v3.1', 'hello', 'qwen-audio-3.1-realtime-plus')
  assert.equal(session.voice, 'longanqian_v3.1')
  assert.equal(session.input_audio_format, 'pcm')
  assert.deepEqual(session.turn_detection, {type: 'smart_turn'})
})

test('StepFun maps the shared session and tool contracts to its wire format', () => {
  const profile = createStepFunWireProfile()
  const session = profile.session([{type: 'function', name: 'lookup', description: 'Look up',
    parameters: {type: 'object', properties: {}}}], '', 'hello', 'stepaudio-3-realtime-preview')
  assert.deepEqual(session.modalities, ['text', 'audio'])
  assert.equal(session.input_audio_format, 'pcm16')
  assert.equal(session.output_audio_format, 'pcm16')
  assert.deepEqual(session.tools, [{type: 'function', function: {name: 'lookup', description: 'Look up',
    parameters: {type: 'object', properties: {}}}}])
  assert.equal('voice' in session, false)
  const hostResponse = {type: 'response.create', event_id: 'x',
    response: {modalities: ['audio', 'text'], tool_choice: 'none', instructions: 'host-only'}}
  assert.deepEqual(profile.outbound(hostResponse), hostResponse)
  assert.deepEqual(profile.inbound({type: 'response.output_item.done', response_id: 'r',
    item: {type: 'function_call', id: 'i', call_id: 'c', name: 'lookup', arguments: '{}'}}),
  {type: 'response.function_call_arguments.done', response_id: 'r', item_id: 'i',
    call_id: 'c', name: 'lookup', arguments: '{}'})
})

test('StepFun PCM16 resampling preserves frame continuity and reset', () => {
  const profile = createStepFunWireProfile()
  const source = new Int16Array([0, 600, 1200, 1800])
  const whole = new Int16Array(profile.inputPcm(new Uint8Array(source.buffer)).buffer)
  profile.reset()
  const first = profile.inputPcm(new Uint8Array(source.buffer, 0, 4))
  const second = profile.inputPcm(new Uint8Array(source.buffer, 4, 4))
  const bytes = Buffer.concat([Buffer.from(first), Buffer.from(second)])
  const split = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2)
  assert.deepEqual([...split], [...whole])
  assert.deepEqual([...whole], [0, 400, 800, 1200, 1600])
})

test('StepFun delivers each tool call once and ends incomplete responses as failed', () => {
  const profile = createStepFunWireProfile()
  const native = {type: 'response.function_call_arguments.done', response_id: 'r', item_id: 'i',
    call_id: 'c', name: 'lookup', arguments: '{}'}
  assert.deepEqual(profile.inbound({...native}), native)
  const echoed = profile.inbound({type: 'response.output_item.done', response_id: 'r',
    item: {type: 'function_call', id: 'i', call_id: 'c', name: 'lookup', arguments: '{}'}})
  assert.notEqual(echoed.type, 'response.function_call_arguments.done')
  profile.reset()
  assert.deepEqual(profile.inbound({...native}), native, 'a new session starts with no seen calls')
  assert.deepEqual(profile.inbound({type: 'response.done', response: {id: 'r', status: 'incomplete'}}),
    {type: 'response.done', response: {id: 'r', status: 'failed'}})
  assert.equal(profile.voiceOptional, true)
})

test('the Qwen profile leaves tool calls and terminals untouched and requires a voice', () => {
  const call = {type: 'response.function_call_arguments.done', call_id: 'c'}
  assert.deepEqual(qwenWireProfile.inbound({...call}), call)
  assert.deepEqual(qwenWireProfile.inbound({...call}), call)
  assert.equal(qwenWireProfile.voiceOptional, false)
})
