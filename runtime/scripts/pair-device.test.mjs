import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter, once} from 'node:events'
import {PassThrough, Writable} from 'node:stream'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {spawn, spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WebSocketServer} from 'ws'
import {ClientPairing} from '../dist/src/server/client-pairing.js'
import {terminalPair, terminalQr} from './pair-device.mjs'

const master = 'a'.repeat(32), server = 'wss://mac.example/client/v1'
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-terminal-pair-'))
  const pairing = new ClientPairing(master, join(dir, 'devices.json'))
  const host = new WebSocketServer({host: '127.0.0.1', port: 0})
  await once(host, 'listening')
  let invitation, creates = 0, polls = 0, text = ''
  const updates = new EventEmitter()
  const create = pairing.create.bind(pairing)
  pairing.create = address => { creates++; invitation = create(address); updates.emit('created'); return invitation }
  host.on('connection', (socket, req) => {
    socket.on('message', bytes => {
      if (JSON.parse(String(bytes)).type === 'pair.list') { polls++; updates.emit('poll') }
    })
    pairing.handle(socket, req.url)
  })
  t.after(() => { host.close(); rmSync(dir, {recursive: true, force: true}) })
  const input = new PassThrough(); input.isTTY = true
  const output = new Writable({write(chunk, _encoding, done) {text += chunk; done(); updates.emit('output')}})
  output.isTTY = true; output.columns = 120
  const events = new EventEmitter()
  return {dir, pairing, input, output, events, updates, config: {port: host.address().port, token: master, server},
    get invitation() {return invitation}, get creates() {return creates}, get polls() {return polls}, get text() {return text},
    async displayed() {while (!text.includes('Ctrl+C')) await once(updates, 'output')},
  }
}

test('terminal pairing prints once, polls silently and detects one-time redemption', {timeout: 10000}, async t => {
  const f = await fixture(t)
  const running = terminalPair(f.config, f)
  await f.displayed()
  const printed = f.text
  await once(f.updates, 'poll')
  assert.equal(f.text, printed)
  assert.equal(f.creates, 1)
  assert.ok(printed.includes(server))
  assert.ok(!printed.includes(master) && !printed.includes(f.invitation.code))
  const device = f.pairing.redeem(f.invitation.code, 'test iPhone')
  assert.throws(() => f.pairing.redeem(f.invitation.code, 'replay'))
  await running
  assert.ok(f.pairing.accepts(device.token))
  assert.match(f.text, /二维码已使用或失效/)
  assert.equal(f.events.listenerCount('SIGINT'), 0)
})

test('signals and input close cancel only this invitation, leaving the host available', {timeout: 10000}, async t => {
  for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP', 'end', 'close']) {
    const f = await fixture(t)
    const running = terminalPair(f.config, f)
    await f.displayed()
    if (event === 'end') f.input.end()
    else if (event === 'close') f.input.destroy()
    else f.events.emit(event)
    await running
    assert.throws(() => f.pairing.redeem(f.invitation.code, 'cancelled'))
    assert.ok(f.pairing.create(server).code)
  }
})

test('replacement code survives the old terminal cleanup', {timeout: 6000}, async t => {
  const f = await fixture(t)
  const running = terminalPair(f.config, f)
  await f.displayed()
  const replacement = f.pairing.create(server)
  await running
  assert.equal(f.pairing.redeem(replacement.code, 'new iPhone').type, 'pair.ready')
})

test('non-interactive and narrow terminals fail before creating a code', async t => {
  for (const change of [f => {f.output.isTTY = false}, f => {f.input.isTTY = false}, f => {f.output.columns = 20}]) {
    const f = await fixture(t); change(f)
    await assert.rejects(terminalPair(f.config, f))
    assert.equal(f.creates, 0)
  }
})

test('authentication and connection errors do not echo credentials', async t => {
  const f = await fixture(t)
  await assert.rejects(terminalPair({...f.config, token: 'b'.repeat(32)}, f), /配对请求失败/)
  await assert.rejects(terminalPair({...f.config, port: 0}, f), /配对请求失败/)
  assert.equal(f.creates, 0)
  assert.ok(!f.text.includes(master) && !f.text.includes('b'.repeat(32)))
})

test('polling and cancellation accept the largest device list the host admits', {timeout: 6000}, async t => {
  const f = await fixture(t)
  // Lone surrogates pass the host name schema and JSON-escape to six bytes each: 31 devices exceed 16 KB.
  for (let i = 0; i < 31; i++) f.pairing.redeem(f.pairing.create(server).code, '\ud800'.repeat(80))
  const running = terminalPair(f.config, f)
  await f.displayed()
  await once(f.updates, 'poll')
  f.events.emit('SIGINT')
  await running
  assert.ok(!f.text.includes('无法确认'))
})

