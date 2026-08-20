import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  AppServerRequestRejected,
  CodexProtocolError,
  JsonRpcConnection,
  MAX_JSONL_LINE,
  MAX_REQUEST,
  MAX_STDOUT,
} from '../src/codex-protocol.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function jsonLine(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`)
}

function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 0)
  const result = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

function paddedNotificationLine(size: number): Uint8Array {
  const prefix = encoder.encode('{"method":"future","params":{"padding":"')
  const suffix = encoder.encode('"}}\n')
  assert.ok(size >= prefix.byteLength + suffix.byteLength)
  const line = new Uint8Array(size)
  line.set(prefix)
  line.fill(0x78, prefix.byteLength, size - suffix.byteLength)
  line.set(suffix, size - suffix.byteLength)
  return line
}

function errorCode(error: unknown): string | undefined {
  return error instanceof CodexProtocolError ? error.code : undefined
}

async function settleUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  assert.fail(`did not settle: ${label}`)
}

test('requests are compact UTF-8 LF frames and responses may arrive out of order', async () => {
  const writes: Uint8Array[] = []
  const written: number[] = []
  const connection = new JsonRpcConnection({write: bytes => {
    writes.push(bytes)
    return Promise.resolve()
  }})

  const first = connection.request('turn/start', {input: ['星']}, {onWritten: id => written.push(id)})
  const second = connection.request('config/read', {})
  await settleUntil(() => writes.length === 2, 'two writes')

  assert.deepEqual(writes.map(value => decoder.decode(value)), [
    '{"method":"turn/start","id":1,"params":{"input":["星"]}}\n',
    '{"method":"config/read","id":2,"params":{}}\n',
  ])
  assert.deepEqual(written, [1])
  assert.deepEqual(connection.pendingRequestIds, [1, 2])

  await connection.feed(jsonLine({id: 2, result: {second: true}}))
  await connection.feed(jsonLine({id: 1, result: {first: true}}))
  assert.deepEqual(await first, {first: true})
  assert.deepEqual(await second, {second: true})
  connection.end()
})

test('request bytes are bounded exactly and unserializable values are private-safe', async () => {
  const writes: Uint8Array[] = []
  const connection = new JsonRpcConnection({write: bytes => {
    writes.push(bytes)
    return Promise.resolve()
  }})
  const base = encoder.encode('{"method":"m","id":1,"params":{"value":""}}\n').byteLength
  const exact = connection.request('m', {value: 'x'.repeat(MAX_REQUEST - base)})
  await Promise.resolve()
  assert.equal(writes[0]?.byteLength, MAX_REQUEST)
  await connection.feed(jsonLine({id: 1, result: null}))
  assert.equal(await exact, null)

  const over = await connection.request('m', {value: 'x'.repeat(MAX_REQUEST - base + 1)}).catch(errorCode)
  assert.equal(over, 'request_too_large')
  const secret = {token: 'DO-NOT-LEAK', value: 1n}
  const invalid = await connection.request('m', secret as never).catch(error => {
    assert.equal(String(error).includes('DO-NOT-LEAK'), false)
    return errorCode(error)
  })
  assert.equal(invalid, 'invalid_request')
  assert.deepEqual(connection.pendingRequestIds, [])
})

test('onWritten follows drain and a failed sink leaves no pending request', async () => {
  let release!: () => void
  const drain = new Promise<void>(resolve => { release = resolve })
  const marked: number[] = []
  const connection = new JsonRpcConnection({write: () => drain})
  const request = connection.request('turn/start', {}, {onWritten: id => marked.push(id)})
  await Promise.resolve()
  assert.deepEqual(marked, [])
  release()
  await settleUntil(() => marked.length === 1, 'onWritten')
  assert.deepEqual(marked, [1])
  await connection.feed(jsonLine({id: 1, result: true}))
  assert.equal(await request, true)

  const failed = new JsonRpcConnection({write: () => Promise.reject(new Error('PRIVATE SINK'))})
  const code = await failed.request('turn/start', {}).catch(error => {
    assert.equal(String(error).includes('PRIVATE SINK'), false)
    return errorCode(error)
  })
  assert.equal(code, 'stream_failure')
  assert.deepEqual(failed.pendingRequestIds, [])
})

