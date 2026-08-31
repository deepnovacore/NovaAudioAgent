'use strict'

const assert = require('node:assert/strict')
const {spawnSync} = require('node:child_process')
const {win32} = require('node:path')

let currentUserSid = null

function bindWindowsCurrentOwner(path) {
  if (process.platform !== 'win32') return
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
  assert.ok(typeof systemRoot === 'string' && win32.isAbsolute(systemRoot))
  const options = {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }
  if (currentUserSid === null) {
    const identity = spawnSync(win32.join(systemRoot, 'System32', 'whoami.exe'), [
      '/user', '/fo', 'csv', '/nh',
    ], options)
    assert.equal(identity.status, 0, identity.stderr)
    const match = /^"[^"\r\n]{1,256}","(S-1-(?:[0-9]+-){1,15}[0-9]+)"\r?\n?$/u.exec(
      identity.stdout,
    )
    assert.ok(match !== null)
    currentUserSid = match[1]
  }
  const ownership = spawnSync(win32.join(systemRoot, 'System32', 'icacls.exe'), [
    path, '/setowner', `*${currentUserSid}`, '/Q',
  ], options)
  assert.equal(ownership.status, 0, ownership.stderr)
}

module.exports = {bindWindowsCurrentOwner}
