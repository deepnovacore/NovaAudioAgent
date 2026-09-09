import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {WebSocket, WebSocketServer} from 'ws'
import {createWebServer} from '../server.mjs'

test('serves only public assets and proxies same-origin authenticated frames unchanged', async t => {
  const upstream = new WebSocketServer({host: '127.0.0.1', port: 0})
  await once(upstream, 'listening')
  upstream.on('connection', ws => ws.on('message', (data, binary) => ws.send(data, {binary})))
  const app = createWebServer({upstream: `ws://127.0.0.1:${upstream.address().port}/client/v1`})
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await app.shutdown(); for (const ws of upstream.clients) ws.terminate(); await new Promise(r => upstream.close(r)) })
  const origin = `http://127.0.0.1:${app.address().port}`
  for (const path of ['/.env', '/server.mjs', '/shared/../main/main.mjs', '/%2e%2e/.env', '/shared/settings.mjs']) {
    assert.equal((await fetch(origin + path)).status, 404)
  }
  const source = await fetch(origin + '/shared/audio.mjs')
  assert.equal(source.status, 200)
  assert.match(source.headers.get('content-type'), /javascript/)
  assert.match(source.headers.get('content-security-policy'), /default-src 'self'/)
  const bad = new WebSocket(origin.replace('http:', 'ws:') + '/client/v1', {origin: 'https://evil.example'})
  assert.match((await once(bad, 'error'))[0].message, /403/)
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/client/v1', {origin})
  await once(ws, 'open')
  const received = once(ws, 'message')
  ws.send(JSON.stringify({type: 'auth', token: 'test-only'}))
  assert.equal((await received)[0].toString(), '{"type":"auth","token":"test-only"}')
  ws.close()
})