test('abort EOF and server rejection during drain never expose the hidden deferred as unhandled', async () => {
  const unhandled: unknown[] = []
  const observe = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', observe)
  try {
    for (const scenario of ['abort', 'eof', 'server'] as const) {
      let release!: () => void
      const drain = new Promise<void>(resolve => { release = resolve })
      const controller = new AbortController()
      const connection = new JsonRpcConnection({write: () => drain})
      const request = connection.request('turn/start', {}, {signal: controller.signal})
      await settleUntil(() => connection.pendingRequestIds.length === 1, `${scenario} pending`)
      if (scenario === 'abort') controller.abort()
      else if (scenario === 'eof') connection.end()
      else await connection.feed(jsonLine({id: 1, error: {code: 7, message: 'PRIVATE'}}))
      await new Promise<void>(resolve => { setImmediate(resolve) })
      const outcome = request.catch((error: unknown) => error)
      release()
      const failure = await outcome
      if (scenario === 'abort') assert.equal((failure as {name?: unknown}).name, 'AbortError')
      else if (scenario === 'eof') assert.equal(errorCode(failure), 'transport_lost')
      else assert.equal(errorCode(failure), 'server_rejected')
      connection.end()
    }
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', observe)
  }
})

test('cancelled waiters accept a late response without poisoning later traffic', async () => {
  const controller = new AbortController()
  const writes: Uint8Array[] = []
  const connection = new JsonRpcConnection({write: bytes => {
    writes.push(bytes)
    return Promise.resolve()
  }})
  const cancelled = connection.request('turn/start', {}, {signal: controller.signal})
  await Promise.resolve()
  controller.abort()
  await assert.rejects(cancelled, {name: 'AbortError'})
  await connection.feed(jsonLine({id: 1, result: {private: 'discard'}}))

  const following = connection.request('config/read', {})
  await Promise.resolve()
  assert.equal(writes.length, 2)
  await connection.feed(jsonLine({id: 2, result: {safe: true}}))
  assert.deepEqual(await following, {safe: true})
})

test('a request cancelled while queued never crosses the write boundary', async () => {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const writes: Uint8Array[] = []
  const connection = new JsonRpcConnection({write: bytes => {
    writes.push(bytes)
    return writes.length === 1 ? blocked : Promise.resolve()
  }})
  const first = connection.request('first', {})
  await settleUntil(() => writes.length === 1, 'first write')
  const controller = new AbortController()
  let secondOutcome: unknown
  const second = connection.request('second', {}, {signal: controller.signal}).then(
    value => { secondOutcome = value },
    error => { secondOutcome = error },
  )
  controller.abort()
  release()
  await settleUntil(() => writes.length === 2 || secondOutcome !== undefined, 'queued cancellation')
  if (writes.length === 2) await connection.feed(jsonLine({id: 2, result: 'unexpected-write'}))
  await second
  await connection.feed(jsonLine({id: 1, result: 'first'}))
  assert.equal(await first, 'first')
  assert.equal((secondOutcome as {name?: unknown}).name, 'AbortError')
  assert.equal(writes.length, 1)
})

test('unsafe outgoing integers are rejected before a frame is written', async () => {
  const writes: Uint8Array[] = []
  let failure: string | undefined
  const connection = new JsonRpcConnection({write: bytes => {
    writes.push(bytes)
    return Promise.resolve()
  }})
  const request = connection.request('m', {value: Number.MAX_SAFE_INTEGER + 1}).catch(error => {
    failure = errorCode(error)
  })
  await settleUntil(() => writes.length === 1 || failure !== undefined, 'unsafe integer rejection')
  if (writes.length === 1) await connection.feed(jsonLine({id: 1, result: null}))
  await request
  assert.equal(failure, 'invalid_request')
  assert.deepEqual(writes, [])
})

