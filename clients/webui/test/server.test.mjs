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
  const login = await fetch(origin + '/api/session', {method:'POST', headers:{Origin:origin, 'X-Nova-WebUI':'1', 'Content-Type':'application/json'}, body:JSON.stringify({credential:'a'.repeat(32)})})
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/client/v1', {origin, headers:{Cookie:cookie}})
  await once(ws, 'open')
  const received = once(ws, 'message')
  ws.send(JSON.stringify({type:'hello',protocol_version:1,media:{transports:['host_pcm_v1']}}))
  assert.equal(JSON.parse((await received)[0].toString()).token, 'a'.repeat(32))
  ws.close()
})

test('local session hides host token, protects settings from cross-origin requests, and authenticates cookies', async t => {
  const host = {token:'b'.repeat(32), view:()=>({secretsPresent:{dashscopeApiKey:true}}), update:async()=>({saved:true}), start:async()=> 'ws://127.0.0.1:8787/client/v1', close:async()=>{}}
  const app = createWebServer({host})
  await new Promise(resolve => app.listen(0,'127.0.0.1',resolve))
  t.after(()=>app.shutdown())
  const origin = `http://127.0.0.1:${app.address().port}`
  const headers = {Origin:origin,'X-Nova-WebUI':'1','Content-Type':'application/json'}
  assert.equal((await fetch(origin+'/api/settings',{headers})).status,401)
  assert.equal((await fetch(origin+'/api/session',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403)
  const login = await fetch(origin+'/api/session',{method:'POST',headers,body:'{}'})
  assert.equal(login.status,200)
  assert.doesNotMatch(await login.text(), new RegExp(host.token))
  const setCookie = login.headers.get('set-cookie')
  assert.match(setCookie,/HttpOnly/); assert.match(setCookie,/SameSite=Strict/)
  const authenticated = {...headers,Cookie:setCookie.split(';')[0]}
  const view = await fetch(origin+'/api/settings',{headers:authenticated})
  assert.deepEqual(await view.json(),{secretsPresent:{dashscopeApiKey:true}})
  assert.equal((await fetch(origin+'/api/settings',{method:'PUT',headers:{...authenticated,Origin:'https://evil.example'},body:'{}'})).status,403)
  assert.equal((await fetch(origin+'/api/settings',{method:'PUT',headers:authenticated,body:'{}'})).status,200)
})

test('public deployment never grants automatic local authentication', async t => {
  const host = {token:'c'.repeat(32),view:()=>({}),close:async()=>{}}
  const app = createWebServer({host,publicOrigin:'https://nova.example.com'})
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve)); t.after(()=>app.shutdown())
  const url = `http://127.0.0.1:${app.address().port}/api/session`
  const headers = {Origin:'https://nova.example.com','X-Nova-WebUI':'1','Content-Type':'application/json'}
  assert.equal((await fetch(url,{method:'POST',headers,body:'{}'})).status,401)
  const response = await fetch(url,{method:'POST',headers,body:JSON.stringify({credential:host.token})})
  assert.equal(response.status,200)
  assert.match(response.headers.get('set-cookie'),/Secure/)
})

test('unverified external credentials cannot exhaust the session pool', async () => {
  const server = createWebServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    for (let index = 0; index < 34; index++) {
      const response = await fetch(`${origin}/api/session`, {method:'POST', headers: {'Content-Type':'application/json', 'X-Nova-WebUI':'1', Origin:origin}, body:JSON.stringify({credential:'0'.repeat(32)})})
      assert.equal(response.status, 200)
      await response.arrayBuffer()
    }
  } finally { await server.shutdown() }
})
