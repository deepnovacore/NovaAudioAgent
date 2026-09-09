import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import test from 'node:test'

import * as debugBoardClient from '../src/main/debug-board-client.mjs'

const {
  createDebugBoardRequester,
  formatMemoryBoardExport,
  requestDebugBoard,
} = debugBoardClient

const CONNECTION = Object.freeze({
  endpoint: 'ws://127.0.0.1:32123',
  token: '0123456789abcdef0123456789abcdef',
})

class FakeSocket extends EventEmitter {
  static OPEN = 1
  readyState = 0
  sent = []
  closed = false
  terminated = false

  send(value) {
    this.sent.push(value)
  }

  close() {
    this.closed = true
  }

  terminate() {
    this.terminated = true
  }

  open() {
    this.readyState = FakeSocket.OPEN
    this.emit('open')
  }
}

test('memory board export formatting validates and bounds the full snapshot once for copy and save', () => {
  assert.equal(typeof formatMemoryBoardExport, 'function')
  const formatted = formatMemoryBoardExport({
    channels: [{name: 'conversation', summary: null, item_count: 1, items: [{seq: 1}]}],
    diagnostics: {
      version: 1,
      records: [{seq: 2, ts: 3.5, kind: 'runtime', payload: {ok: true}}],
    },
  }, {now: () => new Date('2026-09-02T03:00:00.000Z')})

  assert.deepEqual(formatted, {
    body: '{\n  "exported_at": "2026-09-02T03:00:00.000Z",\n  "channels": [\n    {\n      "name": "conversation",\n      "summary": null,\n      "item_count": 1,\n      "items": [\n        {\n          "seq": 1\n        }\n      ]\n    }\n  ],\n  "diagnostics": {\n    "version": 1,\n    "records": [\n      {\n        "seq": 2,\n        "ts": 3.5,\n        "kind": "runtime",\n        "payload": {\n          "ok": true\n        }\n      }\n    ]\n  }\n}',
    stamp: '2026-09-02T03-00-00-000Z',
  })
  assert.deepEqual(formatMemoryBoardExport({channels: [], diagnostics: {version: 2, records: []}}), {
    error: 'invalid_payload',
  })
})

test('debug board client authenticates on the isolated path and accepts only its response', async () => {
  let socket
  let openedUrl = null
  const pending = requestDebugBoard(CONNECTION, {board: 'memory', detail: 'compact'}, {
    randomId: () => 'debug-0123456789abcdef',
    createSocket: url => {
      openedUrl = url
      socket = new FakeSocket()
      return socket
    },
  })

  socket.open()
  assert.equal(openedUrl, 'ws://127.0.0.1:32123/debug-board')
  assert.deepEqual(socket.sent.map(value => JSON.parse(value)), [{
    type: 'hello', token: CONNECTION.token,
  }, {
    type: 'debug.board.request',
    request_id: 'debug-0123456789abcdef',
    board: 'memory',
    detail: 'compact',
  }])

  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'memory.board',
    request_id: 'debug-0123456789abcdef',
    diagnostics: {version: 1, records: []},
    channels: [],
  })), false)
  assert.deepEqual(await pending, {
    type: 'memory.board',
    request_id: 'debug-0123456789abcdef',
    diagnostics: {version: 1, records: []},
    channels: [],
  })
  assert.equal(socket.closed, true)
})

test('debug board requester coalesces equal in-flight snapshots per backend connection', async () => {
  let calls = 0
  const resolvers = []
  const request = createDebugBoardRequester({
    request: () => {
      calls += 1
      return new Promise(resolve => { resolvers.push(resolve) })
    },
  })

  const first = request(CONNECTION, {board: 'memory', detail: 'compact'})
  const second = request(CONNECTION, {board: 'memory', detail: 'compact'})
  const full = request(CONNECTION, {board: 'memory', detail: 'full'})
  assert.equal(first, second)
  assert.notEqual(first, full)
  assert.equal(calls, 2)
  resolvers[0]({type: 'memory.board', detail: 'compact'})
  resolvers[1]({type: 'memory.board', detail: 'full'})
  assert.deepEqual(await first, {type: 'memory.board', detail: 'compact'})
  assert.deepEqual(await second, {type: 'memory.board', detail: 'compact'})
  assert.deepEqual(await full, {type: 'memory.board', detail: 'full'})
})

test('a timeout that fires during scheduling settles without opening a socket', async () => {
  let sockets = 0
  let cancelled = null
  await assert.rejects(requestDebugBoard(CONNECTION, {board: 'memory', detail: 'compact'}, {
    randomId: () => 'debug-0123456789abcdef',
    scheduleTimeout: callback => {
      callback()
      return 7
    },
    cancelTimeout: timer => { cancelled = timer },
    createSocket: () => {
      sockets += 1
      return new FakeSocket()
    },
  }), error => error?.code === 'timeout')

  assert.equal(sockets, 0)
  assert.equal(cancelled, 7)
})