test('direct request objects reject accessors and every non-JSON own shape before writing', async () => {
  let getterReads = 0
  const accessor: Record<string, unknown> = {}
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get: () => {
      getterReads += 1
      return getterReads === 1 ? 'legal' : Number.NaN
    },
  })
  const symbolKey = {value: 'legal'} as Record<PropertyKey, unknown>
  symbolKey[Symbol('private')] = 'PRIVATE'
  const nonEnumerable: Record<string, unknown> = {}
  Object.defineProperty(nonEnumerable, 'private', {enumerable: false, value: 'PRIVATE'})
  const inherited = Object.create({private: 'PRIVATE'}) as Record<string, unknown>
  inherited.value = 'legal'
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const loneKey = Object.create(null) as Record<string, unknown>
  loneKey['\ud800'] = 'value'
  const cases: readonly unknown[] = [
    accessor,
    symbolKey,
    nonEnumerable,
    inherited,
    {value: new String('boxed')},
    cyclic,
    {value: () => 'PRIVATE'},
    {value: 1n},
    {value: Number.NaN},
    {value: '\ud800'},
    loneKey,
    {value: undefined},
  ]
  for (const params of cases) {
    const writes: Uint8Array[] = []
    let outcome: unknown
    const connection = new JsonRpcConnection({write: bytes => {
      writes.push(bytes)
      return Promise.resolve()
    }})
    const request = connection.request('m', params as never).then(
      value => { outcome = value },
      error => { outcome = error },
    )
    await settleUntil(() => writes.length > 0 || outcome !== undefined, 'direct request verdict')
    if (writes.length > 0) await connection.feed(jsonLine({id: 1, result: 'unexpected-write'}))
    await request
    assert.equal(errorCode(outcome), 'invalid_request')
    assert.deepEqual(writes, [])
  }
  assert.equal(getterReads, 0)
})

test('incremental framing handles split and coalesced lines and forwards safe notifications', async () => {
  const notifications: unknown[] = []
  const connection = new JsonRpcConnection({
    write: () => Promise.resolve(),
    onNotification: value => notifications.push(value),
  })
  const request = connection.request('m', {})
  await Promise.resolve()
  const bytes = encoder.encode(
    '{"method":"future/event","params":{"safe":true}}\n{"id":1,"result":{"ok":true}}\n',
  )
  await connection.feed(bytes.subarray(0, 5))
  await connection.feed(bytes.subarray(5, 37))
  await connection.feed(bytes.subarray(37))
  assert.deepEqual(notifications, [{method: 'future/event', params: {safe: true}}])
  assert.deepEqual(await request, {ok: true})
})

test('a feed arriving in the drain-finalizer window is routed before its shared promise settles', async () => {
  const notifications: unknown[] = []
  const connection = new JsonRpcConnection({
    write: () => Promise.resolve(),
    onNotification: value => { notifications.push(value) },
  })
  const first = connection.feed(encoder.encode('{"method":"future"'))
  let second: Promise<void> | undefined
  queueMicrotask(() => {
    second = connection.feed(encoder.encode('}\n'))
  })
  await first
  assert.equal(second, first)
  await second
  assert.deepEqual(notifications, [{method: 'future', params: {}}])
  assert.equal(connection.end(), undefined)
})

test('raw feed input rejects Proxy and non-Uint8 views without invoking private traps', async () => {
  let trapReads = 0
  const proxied = new Proxy(new Uint8Array([0x0a]), {
    get: () => {
      trapReads += 1
      throw new Error('PRIVATE BYTE TRAP')
    },
  })
  for (const input of [proxied, new Uint16Array([0x0a]), new DataView(new ArrayBuffer(1))]) {
    const connection = new JsonRpcConnection({write: () => Promise.resolve()})
    const failure = await connection.feed(input as never).catch((error: unknown) => error)
    assert.equal(errorCode(failure), 'malformed_jsonl')
    assert.equal(String(failure).includes('PRIVATE'), false)
  }
  assert.equal(trapReads, 0)

  let ownGetterReads = 0
  const hostile = new Uint8Array([0x0a])
  Object.defineProperty(hostile, 'byteLength', {
    get: () => {
      ownGetterReads += 1
      throw new Error('PRIVATE BYTE LENGTH')
    },
  })
  const connection = new JsonRpcConnection({write: () => Promise.resolve()})
  const failure = await connection.feed(hostile).catch((error: unknown) => error)
  assert.equal(errorCode(failure), 'malformed_jsonl')
  assert.equal(String(failure).includes('PRIVATE'), false)
  assert.equal(ownGetterReads, 1)
})

