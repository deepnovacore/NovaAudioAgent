import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto'
import {closeSync, constants, fstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs'
import {z} from 'zod'
import type {WebSocket} from 'ws'

const secret = z.string().regex(/^[a-f0-9]{32}$/u)
const deviceSchema = z.object({id: z.string().uuid(), name: z.string().min(1).max(80),
  created_at: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/u)}).strict()
const stateSchema = z.object({version: z.literal(1), owner: z.string(), devices: z.array(deviceSchema).max(32)}).strict()
type Device = z.infer<typeof deviceSchema>
const hash = (token: string): string => createHash('sha256').update(token).digest('hex')
const equal = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export function pairingEndpoint(text: string): string {
  if (text.length > 2048) throw new Error('invalid pairing address')
  const url = new URL(text)
  if (url.protocol !== 'wss:' || !url.hostname || url.username || url.password || url.search || url.hash
    || !['', '/', '/client/v1'].includes(url.pathname)) throw new Error('invalid pairing address')
  url.pathname = '/client/v1'
  return url.href
}

/** One host process owns this private store. No model credentials or raw device tokens are persisted. */
export class ClientPairing {
  readonly #devices: Device[]
  #pending: {hash: string; expires: number} | undefined
  readonly #connections = new Map<string, Set<() => void>>()
  #sockets = 0
  #attempts: number[] = []

  constructor(readonly master: string, readonly path: string, readonly now: () => number = Date.now) {
    secret.parse(master)
    let fd: number
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.#devices = []
      return
    }
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 32768
        || (process.getuid && stat.uid !== process.getuid())) throw new Error('invalid device store')
      const state = stateSchema.parse(JSON.parse(readFileSync(fd, 'utf8')) as unknown)
      if (state.owner !== hash(master)) throw new Error('device store belongs to another host token')
      this.#devices = state.devices
    } finally { closeSync(fd) }
  }

  #save(devices: Device[]): void {
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({version: 1, owner: hash(this.master), devices}), {flag: 'wx', mode: 0o600})
      renameSync(temporary, this.path)
    } finally {
      try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    this.#devices.splice(0, this.#devices.length, ...devices)
  }

  create(server: string): {type: 'nova.pair'; version: 1; server: string; code: string; expires_at: number} {
    const endpoint = pairingEndpoint(server)
    if (this.#devices.length >= 32) throw new Error('device limit reached')
    const code = randomBytes(16).toString('hex')
    const expires_at = this.now() + 120_000
    this.#pending = {hash: hash(code), expires: expires_at}
    return {type: 'nova.pair', version: 1, server: endpoint, code, expires_at}
  }

  cancel(code: string): void {
    if (this.#pending && equal(hash(secret.parse(code)), this.#pending.hash)) this.#pending = undefined
  }

  redeem(code: string, name: string): {type: 'pair.ready'; token: string; device_id: string} {
    secret.parse(code)
    const deviceName = z.string().trim().min(1).max(80).regex(/^[^\p{Cc}]*$/u).parse(name)
    if (!this.#pending || this.now() >= this.#pending.expires || !equal(hash(code), this.#pending.hash)
      || this.#devices.length >= 32) throw new Error('pairing unavailable')
    const token = randomBytes(16).toString('hex')
    const device = {id: randomUUID(), name: deviceName, created_at: this.now(), hash: hash(token)}
    this.#save([...this.#devices, device])
    this.#pending = undefined
    return {type: 'pair.ready', token, device_id: device.id}
  }

  accepts(token: unknown): boolean {
    if (!secret.safeParse(token).success) return false
    const value = token as string
    return equal(value, this.master) || this.#devices.some(device => equal(device.hash, hash(value)))
  }

  authenticate(raw: string): string {
    const hello = z.object({type: z.literal('hello'), token: secret}).parse(JSON.parse(raw) as unknown)
    if (!this.accepts(hello.token)) throw new Error('authentication failed')
    return hello.token
  }

  track(token: string, disconnect: () => void): () => void {
    const key = hash(token)
    const connections = this.#connections.get(key) ?? new Set<() => void>()
    connections.add(disconnect); this.#connections.set(key, connections)
    return () => { connections.delete(disconnect); if (!connections.size) this.#connections.delete(key) }
  }

  list(): Omit<Device, 'hash'>[] { return this.#devices.map(({id, name, created_at}) => ({id, name, created_at})) }

  revoke(id: string): void {
    z.string().uuid().parse(id)
    const device = this.#devices.find(device => device.id === id)
    if (!device) throw new Error('unknown device')
    this.#save(this.#devices.filter(device => device.id !== id))
    for (const close of [...(this.#connections.get(device.hash) ?? [])]) close()
  }

  /** Pairing sockets never acquire the active audio/control slot. One bounded request per socket. */
  handle(socket: WebSocket, path: string | undefined): boolean {
    if (path !== '/client/pair' && path !== '/client/pair-admin') return false
    if (this.#sockets >= 8) { socket.terminate(); return true }
    this.#sockets++
    const timeout = setTimeout(() => socket.terminate(), 5000)
    socket.once('close', () => { clearTimeout(timeout); this.#sockets-- })
    socket.once('message', (data, binary) => {
      let result: object = {type: 'pair.error', message: '配对失败：二维码已过期、已使用或请求无效。'}
      try {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
        if (binary || bytes.byteLength > 4096) throw new Error('invalid pairing frame')
        const raw = JSON.parse(bytes.toString('utf8')) as unknown
        if (path === '/client/pair-admin') {
          const frame = z.object({type: z.enum(['pair.create', 'pair.list', 'pair.revoke', 'pair.cancel']), token: secret,
            server: z.string().optional(), device_id: z.string().optional(), code: secret.optional()}).strict().parse(raw)
          if (!equal(frame.token, this.master)) throw new Error('authentication failed')
          if (frame.type === 'pair.create') result = this.create(frame.server ?? '')
          else {
            if (frame.type === 'pair.revoke') this.revoke(frame.device_id ?? '')
            if (frame.type === 'pair.cancel') this.cancel(frame.code ?? '')
            result = {type: 'pair.devices', devices: this.list(), pairing_active: Boolean(frame.code && this.#pending
              && this.now() < this.#pending.expires && equal(hash(frame.code), this.#pending.hash))}
          }
        } else {
          const now = this.now()
          this.#attempts = this.#attempts.filter(at => now - at < 60_000)
          if (this.#attempts.length >= 60) throw new Error('pairing rate limit')
          this.#attempts.push(now)
          const frame = z.object({type: z.literal('pair.redeem'), code: secret, device_name: z.string()}).strict().parse(raw)
          result = this.redeem(frame.code, frame.device_name)
        }
      } catch { /* Never echo a credential, input, file path or upstream error. */ }
      socket.send(JSON.stringify(result), () => socket.close(1000))
    })
    return true
  }
}
