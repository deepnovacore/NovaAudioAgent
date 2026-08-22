import assert from 'node:assert/strict'
import {chmod, mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, resolve} from 'node:path'
import test from 'node:test'

import {resolveProvisionedCodexBinary} from '../scripts/release-codex-tool.mjs'

const VERSION = '0.147.0'
const CASES = [
  ['darwin', 'arm64', 'darwin-arm64', 'aarch64-apple-darwin', 'codex'],
  ['darwin', 'x64', 'darwin-x64', 'x86_64-apple-darwin', 'codex'],
  ['win32', 'x64', 'win32-x64', 'x86_64-pc-windows-msvc', 'codex.exe'],
  ['linux', 'x64', 'linux-x64', 'x86_64-unknown-linux-musl', 'codex'],
]

async function provision(root, platform, arch, suffix, triple, executable) {
  const packageName = `codex-${suffix}`
  const rootPackage = resolve(root, 'node_modules/@openai/codex/package.json')
  const targetPackage = resolve(
    root,
    `node_modules/@openai/codex/node_modules/@openai/${packageName}/package.json`,
  )
  const binary = resolve(dirname(targetPackage), `vendor/${triple}/bin/${executable}`)
  await mkdir(dirname(binary), {recursive: true})
  await mkdir(dirname(rootPackage), {recursive: true})
  await writeFile(rootPackage, JSON.stringify({
    name: '@openai/codex',
    version: VERSION,
    optionalDependencies: {
      [`@openai/${packageName}`]: `npm:@openai/codex@${VERSION}-${suffix}`,
    },
  }))
  await writeFile(targetPackage, JSON.stringify({
    name: '@openai/codex',
    version: `${VERSION}-${suffix}`,
    os: [platform === 'win32' ? 'win32' : platform],
    cpu: [arch],
  }))
  await writeFile(binary, 'native-codex')
  await chmod(binary, 0o700)
  return binary
}

test('pinned provisioning resolves only the exact target-native Codex executable', async () => {
  for (const [platform, arch, suffix, triple, executable] of CASES) {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'nova-release-codex-')))
    try {
      const expected = await provision(root, platform, arch, suffix, triple, executable)
      assert.equal(resolveProvisionedCodexBinary({installRoot: root, platform, arch}), expected)
      await writeFile(
        resolve(
          root,
          `node_modules/@openai/codex/node_modules/@openai/codex-${suffix}/package.json`,
        ),
        JSON.stringify({name: '@openai/codex', version: '0.147.1', os: [platform], cpu: [arch]}),
      )
      assert.throws(
        () => resolveProvisionedCodexBinary({installRoot: root, platform, arch}),
        /release_codex_tool_rejected/u,
      )
    } finally {
      await rm(root, {recursive: true, force: true})
    }
  }
})

test('provisioning rejects wrapper paths, symlinked binaries, and unsupported tuples', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'nova-release-codex-reject-')))
  try {
    const binary = await provision(root, ...CASES[0])
    const wrapper = resolve(root, 'node_modules/@openai/codex/bin/codex.js')
    await mkdir(dirname(wrapper), {recursive: true})
    await writeFile(wrapper, '#!/usr/bin/env node\n')
    assert.notEqual(resolveProvisionedCodexBinary({installRoot: root, platform: 'darwin', arch: 'arm64'}), wrapper)
    await rm(binary)
    await writeFile(resolve(root, 'elsewhere'), 'native-codex')
    await import('node:fs/promises').then(({symlink}) => symlink(resolve(root, 'elsewhere'), binary))
    assert.throws(
      () => resolveProvisionedCodexBinary({installRoot: root, platform: 'darwin', arch: 'arm64'}),
      /release_codex_tool_rejected/u,
    )
    assert.throws(
      () => resolveProvisionedCodexBinary({installRoot: root, platform: 'linux', arch: 'arm64'}),
      /release_codex_tool_rejected/u,
    )
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})
