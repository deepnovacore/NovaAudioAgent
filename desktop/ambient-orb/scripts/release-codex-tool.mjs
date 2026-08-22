import {lstatSync, readFileSync, realpathSync} from 'node:fs'
import {resolve} from 'node:path'

import {parseStrictJson} from './strict-json.mjs'

const CODEX_VERSION = '0.147.0'
const MAX_PACKAGE_JSON_BYTES = 64 * 1024
const TARGETS = Object.freeze({
  'darwin-arm64': Object.freeze({suffix: 'darwin-arm64', triple: 'aarch64-apple-darwin', executable: 'codex'}),
  'darwin-x64': Object.freeze({suffix: 'darwin-x64', triple: 'x86_64-apple-darwin', executable: 'codex'}),
  'win32-x64': Object.freeze({suffix: 'win32-x64', triple: 'x86_64-pc-windows-msvc', executable: 'codex.exe'}),
  'linux-x64': Object.freeze({suffix: 'linux-x64', triple: 'x86_64-unknown-linux-musl', executable: 'codex'}),
})

function reject() {
  throw new Error('release_codex_tool_rejected')
}

function canonicalFile(path, {executable = false, platform = process.platform} = {}) {
  const lexical = resolve(path)
  const status = lstatSync(lexical)
  if (status.isSymbolicLink() || !status.isFile() || status.size <= 0) reject()
  if (realpathSync(lexical) !== lexical) reject()
  if (executable && platform !== 'win32' && (status.mode & 0o111) === 0) reject()
  return lexical
}

function readPackage(path) {
  const canonical = canonicalFile(path)
  const status = lstatSync(canonical)
  if (status.size > MAX_PACKAGE_JSON_BYTES) reject()
  return parseStrictJson(readFileSync(canonical, 'utf8'))
}

export function resolveProvisionedCodexBinary({installRoot, platform = process.platform, arch = process.arch}) {
  try {
    if (typeof installRoot !== 'string' || installRoot === '') reject()
    const root = resolve(installRoot)
    if (realpathSync(root) !== root) reject()
    const target = TARGETS[`${platform}-${arch}`]
    if (!target) reject()
    const alias = `@openai/codex-${target.suffix}`
    const rootPackage = readPackage(resolve(root, 'node_modules/@openai/codex/package.json'))
    if (
      rootPackage.name !== '@openai/codex'
      || rootPackage.version !== CODEX_VERSION
      || rootPackage.optionalDependencies?.[alias] !== `npm:@openai/codex@${CODEX_VERSION}-${target.suffix}`
    ) reject()
    const targetRoot = resolve(root, `node_modules/@openai/codex/node_modules/${alias}`)
    if (realpathSync(targetRoot) !== targetRoot) reject()
    const targetPackage = readPackage(resolve(targetRoot, 'package.json'))
    if (
      targetPackage.name !== '@openai/codex'
      || targetPackage.version !== `${CODEX_VERSION}-${target.suffix}`
      || targetPackage.os?.length !== 1
      || targetPackage.os[0] !== platform
      || targetPackage.cpu?.length !== 1
      || targetPackage.cpu[0] !== arch
    ) reject()
    return canonicalFile(
      resolve(targetRoot, `vendor/${target.triple}/bin/${target.executable}`),
      {executable: true, platform},
    )
  } catch {
    reject()
  }
}

export const RELEASE_CODEX_VERSION = CODEX_VERSION
