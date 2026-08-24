import {createReadStream, createWriteStream} from 'node:fs'

export const RELEASE_SMOKE_MODE = 'installed-candidate-v1'
export const SOURCE_ROLLBACK_UNAVAILABLE_RESULT = '{"type":"source_rollback_unavailable"}\n'

const TOKEN = /^[0-9a-f]{32}$/u
const ENDPOINT = /^ws:\/\/127\.0\.0\.1:([0-9]{1,5})\/$/u
const MAX_CONTROL_BYTES = 16

export function writeReleaseSmokeSourceRollback({
  environment,
  isPackaged,
  onDone,
  openOutput = () => createWriteStream('', {fd: 3, autoClose: false}),
}) {
  if (!isPackaged || environment?.NOVA_AUDIO_AGENT_RELEASE_SMOKE !== RELEASE_SMOKE_MODE) {
    return false
  }
  if (typeof onDone !== 'function') throw new Error('release_smoke_invalid')
  const output = openOutput()
  if (typeof output?.end !== 'function') throw new Error('release_smoke_invalid')
  let completed = false
  const finish = () => {
    if (completed) return
    completed = true
    onDone()
  }
  output.once?.('error', finish)
  output.end(SOURCE_ROLLBACK_UNAVAILABLE_RESULT, finish)
  return true
}

export function createReleaseSmokeChannel({
  environment,
  isPackaged,
  onQuit,
  openOutput = () => createWriteStream('', {fd: 3, autoClose: false}),
  openInput = () => createReadStream('', {fd: 4, autoClose: false}),
}) {
  if (!isPackaged || environment?.NOVA_AUDIO_AGENT_RELEASE_SMOKE !== RELEASE_SMOKE_MODE) {
    return null
  }
  if (typeof onQuit !== 'function') throw new Error('release_smoke_invalid')
  const output = openOutput()
  const input = openInput()
  if (typeof output?.write !== 'function' || typeof input?.on !== 'function') {
    throw new Error('release_smoke_invalid')
  }
  let closed = false
  let ready = false
  let control = Buffer.alloc(0)
  const close = () => {
    if (closed) return
    closed = true
    input.removeListener?.('data', receive)
    input.destroy?.()
    output.end?.()
  }
  const receive = chunk => {
    if (closed) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (control.length + bytes.length > MAX_CONTROL_BYTES) {
      close()
      return
    }
    control = Buffer.concat([control, bytes])
    const newline = control.indexOf(0x0a)
    if (newline < 0) return
    const command = control.subarray(0, newline + 1).toString('utf8')
    close()
    if (command === 'quit\n') onQuit()
  }
  input.on('data', receive)
  input.once?.('error', close)
  output.once?.('error', close)
  return Object.freeze({
    ready(value) {
      if (closed || ready || !TOKEN.test(value?.token ?? '')) {
        throw new Error('release_smoke_invalid')
      }
      const match = ENDPOINT.exec(value?.endpoint ?? '')
      const port = match === null ? 0 : Number(match[1])
      if (port < 1 || port > 65_535) throw new Error('release_smoke_invalid')
      ready = true
      output.write(`${JSON.stringify({type: 'ready', endpoint: value.endpoint, token: value.token})}\n`)
    },
    close,
  })
}
