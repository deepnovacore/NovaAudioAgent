'use strict'

const {appendFileSync} = require('node:fs')
const {spawn} = require('node:child_process')

const mode = process.argv[2]
if (mode === undefined) {
  // `node --test` discovers fixture `.cjs` files recursively; direct discovery is inert.
} else if (mode === 'grandchild') {
  const marker = process.argv[3]
  setInterval(() => {
    try { appendFileSync(marker, 'alive\n') } catch { /* the Windows owner test may be cleaning up */ }
  }, 25)
} else if (mode === 'leader-first') {
  const marker = process.argv[3]
  const grandchild = spawn(process.execPath, [__filename, 'grandchild', marker], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  grandchild.unref()
  process.stdout.write(`grandchild:${grandchild.pid}\n`)
} else if (mode === 'hold') {
  setInterval(() => {}, 1_000)
} else if (mode === 'smoke-tree') {
  const grandchild = spawn(process.execPath, [__filename, 'hold'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  process.stdout.write(`grandchild:${grandchild.pid}\n`)
  setInterval(() => {}, 1_000)
} else if (mode === 'smoke-output-flood') {
  process.stdout.write('x'.repeat(70 * 1024))
  setInterval(() => {}, 1_000)
} else {
  process.exitCode = 2
}
