// Network/protocol rehearsal, NOT model inference or physical microphone acceptance.
// Build runtime first: node serving/mock-smoke.mjs prerecorded-16khz-mono.s16le
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {WebSocketServer} from 'ws'
import {once} from 'node:events'
import {mkdtemp, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {spawn} from 'node:child_process'

assert.ok(process.argv[2], 'Usage: node serving/mock-smoke.mjs input.s16le')
const directory = await mkdtemp(join(tmpdir(), 'nova-mock-voice-'))
const counts = {asrSessions: 0, inputBytes: 0, llmRequests: 0, ttsRequests: 0, abortedTts: 0}
const pcm = Buffer.alloc(48000)
for (let sample = 0; sample < pcm.length / 2; sample++) pcm.writeInt16LE(Math.round(2000 * Math.sin(sample * 2 * Math.PI * 220 / 24000)), sample * 2)
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, undefined, 'Unexpected credential on mock request')
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      assert.ok(size <= 1024 * 1024)
      chunks.push(chunk)
    }
    if (request.url === '/v1/chat/completions') {
      counts.llmRequests++
      const body = JSON.parse(Buffer.concat(chunks).toString())
      response.writeHead(200, {'content-type': 'text/event-stream'})
      const event = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({id: 'mock-response', choices: [{index: 0, delta, finish_reason}]})}\n\n`)
      if (body.tools?.length) {
        event({tool_calls: [{index: 0, id: 'mock-call', type: 'function', function: {name: 'echo', arguments: '{"text":"nova smoke"}'}}]})
        event({}, 'tool_calls')
      } else {
        event({content: '这是模拟服务的回复。'})
        event({}, 'stop')
      }
      response.end('data: [DONE]\n\n')
    } else if (request.url === '/tts') {
      counts.ttsRequests++
      response.writeHead(200, {'content-type': 'audio/pcm', 'x-sample-rate': '24000', 'x-sample-format': 's16le'})
      let offset = 0
      const timer = setInterval(() => {
        // Deliberately odd network boundaries: PCM samples must be reassembled.
        const end = Math.min(offset + 4097, pcm.length)
        response.write(pcm.subarray(offset, end))
        offset = end
        if (offset === pcm.length) { clearInterval(timer); response.end() }
      }, 15)
      response.on('close', () => { clearInterval(timer); if (!response.writableFinished) counts.abortedTts++ })
    } else { response.writeHead(404); response.end() }
  } catch { response.destroy() }
})
const sockets = new WebSocketServer({server, path: '/asr', maxPayload: 64000})
sockets.on('connection', (socket, request) => {
  assert.equal(request.headers.authorization, undefined)
  counts.asrSessions++
  socket.send(JSON.stringify({type: 'ready', sampleRate: 16000, format: 's16le'}))
  let bytes = 0
  socket.on('message', (data, binary) => {
    if (binary) {
      assert.equal(data.length % 2, 0)
      bytes += data.length
      counts.inputBytes += data.length
      if (bytes <= 64000) socket.send(JSON.stringify({text: bytes < 32000 ? '模拟' : '模拟麦克风', final: false, replace: true}))
    } else {
      assert.equal(data.toString(), 'finish')
      assert.ok(bytes > 0)
      socket.send(JSON.stringify({text: '模拟麦克风输入完成。', final: true, replace: true}))
    }
  })
})
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const preset = join(directory, 'mock.json')
  await writeFile(preset, JSON.stringify({schema: 'nova.voice-preset', version: 1, name: 'Mock services only',
    asr: {provider: 'self-hosted', url: `ws://127.0.0.1:${port}/asr`},
    llm: {provider: 'self-hosted', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock'},
    tts: {provider: 'self-hosted', url: `http://127.0.0.1:${port}/tts`}}))
  const child = spawn(process.execPath, [new URL('./smoke.mjs', import.meta.url).pathname, preset, resolve(process.argv[2])], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {...process.env, SELF_HOSTED_ASR_API_KEY: '', SELF_HOSTED_LLM_API_KEY: '', SELF_HOSTED_TTS_API_KEY: ''},
  })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, 'Mock pipeline rehearsal failed')
  assert.ok(counts.asrSessions >= 2 && counts.llmRequests >= 3 && counts.ttsRequests >= 3 && counts.abortedTts >= 1)
  console.log(JSON.stringify({mode: 'mock-services-with-prerecorded-microphone-input', ...counts}, null, 2))
} finally {
  for (const socket of sockets.clients) socket.terminate()
  await new Promise(resolve => sockets.close(resolve))
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(directory, {recursive: true, force: true})
}
