import {ClientServer} from '../dist/src/client-server.js'
import {encodeAudioFrame} from '../dist/src/desktop-wire.js'

const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.split('=')[1] ?? 8787)
const disconnectAfter = Number(process.argv.find(arg => arg.startsWith('--disconnect-after-ms='))?.split('=')[1] ?? 0)
if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(disconnectAfter) || disconnectAfter < 0) {
  throw new Error('usage: client-protocol-mock.mjs [--port=8787] [--disconnect-after-ms=3000]')
}
const token = '0123456789abcdef0123456789abcdef' // Public mock credential; never use for production.
let timer
let sequence = 0
let epoch = 0
const send = value => server.sendText(JSON.stringify(value))
const project = pending => ({type: 'project.state', workspace_display_name: '模拟项目', session_title: '协议联调',
  roster: [], pending_confirmation: pending, pending_confirmation_busy: false,
  ...(pending ? {pending_confirmation_id: 'mock-project'} : {}),
  pending_action: pending ? 'select_workspace' : null, pending_workspace_display_name: pending ? '模拟项目' : null,
  pending_session_title: null, pending_expires_in_seconds: pending ? 60 : null})
const server = new ClientServer({token, port,
  onClientAuthenticated: async () => {
    epoch++
    await send(project(true))
    await send({type: 'caption', role: 'assistant', text: '模拟服务：只验证音频与协议，不调用模型或 Codex。', final: true, sequence: ++sequence})
    // Short synthetic tone is deliberate test audio, never represented as generated speech.
    const pcm = Buffer.alloc(4800 * 2)
    for (let n = 0; n < 4800; n++) pcm.writeInt16LE(Math.round(Math.sin(n * 2 * Math.PI * 440 / 24000) * 1000), n * 2)
    await server.sendBinary(encodeAudioFrame({utterance_id: 'mock-tone', generation_epoch: epoch, sequence: 0, pcm}))
    await send({type: 'playback.terminal', utterance_id: 'mock-tone', generation_epoch: epoch})
    if (disconnectAfter) timer = setTimeout(() => { void server.disconnectClient() }, disconnectAfter)
  },
  onClientDisconnect: () => clearTimeout(timer),
  onAudio: () => {}, // Discard; do not store or transmit captured microphone audio.
  onControl: async control => {
    if (control.type === 'project.confirmation_decision' && control.proposal_id === 'mock-project') {
      await send(project(false))
      await send({type: 'caption', role: 'assistant', text: control.confirmed ? '模拟确认已收到。' : '模拟确认已拒绝。', final: true, sequence: ++sequence})
    }
    if (control.type === 'speech.onset') {
      await send({type: 'playback.clear', utterance_id: 'mock-tone', generation_epoch: epoch})
    }
  },
})
await server.start()
console.log(`Mock only: ws://127.0.0.1:${port}/client/v1 (public mock credential in docs/protocols/client-v1.md)`)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  clearTimeout(timer)
  void server.close().catch(() => { process.exitCode = 1 })
})
