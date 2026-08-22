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
    stdio: 'ignore',
    windowsHide: true,
  })
  process.stdout.write(`grandchild:${grandchild.pid}\n`)
} else if (mode === 'hold') {
  setInterval(() => {}, 1_000)
} else {
  process.exitCode = 2
}