test('server requests are observed by method only and refused with the fixed error', async () => {
  const writes: Uint8Array[] = []
  const methods: string[] = []
  const connection = new JsonRpcConnection({
    write: bytes => {
      writes.push(bytes)
      return Promise.resolve()
    },
    onServerRequest: method => methods.push(method),
  })
  await connection.feed(encoder.encode(
    '{"id":"opaque","method":"item/commandExecution/requestApproval","params":{"secret":"DROP"}}\n',
  ))
  assert.deepEqual(methods, ['item/commandExecution/requestApproval'])
  assert.equal(
    decoder.decode(writes[0]),
    '{"id":"opaque","error":{"code":-32601,"message":"Method not implemented"}}\n',
  )
  assert.equal(JSON.stringify({methods, writes: writes.map(value => decoder.decode(value))}).includes('DROP'), false)
})

test('response rejection exposes only stable code and numeric server code', async () => {
  const connection = new JsonRpcConnection({write: () => Promise.resolve()})
  const request = connection.request('m', {})
  await Promise.resolve()
  await connection.feed(jsonLine({id: 1, error: {code: 42, message: 'PRIVATE', data: {token: 'DROP'}}}))
  await assert.rejects(request, error => {
    assert.ok(error instanceof AppServerRequestRejected)
    assert.equal(error.code, 'server_rejected')
    assert.equal(error.server_code, 42)
    assert.equal(String(error).includes('PRIVATE'), false)
    return true
  })
})

test('malformed grammars and unknown response IDs poison the connection with safe codes', async () => {
  const cases: readonly [Uint8Array, string][] = [
    [encoder.encode('not json\n'), 'malformed_jsonl'],
    [Uint8Array.of(0xc3, 0x28, 0x0a), 'malformed_jsonl'],
    [encoder.encode('{"value":NaN}\n'), 'malformed_jsonl'],
    [jsonLine({method: 'event', params: null}), 'malformed_jsonl'],
    [jsonLine({method: 'event', params: []}), 'malformed_jsonl'],
    [jsonLine({id: true, result: {}}), 'malformed_jsonl'],
    [jsonLine({id: 1, result: {}, extra: true}), 'unknown_response_id'],
    [jsonLine({id: 999, result: {secret: 'DROP'}}), 'unknown_response_id'],
  ]
  for (const [line, wanted] of cases) {
    const connection = new JsonRpcConnection({write: () => Promise.resolve()})
    await assert.rejects(connection.feed(line), error => errorCode(error) === wanted)
    await assert.rejects(connection.notify('after/failure'), error => errorCode(error) === wanted)
  }
})

test('duplicate responses and malformed matching responses poison deterministically', async () => {
  const duplicate = new JsonRpcConnection({write: () => Promise.resolve()})
  const completed = duplicate.request('m', {})
  await Promise.resolve()
  const response = jsonLine({id: 1, result: true})
  await duplicate.feed(response)
  assert.equal(await completed, true)
  await assert.rejects(duplicate.feed(response), error => errorCode(error) === 'unknown_response_id')

  const malformed = new JsonRpcConnection({write: () => Promise.resolve()})
  const pending = malformed.request('m', {})
  await Promise.resolve()
  let feedFailure: unknown
  await malformed.feed(jsonLine({id: 1, result: true, extra: true})).catch(error => {
    feedFailure = error
  })
  const pendingFailure = await pending.catch((error: unknown) => error)
  assert.equal(errorCode(feedFailure), 'malformed_jsonl')
  assert.equal(pendingFailure, feedFailure)
})

test('line and aggregate inbound byte bounds include LF', async () => {
  const exact = new JsonRpcConnection({write: () => Promise.resolve()})
  const prefix = encoder.encode('{"method":"future","params":{"padding":"')
  const suffix = encoder.encode('"}}\n')
  const line = new Uint8Array(MAX_JSONL_LINE)
  line.set(prefix)
  line.fill(0x78, prefix.byteLength, MAX_JSONL_LINE - suffix.byteLength)
  line.set(suffix, MAX_JSONL_LINE - suffix.byteLength)
  await exact.feed(line)

  const over = new JsonRpcConnection({write: () => Promise.resolve()})
  await assert.rejects(over.feed(new Uint8Array(MAX_JSONL_LINE + 1).fill(0x78)), error => (
    errorCode(error) === 'stdout_line_too_large'
  ))

  const total = new JsonRpcConnection({write: () => Promise.resolve()})
  const small = jsonLine({method: 'future'})
  const repetitions = Math.floor(MAX_STDOUT / small.byteLength)
  for (let index = 0; index < repetitions; index += 1) await total.feed(small)
  const remaining = MAX_STDOUT - repetitions * small.byteLength
  if (remaining > 0) await total.feed(new Uint8Array(remaining).fill(0x20))
  await assert.rejects(total.feed(Uint8Array.of(0x0a)), error => errorCode(error) === 'stdout_too_large')
})

