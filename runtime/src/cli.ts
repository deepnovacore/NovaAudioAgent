#!/usr/bin/env node

import { readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonicalJson } from './canonical-json.js'
import {buildDiagnosticReport} from './diagnostics.js'
import { loadRuntimeFixture, type RuntimeFixture } from './fixtures.js'
import { runRuntimeFixture } from './fixture-host.js'
import { fixtureManifestRegistry } from './sim.js'

export interface CliIo {
  readonly write: (text: string) => void
}

export async function checkRuntimeFixtures(fixtureRoot: string): Promise<number> {
  const directories = await fixtureDirectories(fixtureRoot)
  for (const directory of directories) {
    const fixture = await loadRuntimeFixture(directory)
    const actual = runRuntimeFixture(fixture, fixtureManifestRegistry)
    if (canonicalJson(actual) !== canonicalJson(fixture.expected)) {
      throw new Error(`fixture parity mismatch: ${fixture.manifest.id}`)
    }
  }
  return directories.length
}

export async function runDeterministicDemo(
  fixtureRoot: string,
  scenario: string,
): Promise<RuntimeFixture['expected']> {
  if (basename(scenario) !== scenario || scenario === '.' || scenario === '..') {
    throw new Error('demo scenario must be one fixture directory name')
  }
  const canonicalRoot = await realpath(fixtureRoot)
  const directory = await realpath(resolve(canonicalRoot, scenario))
  const pathFromRoot = relative(canonicalRoot, directory)
  if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new Error('demo scenario must stay inside the fixture root')
  }
  const fixture = await loadRuntimeFixture(directory)
  const actual = runRuntimeFixture(fixture, fixtureManifestRegistry)
  if (canonicalJson(actual) !== canonicalJson(fixture.expected)) {
    throw new Error(`fixture parity mismatch: ${fixture.manifest.id}`)
  }
  return actual
}

export async function main(
  args: readonly string[],
  options: {
    readonly cwd?: string
    readonly io?: CliIo
    readonly environment?: NodeJS.ProcessEnv
    readonly nodeVersion?: string
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? resolve(import.meta.dirname, '../../..')
  const io = options.io ?? {write: text => process.stdout.write(text)}
  const fixtureRoot = resolve(cwd, 'fixtures/runtime/v1')
  const [command, subcommand] = args
  if (command === 'fixture' && subcommand === 'check' && args.length === 2) {
    const count = await checkRuntimeFixtures(fixtureRoot)
    io.write(`Node fixture parity passed: ${count} scenario(s)\n`)
    return 0
  }
  if (command === 'diagnose' && subcommand === '--json' && args.length === 2) {
    const report = await buildDiagnosticReport({
      environment: options.environment ?? process.env,
      nodeVersion: options.nodeVersion ?? process.version,
    })
    io.write(`${canonicalJson(report)}\n`)
    return report.ok ? 0 : 1
  }
  if (command === 'demo' && args.length <= 2) {
    const scenario = subcommand ?? 'async-delegate-after-user'
    const snapshot = await runDeterministicDemo(fixtureRoot, scenario)
    io.write(`${canonicalJson(snapshot)}\n`)
    return 0
  }
  io.write('Usage: nova-audio-agent-node fixture check | demo [scenario] | diagnose --json\n')
  return 2
}

async function fixtureDirectories(fixtureRoot: string): Promise<string[]> {
  const entries = await readdir(fixtureRoot, {withFileTypes: true})
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => resolve(fixtureRoot, entry.name))
    .sort(compareStrings)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

const entry = process.argv[1]
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2))
}
