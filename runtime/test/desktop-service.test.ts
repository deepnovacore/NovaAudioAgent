import assert from 'node:assert/strict'
import {test} from 'node:test'
import {RealtimeDesktopService} from '../src/desktop-service.js'

test('desktop owner rejects an invalid wrapper grace before touching resources', () => {
  const untouched = (): never => { throw new Error('resource was touched') }
  assert.throws(() => new RealtimeDesktopService({
    realtime: {
      service: {waitStopped: untouched},
      start: untouched,
      stop: untouched,
    },
    desktop: {server: {start: untouched, close: untouched}},
    readyEndpoint: '127.0.0.1:51515',
    stop: new AbortController(),
    announce: untouched,
    cleanupGraceMs: 0,
  }), /desktop cleanup grace must be positive and finite/u)
})