test('aggregate overflow routes every earlier complete response independent of feed splitting', async () => {
  const prefix = Array.from({length: 7}, () => paddedNotificationLine(MAX_JSONL_LINE))
  const response = jsonLine({id: 1, result: 'safe'})
  const tail = paddedNotificationLine(MAX_STDOUT - 7 * MAX_JSONL_LINE - response.byteLength)
  const exactStream = joinBytes([...prefix, response, tail])
  const overStream = joinBytes([exactStream, Uint8Array.of(0x20)])
  assert.equal(exactStream.byteLength, MAX_STDOUT)

  for (const split of [false, true]) {
    const connection = new JsonRpcConnection({write: () => Promise.resolve()})
    const outcome = connection.request('m', {}).then(
      value => ({kind: 'value' as const, value}),
      (error: unknown) => ({kind: 'error' as const, error}),
    )
    await settleUntil(() => connection.pendingRequestIds.length === 1, 'pending request')
    const failure = split
      ? await connection.feed(exactStream).then(
        () => connection.feed(Uint8Array.of(0x20)).catch((error: unknown) => error),
      )
      : await connection.feed(overStream).catch((error: unknown) => error)
    assert.equal(errorCode(failure), 'stdout_too_large')
    assert.deepEqual(await outcome, {kind: 'value', value: 'safe'})
  }
})

test('single-byte feeds share one bounded linear-copy drain up to the exact line limit', async () => {
  let allocated = 0
  let copied = 0
  const options = {
    write: () => Promise.resolve(),
    onBufferAllocate: (bytes: number) => { allocated += bytes },
    onBufferCopy: (bytes: number) => { copied += bytes },
  }
  const connection = new JsonRpcConnection(options)
  let shared: Promise<void> | undefined
  for (let index = 0; index < MAX_JSONL_LINE; index += 1) {
    const current = connection.feed(Uint8Array.of(0x78))
    if (shared === undefined) shared = current
    else assert.equal(current, shared)
  }
  await shared
  assert.equal(copied, MAX_JSONL_LINE * 2)
  assert.ok(allocated <= MAX_JSONL_LINE * 2)
  await assert.rejects(connection.feed(Uint8Array.of(0x78)), error => (
    errorCode(error) === 'stdout_line_too_large'
  ))
})

test('sequential awaited one-byte feeds retain one bounded line buffer and one reusable slab', async () => {
  const line = paddedNotificationLine(8192)
  let allocated = 0
  let copied = 0
  const notifications: unknown[] = []
  const connection = new JsonRpcConnection({
    write: () => Promise.resolve(),
    onBufferAllocate: bytes => { allocated += bytes },
    onBufferCopy: bytes => { copied += bytes },
    onNotification: value => { notifications.push(value) },
  })
  for (const byte of line) await connection.feed(Uint8Array.of(byte))
  assert.equal(copied, line.byteLength * 2)
  assert.ok(allocated <= MAX_JSONL_LINE + 4096)
  assert.equal(notifications.length, 1)
})

test('end fans the same transport-lost error to all active waiters exactly once', async () => {
  const connection = new JsonRpcConnection({write: () => Promise.resolve()})
  const first = connection.request('a', {})
  const second = connection.request('b', {})
  await Promise.resolve()
  const failure = connection.end()
  assert.equal(failure?.code, 'transport_lost')
  const errors = await Promise.all([
    first.catch((error: unknown) => error),
    second.catch((error: unknown) => error),
  ])
  assert.equal(errors[0], errors[1])
  assert.equal(errors[0], failure)
  assert.deepEqual(connection.pendingRequestIds, [])
  await assert.rejects(connection.request('later', {}), error => error === failure)
})
