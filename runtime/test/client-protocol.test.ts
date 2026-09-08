import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFileSync} from 'node:fs'
import {ClientCommands, decodeClientAudioFrame} from '../src/client-protocol.js'

test('remote command ledger delivers once, rejects mutation, and fences reconnects', async () => {
  const commands = new ClientCommands('connection-1')
  let calls = 0
  const raw = JSON.stringify({type: 'client.command', request_id: 'request-1', connection_id: 'connection-1',
    payload: {type: 'project.confirmation_decision', proposal_id: 'proposal', confirmed: true}})
  const deliver = (): void => { calls++ }
  assert.equal((await commands.receive(raw, deliver)).status, 'applied')
  assert.equal((await commands.receive(raw, deliver)).status, 'applied')
  assert.equal(calls, 1)
  assert.equal((await commands.receive(raw.replace('true', 'false'), deliver)).status, 'rejected')
  assert.equal((await new ClientCommands('connection-2').receive(raw, deliver)).status, 'stale')
  assert.equal(calls, 1)
})

test('ledger remains bounded and treats failed delivery as a consumed request', async () => {
  const commands = new ClientCommands('c')
  let calls = 0
  for (let n = 0; n < 257; n++) {
    const raw = JSON.stringify({type: 'client.command', request_id: String(n), connection_id: 'c',
      payload: {type: 'executor.approval_decision', executor: 'codex', approval_id: 'a', approved: true}})
    const result = await commands.receive(raw, () => { calls++; if (n === 0) throw new Error('offline') })
    assert.equal(result.status, n === 0 || n === 256 ? 'rejected' : 'applied')
  }
  assert.equal(calls, 256)
})

test('remote decoder rejects unknown controls, oversized JSON and unsafe integers', async () => {
  const commands = new ClientCommands('c')
  const send = (payload: unknown): Promise<unknown> => commands.receive(JSON.stringify({type: 'client.command',
    request_id: 'r', connection_id: 'c', payload}), () => assert.fail('must not deliver'))
  await assert.rejects(send({type: 'camera.permission.result', request_id: 'x', status: 'granted'}))
  await assert.rejects(send({type: 'playback.started', utterance_id: 'u', generation_epoch: Number.MAX_SAFE_INTEGER + 1}))
  await assert.rejects(commands.receive(' '.repeat(16385), () => assert.fail('must not deliver')))
})

test('shared Swift and TypeScript wire vectors decode identically', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../../fixtures/client-protocol/v1/vectors.json', import.meta.url), 'utf8')) as {
    name: string; hex: string; valid: boolean;
    expected?: {utterance_id: string; generation_epoch: number; sequence: number; pcm_hex: string};
  }[]
  for (const vector of vectors) {
    const raw = Buffer.from(vector.hex, 'hex')
    if (!vector.valid) { assert.throws(() => decodeClientAudioFrame(raw), vector.name); continue }
    const frame = decodeClientAudioFrame(raw)
    assert.deepEqual({...frame, pcm: undefined, pcm_hex: Buffer.from(frame.pcm).toString('hex')},
      {...vector.expected, pcm: undefined}, vector.name)
  }
})
