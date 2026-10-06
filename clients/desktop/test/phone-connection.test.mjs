import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {inspectPhoneNetwork, createManagedPhoneService} from '../src/main/phone-connection.mjs'

test('network readiness requires an HTTPS Serve target for this exact local port', () => {
  const status = {BackendState: 'Running', Self: {DNSName: 'mac.example.ts.net.'}}
  const serve = {TCP: {'443': {HTTPS: true}}, Web: {'mac.example.ts.net:443': {Handlers: {'/': {Proxy: 'http://127.0.0.1:19876'}}}}}
  assert.equal(inspectPhoneNetwork(status, serve, 19876).url, 'wss://mac.example.ts.net')
  assert.equal(inspectPhoneNetwork(status, serve, 19877).state, 'conflict')
  const shadowed = structuredClone(serve)
  shadowed.Web['mac.example.ts.net:443'].Handlers['/client'] = {Proxy: 'http://127.0.0.1:9999'}
  assert.equal(inspectPhoneNetwork(status, shadowed, 19876).state, 'conflict')
  assert.equal(inspectPhoneNetwork(status, {}, 19876).state, 'needs_serve')
  assert.equal(inspectPhoneNetwork(status, {AllowFunnel: {'mac.example.ts.net:443': true}}, 19876).state, 'public_endpoint')
  assert.equal(inspectPhoneNetwork({BackendState: 'NeedsLogin'}, {}, 19876).state, 'needs_login')
  assert.equal(inspectPhoneNetwork(status, {...serve, AllowFunnel: {'mac.example.ts.net:443': true}}, 19876).state, 'public_endpoint')
})

test('managed startup is shared and close joins an in-flight launch', async () => {
  let starts = 0, stops = 0
  let child
  const service = createManagedPhoneService({launch: async () => {
    starts++
    child = new EventEmitter()
    return child
  }, shutdown: async () => { stops++; child.emit('exit', 0) }})
  const first = service.start()
  const second = service.start()
  await new Promise(resolve => setImmediate(resolve))
  child.emit('message', {type: 'nova.phone.ready'})
  await Promise.all([first, second])
  assert.equal(starts, 1)
  await service.stop()
  assert.equal(stops, 1)
  assert.equal(service.running, false)
})

test('closing during startup shuts down the owned child and startup failure can retry', async () => {
  let child, starts = 0
  const service = createManagedPhoneService({launch: async () => { starts++; child = new EventEmitter(); return child },
    shutdown: async owned => owned.emit('exit', 0)})
  const opening = service.start()
  const rejected = assert.rejects(opening, /service_unavailable/)
  await new Promise(resolve => setImmediate(resolve))
  await service.stop()
  await rejected
  assert.equal(service.running, false)
  const retry = service.start()
  await new Promise(resolve => setImmediate(resolve))
  child.emit('message', {type: 'nova.phone.ready'})
  await retry
  assert.equal(starts, 2)
  await service.stop()
})

test('pairing admin responses enforce a bounded UTF-16 frame and reject protocol errors', async () => {
  const {requestPhonePairing} = await import('../src/main/phone-connection.mjs')
  let frame, socket
  class Socket extends EventTarget {
    constructor(url) { super(); assert.equal(url, 'ws://127.0.0.1:19876/client/pair-admin'); socket = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
    send(value) { frame = JSON.parse(value) }
    close() {}
  }
  for (const data of ['x'.repeat(16385), '{', JSON.stringify({type: 'pair.error'})]) {
    const result = requestPhonePairing({port: 19876, token: 'private'}, {type: 'pair.list'}, Socket)
    await Promise.resolve()
    assert.equal(frame.token, 'private')
    socket.dispatchEvent(new MessageEvent('message', {data}))
    await assert.rejects(result, /pairing_unavailable/)
  }
})

test('closing the panel during revoke or pre-create lookup cannot create another pairing code', async () => {
  const {readFile} = await import('node:fs/promises')
  const vm = await import('node:vm')
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('async function cancelPhonePairing('), source.indexOf('function openPairingWindow('))
  for (const deferredType of ['pair.revoke', 'pair.list', 'settings']) {
    let release, creates = 0
    const context = vm.createContext({acceptance: null, URL, Set, app: {}, process: {platform: 'darwin'},
      currentSettings: {phoneConnectionEnabled: true, phoneServerUrl: 'wss://host.example'},
      phoneEpoch: 0, phoneConfig: {port: 19876, token: 'private'}, phoneImage: 'old', phoneIssuedDevices: new Set(),
      phonePayload: deferredType === 'pair.revoke' ? {code: 'a'.repeat(32), server: 'wss://host.example/client/v1'} : undefined,
      managedPhone: {running: true, start: async () => {}},
      accessCredentials: operation => operation(),
      settingsWriter: () => new Promise(resolve => {release = resolve}),
      requestPhonePairing: async (_config, frame) => {
        if (frame.type === 'pair.create') creates++
        if (frame.type === deferredType) return new Promise(resolve => {release = resolve})
        return {devices: []}
      },
    })
    vm.runInContext(body, context)
    const pending = context.phoneAction(deferredType === 'settings' ? 'enable' : deferredType === 'pair.revoke' ? 'revoke' : 'refresh', 'device')
    await new Promise(resolve => setImmediate(resolve))
    await context.cancelPhonePairing()
    release({devices: []})
    assert.equal((await pending).state, 'idle')
    assert.equal(creates, 0)
  }
})

test('acceptance rejects phone actions before any settings, service, or pairing work', async () => {
  const {readFile} = await import('node:fs/promises')
  const vm = await import('node:vm')
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('async function cancelPhonePairing('), source.indexOf('function openPairingWindow('))
  const context = vm.createContext({acceptance: {}, phoneEpoch: 0})
  vm.runInContext(body, context)
  for (const action of ['cancel', 'install', 'login', 'help', 'disable', 'enable', 'network', 'revoke', 'refresh']) {
    await assert.rejects(context.phoneAction(action, 'device'), /acceptance_phone_disabled/)
  }
})

test('desktop-owned phone entry drains on parent shutdown before exiting', async () => {
  const {spawnSync} = await import('node:child_process')
  const target = new URL('../../../runtime/dist/src/desktop/phone-desktop-entry.js', import.meta.url).href
  const replacement = `import {writeSync} from 'node:fs'; export async function runServerEntry({stop, onDiagnostic}) {
    onDiagnostic('[server-ready] loopback');
    await new Promise(resolve => stop.signal.addEventListener('abort', resolve, {once: true}));
    writeSync(1, 'phone-drained'); return 0;
  }`
  const hook = `export async function resolve(specifier, context, next) {
    if (context.parentURL === ${JSON.stringify(target)} && specifier === '../server-entry.js') return {url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(replacement)}), shortCircuit: true};
    return next(specifier, context);
  }`
  const script = `import {register} from 'node:module'; import {EventEmitter} from 'node:events';
    process.parentPort = Object.assign(new EventEmitter(), {postMessage(frame) {
      if (frame.type === 'nova.phone.ready') queueMicrotask(() => process.parentPort.emit('message', {data: {type: 'nova.shutdown'}}));
    }});
    register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hook)}), import.meta.url);
    await import(${JSON.stringify(target)});`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8', timeout: 10000})
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'phone-drained')
})
