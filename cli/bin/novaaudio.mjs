#!/usr/bin/env node

import { main } from '../src/command.mjs'

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown failure'
  process.stderr.write(`novaaudio: ${message}\n`)
  process.exitCode = 1
}
