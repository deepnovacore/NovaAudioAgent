#!/usr/bin/env node

import { posix, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

import { main as startClient } from './start-client.mjs'

const DEMO_VIDEO_PARTS = Object.freeze([
  'assets',
  'demos',
  'cat-sofa-guard',
  'cat-sofa-guard.mp4',
])

export function demoClientEnvironment({
  environment,
  rootDir,
  pathApi = process.platform === 'win32' ? win32 : posix,
}) {
  return {
    ...environment,
    NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE: pathApi.resolve(rootDir, ...DEMO_VIDEO_PARTS),
  }
}

export async function main({
  argv = process.argv.slice(2),
  environment = process.env,
  platform = process.platform,
  rootDir = resolve(import.meta.dirname, '..'),
} = {}) {
  const pathApi = platform === 'win32' ? win32 : posix
  return startClient({
    argv,
    env: demoClientEnvironment({ environment, rootDir, pathApi }),
    platform,
    rootDir,
  })
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : 'demo client launch failed'
    process.stderr.write(`error: ${message}\n`)
    process.exitCode = 1
  })
}
