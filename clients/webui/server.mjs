import {createServer} from 'node:http'
import {randomBytes, timingSafeEqual} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import {WebSocket, WebSocketServer} from 'ws'

const ASSETS = new Map([
  ...['index.html', 'styles.css', 'app.mjs', 'session.mjs', 'audio.mjs', 'transcript.mjs'].map(name => [`/${name}`, new URL(`./src/${name}`, import.meta.url)]),
  ...['fonts/inter-variable.woff2'].map(name => [`/${name}`, new URL(`./src/${name}`, import.meta.url)]),
  ...['orb-visual.mjs', 'audio.mjs', 'capture-worklet.mjs'].map(name => [`/shared/${name}`, new URL(`../desktop/src/renderer/${name}`, import.meta.url)]),
])
ASSETS.set('/', ASSETS.get('/index.html'))
const LIMIT = 256 * 1024
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

export function createWebServer({upstream = 'ws://127.0.0.1:8787/client/v1', publicOrigin, host} = {}) {
  const target = new URL(upstream)
  if (!['ws:', 'wss:'].includes(target.protocol) || target.username || target.password || target.search || target.hash || target.pathname !== '/client/v1') throw new Error('Invalid runtime WebSocket endpoint')
  if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin) throw new Error('Invalid public origin')
  const relay = new WebSocketServer({noServer: true, maxPayload: LIMIT, perMessageDeflate: false})
  const peers = new Set()
  const sessions = new Map()
  const mode = host && !publicOrigin ? 'local' : 'remote'
  const expectedOrigin = req => publicOrigin || `http://${req.headers.host}`
  const sessionFor = req => {
    const id = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('nova_webui_session='))?.slice(19)
    const session = sessions.get(id)
    if (session && session.expires > Date.now()) return session
    if (id) sessions.delete(id)
  }
  const json = (res, code, value) => res.writeHead(code, {'Content-Type': 'application/json'}).end(JSON.stringify(value))
  async function api(req, res) {
    if (req.headers['x-nova-webui'] !== '1' || (req.headers.origin && req.headers.origin !== expectedOrigin(req))
      || (req.method !== 'GET' && req.headers.origin !== expectedOrigin(req)) || req.headers['sec-fetch-site'] === 'cross-site') {
      json(res, 403, {error: 'forbidden'}); return
    }
    let session = sessionFor(req), body = {}
    if (['POST', 'PUT'].includes(req.method)) {
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') { json(res, 415, {error: 'invalid_request'}); return }
      let size = 0, chunks = []
      for await (const chunk of req) {
        size += chunk.length
        if (size > 65536) { json(res, 413, {error: 'request_too_large'}); return }
        chunks.push(chunk)
      }
      try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch { json(res, 400, {error: 'invalid_request'}); return }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { json(res, 400, {error: 'invalid_request'}); return }
    }
    if (req.url === '/api/session' && req.method === 'POST') {
      if (session && !host && typeof body.credential === 'string' && body.credential.trim()) {
        if (!/^[a-f0-9]{32}$/.test(body.credential.trim())) { json(res, 401, {mode, error: 'authentication_required'}); return }
        session.token = body.credential.trim()
        session.verified = false
      }
      if (!session) {
        const credential = typeof body.credential === 'string' ? body.credential.trim() : ''
        const valid = /^[a-f0-9]{32}$/.test(credential)
          && (!host || timingSafeEqual(Buffer.from(credential), Buffer.from(host.token)))
        if (mode === 'remote' && !valid) { json(res, 401, {mode, error: 'authentication_required'}); return }
        for (const [id, value] of sessions) if (value.expires <= Date.now()) sessions.delete(id)
        if (sessions.size >= 32) {
          // Unverified external credentials must never reserve the login pool.
          const pending = [...sessions].find(([, value]) => !value.verified)
          if (pending) sessions.delete(pending[0])
          else { json(res, 429, {error: 'too_many_sessions'}); return }
        }
        const id = randomBytes(32).toString('hex')
        session = {token: host?.token || credential, verified: !!host, expires: Date.now() + 8 * 3600000}
        sessions.set(id, session)
        res.setHeader('Set-Cookie', `nova_webui_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${publicOrigin?.startsWith('https:') ? '; Secure' : ''}`)
      }
      json(res, 200, {mode, authenticated: true, settings: host?.view() || null}); return
    }
    if (!session) { json(res, 401, {mode, error: 'authentication_required'}); return }
    if (req.url === '/api/runtime/start' && req.method === 'POST') {
      if (host) await host.start()
      json(res, 200, {ready: true}); return
    }
    if (req.url === '/api/settings' && req.method === 'GET') { json(res, 200, host?.view() || null); return }
    if (req.url === '/api/settings' && req.method === 'PUT') {
      if (!host) { json(res, 409, {error: 'external_runtime'}); return }
      json(res, 200, await host.update(body)); return
    }
    json(res, 404, {error: 'not_found'})
  }
  function trustedHost(req) {
    const port = server.address()?.port
    return [`127.0.0.1:${port}`, `localhost:${port}`, ...(publicOrigin ? [new URL(publicOrigin).host] : [])].includes(req.headers.host)
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', CSP)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Cache-Control', 'no-store')
    if (!trustedHost(req)) { res.writeHead(403).end(); return }
    if (req.url?.startsWith('/api/')) {
      try { await api(req, res) }
      catch (error) { json(res, error.code === 'runtime_unavailable' ? 503 : 400, {error: error.code === 'runtime_unavailable' ? 'runtime_unavailable' : 'invalid_settings', ...(error.saved ? {saved: true, restarted: false} : {})}) }
      return
    }
    const file = ASSETS.get(req.url)
    if (!file || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404).end(); return }
    try {
      const data = await readFile(file)
      res.setHeader('Content-Type', file.pathname.endsWith('.html') ? 'text/html; charset=utf-8' : file.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : file.pathname.endsWith('.woff2') ? 'font/woff2' : 'text/javascript; charset=utf-8')
      res.writeHead(200).end(req.method === 'HEAD' ? undefined : data)
    } catch { res.writeHead(404).end() }
  })
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    const expected = expectedOrigin(req)
    const session = sessionFor(req)
    if (!trustedHost(req) || req.headers.origin !== expected || req.url !== '/client/v1' || !session || (host && !host.endpoint)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
    }
    if (peers.size >= 8) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return }
    const remote = new WebSocket(host?.endpoint || target, {handshakeTimeout: 3000, maxPayload: LIMIT, perMessageDeflate: false})
    peers.add(remote)
    let client
    const abandon = () => { if (!client) remote.terminate() }
    socket.once('close', abandon)
    remote.on('error', () => { if (client) client.close(1011, 'runtime unavailable'); else socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n') })
    remote.on('close', (code) => {
      peers.delete(remote)
      if (code === 4003) for (const [id, value] of sessions) if (value === session) sessions.delete(id)
      if (client) client.close(code >= 3000 && code <= 4999 ? code : 1011, 'runtime disconnected')
    })
    remote.on('open', () => {
      if (socket.destroyed) { remote.terminate(); return }
      relay.handleUpgrade(req, socket, head, ws => {
        client = ws
        socket.removeListener('close', abandon)
        function forward(to, data, binary) {
          if (to.readyState !== WebSocket.OPEN || to.bufferedAmount + data.byteLength > LIMIT) {
            ws.close(4008, 'connection overloaded'); remote.close(); return
          }
          to.send(data, {binary}, error => { if (error) { ws.terminate(); remote.terminate() } })
        }
        let greeted = false
        ws.on('message', (data, binary) => {
          if (!greeted) {
            try {
              const hello = binary ? null : JSON.parse(data.toString())
              if (hello?.type !== 'hello') throw new Error('invalid hello')
              data = Buffer.from(JSON.stringify({...hello, token: session.token}))
              greeted = true
            } catch { ws.close(4003, 'invalid hello'); remote.close(); return }
          }
          forward(remote, data, binary)
        })
        remote.on('message', (data, binary) => {
          if (!binary && !session.verified) {
            try { if (JSON.parse(data.toString()).type === 'client.ready') session.verified = true } catch {}
          }
          forward(ws, data, binary)
        })
        ws.on('error', () => remote.terminate())
        ws.on('close', () => remote.close())
      })
    })
  })
  server.shutdown = async () => {
    for (const ws of relay.clients) ws.terminate()
    for (const ws of peers) ws.terminate()
    await new Promise(resolve => relay.close(resolve))
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await host?.close()
  }
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.NOVA_WEBUI_PORT || 4173)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WebUI port')
  const host = process.env.NOVA_WEBUI_RUNTIME_URL ? undefined : await (await import('./host.mjs')).createLocalHost({stateDir: process.env.NOVA_WEBUI_STATE_DIR})
  const server = createWebServer({
    host,
    upstream: process.env.NOVA_WEBUI_RUNTIME_URL || `ws://127.0.0.1:${process.env.NOVA_AUDIO_AGENT_SERVER_PORT || 8787}/client/v1`,
    publicOrigin: process.env.NOVA_WEBUI_ORIGIN,
  })
  server.on('error', () => { console.error('WebUI 无法启动，请检查端口和连接配置。'); process.exitCode = 1 })
  server.listen(port, '127.0.0.1', () => console.log(`Nova WebUI: http://localhost:${port}`))
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { void server.shutdown() })
}
