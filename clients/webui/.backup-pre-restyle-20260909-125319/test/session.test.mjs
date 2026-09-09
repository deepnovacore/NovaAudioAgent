import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const source = (await readFile(new URL('../src/session.mjs', import.meta.url), 'utf8'))
  .replace("import {createBrowserAudio} from './audio.mjs'", 'const createBrowserAudio = () => globalThis.sessionTestAudio')
  .replace("'./transcript.mjs'", JSON.stringify(new URL('../src/transcript.mjs', import.meta.url).href))
const {createSession} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const flush = () => new Promise(setImmediate)
const ready = {
  type: 'client.ready', protocol_version: 1, connection_id: 'connection-1', server_instance_id: 'server-1',
  media: {transport: 'host_pcm_v1'},
  input_audio: {sample_rate: 16000, encoding: 'pcm_s16le', channels: 1},
  output_audio: {sample_rate: 24000, encoding: 'pcm_s16le', channels: 1},
}
async function setup(t, receive = async () => {}) {
  const sockets = [], statuses = [], captions = [], states = []
  t.mock.timers.enable({apis: ['setTimeout']})
  globalThis.sessionTestAudio = {
    start: async () => {}, stop() {}, resetPlayback() {}, receive, control: async () => {}, setMuted() {}, setVolume() {},
  }
  globalThis.location = {href: 'http://localhost:4173', protocol: 'http:'}
  globalThis.WebSocket = class {
    static OPEN = 1
    readyState = 1
    bufferedAmount = 0
    sent = []
    constructor() { sockets.push(this) }
    send(value) { this.sent.push(JSON.parse(value)) }
    close(code = 1000) { this.readyState = 3; this.closeCode = code; this.onclose?.({code}) }
    message(frame) { this.onmessage({data: frame instanceof ArrayBuffer ? frame : JSON.stringify(frame)}) }
  }
  const session = createSession({onStatus: value => statuses.push(value), onCaption: value => captions.push(value), onState: value => states.push(value)})
  t.after(() => session.stop())
  await session.start({credential: 'a'.repeat(32)})
  sockets[0].message(ready)
  await flush()
  return {session, sockets, statuses, captions, states}
}

test('disconnect fences queued old frames and reconnects after suspended playback resolves', async t => {
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const {session, sockets, statuses, captions} = await setup(t, () => blocked)
  sockets[0].message(new ArrayBuffer(2))
  sockets[0].message({type: 'caption', role: 'assistant', text: 'old', sequence: 1, final: true})
  await flush()
  sockets[0].close(1006)
  release()
  await flush()
  assert.equal(session.active, true)
  assert.equal(statuses.at(-1).phase, 'connecting')
  assert.deepEqual(captions, [])
  t.mock.timers.tick(500)
  assert.equal(sockets.length, 2)
  sockets[1].message({...ready, connection_id: 'connection-2'})
  await flush()
  assert.equal(statuses.at(-1).phase, 'connected')
})

test('rejected and stale receipts refresh host state without replaying a decision', async t => {
  const {session, sockets, states} = await setup(t)
  for (const [index, status] of ['rejected', 'stale'].entries()) {
    const ws = sockets[index]
    ws.message({type: 'project.state', pending_confirmation: true, pending_confirmation_id: 'proposal'})
    await flush()
    assert.equal(session.decide({type: 'project.confirmation_decision', proposal_id: 'proposal', confirmed: true}), true)
    ws.message({type: 'client.command_result', request_id: ws.sent[0].request_id, status})
    await flush()
    assert.equal(ws.closeCode, 4008)
    assert.equal(session.active, true)
    assert.equal(states.at(-1).pending_approval_id, null)
    t.mock.timers.tick(500)
    const next = sockets[index + 1]
    next.message({...ready, connection_id: `connection-${index + 2}`})
    await flush()
    assert.deepEqual(next.sent, [])
    assert.equal(session.decide({type: 'project.confirmation_decision', proposal_id: 'proposal', confirmed: true}), false)
  }
})

test('executor decisions reject unsupported scope instead of downgrading it', async t => {
  const {session, sockets} = await setup(t)
  sockets[0].message({type: 'executor.approval', executor: 'codex', pending_approval_id: 'approval', pending_approval: true})
  await flush()
  const decision = {type: 'executor.approval_decision', executor: 'codex', approval_id: 'approval', approved: true}
  assert.equal(session.decide({...decision, scope: 'session'}), false)
  assert.deepEqual(sockets[0].sent, [])
  assert.equal(session.decide(decision), true)
  assert.deepEqual(sockets[0].sent[0].payload, decision)
  assert.equal(session.decide(decision), false)
})
