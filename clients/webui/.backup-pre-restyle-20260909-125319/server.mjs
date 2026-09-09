import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import {WebSocket, WebSocketServer} from 'ws'

const ASSETS = new Map([
  ...['index.html', 'styles.css', 'app.mjs', 'session.mjs', 'audio.mjs', 'transcript.mjs'].map(name => [`/${name}`, new URL(`./src/${name}`, import.meta.url)]),
  ...['orb-visual.mjs', 'audio.mjs', 'capture-worklet.mjs'].map(name => [`/shared/${name}`, new URL(`../desktop/src/renderer/${name}`, import.meta.url)]),
])
ASSETS.set('/', ASSETS.get('/index.html'))
const LIMIT = 256 * 1024
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

export function createWebServer({upstream = 'ws://127.0.0.1:8787/client/v1', publicOrigin} = {}) {
  const target = new URL(upstream)
  if (!['ws:', 'wss:'].includes(target.protocol) || target.username || target.password || target.search || target.hash || target.pathname !== '/client/v1') throw new Error('Invalid runtime WebSocket endpoint')
  if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin) throw new Error('Invalid public origin')
  const relay = new WebSocketServer({noServer: true, maxPayload: LIMIT, perMessageDeflate: false})
  const peers = new Set()
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
    const file = ASSETS.get(req.url)
    if (!file || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404).end(); return }
    try {
      const data = await readFile(file)
      res.setHeader('Content-Type', file.pathname.endsWith('.html') ? 'text/html; charset=utf-8' : file.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8')
      res.writeHead(200).end(req.method === 'HEAD' ? undefined : data)
    } catch { res.writeHead(404).end() }
  })
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    const expected = publicOrigin || `http://${req.headers.host}`
    if (!trustedHost(req) || req.headers.origin !== expected || req.url !== '/client/v1') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
    }
    if (peers.size >= 8) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return }
    const remote = new WebSocket(target, {handshakeTimeout: 3000, maxPayload: LIMIT, perMessageDeflate: false})
    peers.add(remote)
    let client
    const abandon = () => { if (!client) remote.terminate() }
    socket.once('close', abandon)
    remote.on('error', () => { if (client) client.close(1011, 'runtime unavailable'); else socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n') })
    remote.on('close', (code) => {
      peers.delete(remote)
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
        ws.on('message', (data, binary) => forward(remote, data, binary))
        remote.on('message', (data, binary) => forward(ws, data, binary))
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
  }
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.NOVA_WEBUI_PORT || 4173)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WebUI port')
  const server = createWebServer({
    upstream: process.env.NOVA_WEBUI_RUNTIME_URL || `ws://127.0.0.1:${process.env.NOVA_AUDIO_AGENT_SERVER_PORT || 8787}/client/v1`,
    publicOrigin: process.env.NOVA_WEBUI_ORIGIN,
  })
  server.on('error', () => { console.error('WebUI 无法启动，请检查端口和连接配置。'); process.exitCode = 1 })
  server.listen(port, '127.0.0.1', () => console.log(`Nova WebUI: http://localhost:${port}`))
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { void server.shutdown() })
}