test('interrupt during creation cancels the late response without printing a QR', async t => {
  const f = await fixture(t)
  const running = terminalPair(f.config, f)
  await once(f.updates, 'created')
  f.events.emit('SIGINT')
  await running
  assert.equal(f.text, '')
  assert.throws(() => f.pairing.redeem(f.invitation.code, 'late'))
})

for (const stop of ['ctrl-c', 'SIGHUP']) test(`the Linux CLI displays in a PTY without a GUI and ${stop} cancels its code`, {skip: process.platform !== 'linux', timeout: 10000}, async t => {
  const f = await fixture(t)
  const tokenFile = join(f.dir, 'host.token'); writeFileSync(tokenFile, master, {mode: 0o600})
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  const command = 'stty cols 120; exec ' + [process.execPath, fileURLToPath(new URL('./pair-device.mjs', import.meta.url)), server].map(quote).join(' ')
  const child = spawn('script', ['-qec', command, '/dev/null'], {env: {...process.env, DISPLAY: '', WAYLAND_DISPLAY: '',
    SERVER_PORT: String(f.config.port), SERVER_TOKEN_FILE: tokenFile}})
  t.after(() => {if (child.exitCode === null) child.kill('SIGTERM')})
  const exited = once(child, 'exit')
  let printed = '', interrupted = false
  child.stdout.on('data', bytes => {
    printed += bytes
    if (!interrupted && printed.includes('Ctrl+C')) {
      interrupted = true
      if (stop === 'SIGHUP') child.kill('SIGHUP'); else child.stdin.write('\x03')
    }
  })
  const [code] = await exited
  assert.equal(code, 0)
  assert.equal(interrupted, true)
  assert.ok(!printed.includes(master) && !printed.includes(f.invitation.code))
  assert.throws(() => f.pairing.redeem(f.invitation.code, 'cancelled'))
})

test('unresponsive host times out within the five-second request bound', {timeout: 7000}, async t => {
  const host = new WebSocketServer({host: '127.0.0.1', port: 0})
  await once(host, 'listening')
  t.after(() => {for (const socket of host.clients) socket.terminate(); host.close()})
  const f = await fixture(t)
  const start = Date.now()
  await assert.rejects(terminalPair({...f.config, port: host.address().port}, f), /配对请求失败/)
  assert.ok(Date.now() - start < 6500)
})

test('CoreImage decodes the actual terminal glyphs back into the v1 invitation', {skip: process.platform !== 'darwin', timeout: 30000}, async t => {
  const payload = {type: 'nova.pair', version: 1, server, code: '0123456789abcdef0123456789abcdef'}
  const qr = await terminalQr(payload)
  let foreground = 0, background = 255
  const rows = []
  for (const line of qr.text.trimEnd().split('\n')) {
    const top = [], bottom = []
    for (const token of line.match(/\x1b\[[0-9;]*m|[^\x1b]/g)) {
      if (token.startsWith('\x1b')) {
        if (token === '\x1b[30m') foreground = 0
        if (token === '\x1b[37m') foreground = 255
        if (token === '\x1b[40m') background = 0
        if (token === '\x1b[47m') background = 255
        continue
      }
      top.push(['▀', '█'].includes(token) ? foreground : background)
      bottom.push(['▄', '█'].includes(token) ? foreground : background)
    }
    assert.equal(top.length, qr.width)
    rows.push(top, bottom)
  }
  const scale = 6, width = qr.width * scale, height = rows.length * scale
  const pixels = Buffer.from(rows.flatMap(row => Array.from({length: scale}, () => row.flatMap(value => Array(scale).fill(value))).flat()))
  const dir = mkdtempSync(join(tmpdir(), 'nova-terminal-qr-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  const file = join(dir, 'pixels'); writeFileSync(file, pixels)
  const result = spawnSync('swift', ['-e', `
    import Foundation
    import CoreImage
    let width = Int(CommandLine.arguments[1])!, height = Int(CommandLine.arguments[2])!
    let image = CIImage(bitmapData: try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[3])), bytesPerRow: width,
      size: CGSize(width: width, height: height), format: .L8, colorSpace: CGColorSpaceCreateDeviceGray())
    let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: CIContext(), options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
    for feature in detector.features(in: image) { if let text = (feature as? CIQRCodeFeature)?.messageString { print(text) } }
  `, String(width), String(height), file], {encoding: 'utf8', timeout: 25000})
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), payload)
})
