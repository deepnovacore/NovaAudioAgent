import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import test from 'node:test'

// electron-builder.yml is small and structurally simple (two-space indents,
// no anchors/aliases, no flow collections except the `[a, b]` target lists),
// so a hand-rolled block parser is enough to assert its shape without adding
// a YAML dependency. It only needs to answer: which top-level key is a line
// under, and what are this key's scalar/list/mapping values.

const CONFIG_PATH = resolve(import.meta.dirname, '../electron-builder.yml')
const PACKAGE_JSON_PATH = resolve(import.meta.dirname, '../package.json')
const ROOT_PACKAGE_JSON_PATH = resolve(import.meta.dirname, '../../../package.json')
const CI_WORKFLOW_PATH = resolve(import.meta.dirname, '../../../.github/workflows/ci.yml')
const UNSIGNED_WORKFLOW_PATH = resolve(import.meta.dirname, '../../../.github/workflows/unsigned-packages.yml')
const ENTITLEMENTS_PATH = resolve(import.meta.dirname, '../resources/entitlements.mac.plist')
const INHERIT_ENTITLEMENTS_PATH = resolve(import.meta.dirname, '../resources/entitlements.mac.inherit.plist')
const HTML_PATH = resolve(import.meta.dirname, '../src/renderer/index.html')
const EXPECTED_BUILD_SCRIPTS = [
  'src/main/main.mjs',
  'src/main/app-protocol.mjs',
  'src/main/camera-source.mjs',
  'src/main/backend.mjs',
  'src/main/security.mjs',
  'src/main/native-audio.mjs',
  'src/main/release-smoke-channel.mjs',
  'src/main/startup-diagnostics.mjs',
  'src/main/drag-controller.mjs',
  'src/main/settings-store.mjs',
  'src/renderer/index.mjs',
  'src/renderer/camera.mjs',
  'src/renderer/release-camera.mjs',
  'src/renderer/release-camera-contract.mjs',
  'src/renderer/audio.mjs',
  'src/renderer/state.mjs',
  'src/renderer/orb-visual.mjs',
  'src/renderer/settings.mjs',
  'scripts/utility-runtime-smoke.mjs',
  'scripts/source-startup-smoke.mjs',
  'scripts/packaged-runtime-import-smoke.cjs',
  'scripts/run-packaged-import-smoke.mjs',
  'scripts/packaged-production-codex-smoke.cjs',
  'scripts/run-packaged-codex-smoke.mjs',
  'scripts/run-release-candidate-codex-smoke.mjs',
  'scripts/release-codex-tool.mjs',
  'scripts/sign-mac-with-native-manifest.cjs',
  'scripts/after-sign.cjs',
  'scripts/installed-candidate-smoke.mjs',
  'scripts/collect-release-artifacts.mjs',
  'scripts/generate-pending-release-ledger.mjs',
  'scripts/generate-release-candidate-report.mjs',
  'scripts/finalize-mac-notarization.mjs',
  'scripts/verify-github-release-attestations.mjs',
  'scripts/require-release-signing.mjs',
  'scripts/verify-signed-candidate.mjs',
  'scripts/prepare-release-smoke-kit.mjs',
  'scripts/release-smoke-certificate.mjs',
  'scripts/assemble-release-artifact-root.mjs',
  'scripts/inspect-package.mjs',
  'scripts/camera-file-integration.mjs',
  'scripts/camera-file-integration-contract.mjs',
  'scripts/camera-file-integration-renderer.mjs',
  'scripts/camera-file-integration-mutations.mjs',
  'scripts/build-contract.mjs',
]

function indentOf(line) {
  const match = /^( *)/.exec(line)
  return match[1].length
}

// Strips full-line and trailing comments outside of quotes. Good enough for
// this file: no `#` ever appears inside a quoted value here.
function stripComment(line) {
  const hashIndex = line.indexOf('#')
  if (hashIndex === -1) return line
  return line.slice(0, hashIndex)
}

// Parses the flat subset of YAML this file uses into a plain JS tree: maps,
// lists of scalars, lists of maps (for extraResources' `- from:/to:` items),
// and inline `[a, b]` lists.
function parseYaml(text) {
  const rawLines = text.split('\n')
  const lines = []
  for (const raw of rawLines) {
    const stripped = stripComment(raw)
    if (stripped.trim() === '') continue
    lines.push({ indent: indentOf(stripped), text: stripped.trim() })
  }

  let pos = 0

  function parseInlineList(value) {
    const inner = value.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((item) => parseScalar(item.trim()))
  }

  function parseScalar(value) {
    if (value.startsWith('[') && value.endsWith(']')) return parseInlineList(value)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1)
    }
    if (value === 'true') return true
    if (value === 'false') return false
    return value
  }

  function parseBlockScalar(parentIndent) {
    const values = []
    while (pos < lines.length && lines[pos].indent > parentIndent) {
      values.push(lines[pos].text)
      pos += 1
    }
    return values.join('\n')
  }

  // Parses every line whose indent is >= minIndent into a block (map or
  // list), stopping as soon as a line falls back below minIndent.
  function parseBlock(minIndent) {
    if (pos >= lines.length || lines[pos].indent < minIndent) return {}
    const blockIndent = lines[pos].indent
    const isList = lines[pos].text.startsWith('- ') || lines[pos].text === '-'

    if (isList) {
      const items = []
      while (pos < lines.length && lines[pos].indent === blockIndent && lines[pos].text.startsWith('-')) {
        const rest = lines[pos].text.slice(1).trim()
        if (rest === '') {
          pos += 1
          items.push(parseBlock(blockIndent + 1))
          continue
        }
        // `- key: value` starts a map item whose first key is inline.
        const colonIndex = rest.indexOf(':')
        if (colonIndex !== -1 && !rest.startsWith('[')) {
          const key = rest.slice(0, colonIndex).trim()
          const valuePart = rest.slice(colonIndex + 1).trim()
          const item = {}
          pos += 1
          if (valuePart === '') {
            Object.assign(item, { [key]: parseBlock(blockIndent + 2) })
          } else if (/^[>|]-?$/u.test(valuePart)) {
            item[key] = parseBlockScalar(blockIndent)
          } else {
            item[key] = parseScalar(valuePart)
          }
          // Sibling keys of this map item, indented past the `-`.
          const itemIndent = blockIndent + 2
          while (pos < lines.length && lines[pos].indent === itemIndent) {
            const siblingText = lines[pos].text
            const siblingColon = siblingText.indexOf(':')
            const siblingKey = siblingText.slice(0, siblingColon).trim()
            const siblingValue = siblingText.slice(siblingColon + 1).trim()
            pos += 1
            if (siblingValue === '') {
              item[siblingKey] = parseBlock(itemIndent + 2)
            } else if (/^[>|]-?$/u.test(siblingValue)) {
              item[siblingKey] = parseBlockScalar(itemIndent)
            } else {
              item[siblingKey] = parseScalar(siblingValue)
            }
          }
          items.push(item)
        } else {
          pos += 1
          items.push(parseScalar(rest))
        }
      }
      return items
    }

    const map = {}
    while (pos < lines.length && lines[pos].indent === blockIndent) {
      const text = lines[pos].text
      const colonIndex = text.indexOf(':')
      assert.ok(colonIndex !== -1, `expected "key: value" at line: ${text}`)
      const key = text.slice(0, colonIndex).trim()
      const valuePart = text.slice(colonIndex + 1).trim()
      pos += 1
      if (valuePart === '') {
        map[key] = parseBlock(blockIndent + 1)
      } else if (/^[>|]-?$/u.test(valuePart)) {
        map[key] = parseBlockScalar(blockIndent)
      } else {
        map[key] = parseScalar(valuePart)
      }
    }
    return map
  }

  return parseBlock(0)
}

let config
let checkJavaScriptFiles

test.before(async () => {
  const text = await readFile(CONFIG_PATH, 'utf8')
  config = parseYaml(text)
  const buildContract = await import('../scripts/build-contract.mjs').catch(() => ({}))
  checkJavaScriptFiles = buildContract.checkJavaScriptFiles
})

test('mac, win, and linux platform blocks all exist', () => {
  assert.ok(config.mac, 'expected a mac: block')
  assert.ok(config.win, 'expected a win: block')
  assert.ok(config.linux, 'expected a linux: block')
})

test('the package lifecycle owns exact staging, native manifest, and packaged import smoke', () => {
  assert.equal(config.beforeBuild, 'scripts/before-build.cjs')
  assert.equal(config.afterPack, 'scripts/after-pack.cjs')
  assert.equal(config.afterSign, 'scripts/after-sign.cjs')
  assert.equal(config.directories.app, 'build/release-app')
})

test('each platform targets exactly what packaging expects', () => {
  assert.deepEqual(config.mac.target, ['dir'])
  assert.deepEqual(config.win.target, ['nsis'])
  assert.deepEqual(config.linux.target, ['AppImage', 'deb'])
})

test('mac points at the generated .icns and win at the generated .ico', () => {
  assert.equal(config.mac.icon, 'build/icon.icns')
  assert.equal(config.win.icon, 'build/icon.ico')
})

test('linux is described for packaging: category, icon dir, executable name, synopsis', () => {
  assert.equal(config.linux.category, 'Utility')
  assert.equal(config.linux.icon, 'build/icons')
  assert.equal(config.linux.executableName, 'nova-ambient-orb')
  assert.equal(config.linux.synopsis, 'Nova ambient voice orb')
  assert.equal(config.linux.artifactName, 'nova-ambient-orb-${version}-${arch}.${ext}')
})

test('the staged application carries the complete deb maintainer metadata', async () => {
  const pkg = JSON.parse(await readFile(PACKAGE_JSON_PATH, 'utf8'))
  assert.equal(pkg.description, 'Local-first ambient voice agent desktop client')
  assert.equal(pkg.homepage, 'https://github.com/deepnovacore/NovaAudioAgent')
  assert.deepEqual(pkg.author, {
    name: 'DeepNova Core',
    email: 'opensource@deepnovacore.ai',
  })
})

test('nsis is a per-user, non-silent installer', () => {
  assert.equal(config.nsis.oneClick, false)
  assert.equal(config.nsis.perMachine, false)
})

test('deb recommends the CJK font package the tray/UI needs', () => {
  assert.deepEqual(config.deb.recommends, ['fonts-noto-cjk'])
})

test('the Swift AEC helper resource is scoped to mac only, not top-level', () => {
  const topLevelHasHelper = (config.extraResources ?? []).some(
    (entry) => entry.from === 'build/macos_voice_io',
  )
  assert.equal(topLevelHasHelper, false, 'the macOS-only helper must not be top-level (win/linux builds would fail on the missing file)')

  const macHasHelper = (config.mac.extraResources ?? []).some(
    (entry) => entry.from === 'build/macos_voice_io' && entry.to === 'native/macos_voice_io',
  )
  assert.ok(macHasHelper, 'expected the Swift helper extraResources entry under mac:')
})

test('mac signing seals nested native resources before hashing the final manifest', async () => {
  assert.equal(config.mac.sign, 'scripts/sign-mac-with-native-manifest.cjs')
  const signer = await readFile(resolve(import.meta.dirname, '..', config.mac.sign), 'utf8')
  const nestedSign = signer.indexOf('signNative(path, options)')
  const manifestWrite = signer.indexOf('await rename(temporary, manifestPath)')
  const outerSign = signer.indexOf('await signAsync')
  assert.ok(nestedSign >= 0 && nestedSign < manifestWrite && manifestWrite < outerSign)
  assert.match(signer, /sealedPaths\.has\(resolve\(path\)\)/u)
  assert.match(signer, /assert\.deepEqual\(finalManifest, manifest/u)
  assert.match(signer, /'shared_library'/u)
})

test('Windows refreshes native hashes after electron-builder signs unpacked addons', async () => {
  const hook = await import('../scripts/after-sign.cjs')
  const calls = []
  const writeManifest = async context => calls.push(context)
  await hook.refreshWindowsNativeManifestAfterSign(
    {electronPlatformName: 'darwin'},
    {writeManifest},
  )
  assert.deepEqual(calls, [])
  const windows = {electronPlatformName: 'win32', appOutDir: 'candidate'}
  await hook.refreshWindowsNativeManifestAfterSign(windows, {writeManifest})
  assert.deepEqual(calls, [windows])
})

test('the tray icon resource stays top-level for every platform', () => {
  const topLevelHasTray = (config.extraResources ?? []).some(
    (entry) => entry.from === 'resources/tray' && entry.to === 'tray',
  )
  assert.ok(topLevelHasTray, 'expected resources/tray -> tray to remain a top-level extraResources entry')

  const macHasTray = (config.mac.extraResources ?? []).some((entry) => entry.from === 'resources/tray')
  assert.equal(macHasTray, false, 'the tray resource should not be duplicated under mac:')
})

test('the project native addon is staged once at its fixed cross-platform resource path', () => {
  const owners = (config.extraResources ?? []).filter(
    (entry) => entry.from === 'build/native/project-native/nova_project_native.node'
      || entry.to === 'native/project-native/nova_project_native.node',
  )
  assert.deepEqual(owners, [{
    from: 'build/native/project-native/nova_project_native.node',
    to: 'native/project-native/nova_project_native.node',
  }])
  for (const platform of ['mac', 'win', 'linux']) {
    assert.equal(
      (config[platform].extraResources ?? []).some(
        (entry) => entry.to === 'native/project-native/nova_project_native.node',
      ),
      false,
      `project native addon must not be duplicated under ${platform}`,
    )
  }
})

test('the fixed sandbox probe is staged once outside ASAR for every platform', () => {
  assert.equal((config.extraResources ?? []).some(
    entry => String(entry.to).includes('codex-sandbox-probe'),
  ), false)
  assert.deepEqual(config.mac.extraResources.filter(
    entry => String(entry.to).includes('codex-sandbox-probe'),
  ), [{from: 'build/native/codex-sandbox-probe', to: 'native/codex-sandbox-probe'}])
  assert.deepEqual(config.linux.extraResources.filter(
    entry => String(entry.to).includes('codex-sandbox-probe'),
  ), [{from: 'build/native/codex-sandbox-probe', to: 'native/codex-sandbox-probe'}])
  assert.deepEqual(config.win.extraResources.filter(
    entry => String(entry.to).includes('codex-sandbox-probe'),
  ), [{from: 'build/native/codex-sandbox-probe.exe', to: 'native/codex-sandbox-probe.exe'}])
})

test('the Windows Job guardian is staged once only for Windows', () => {
  assert.equal((config.extraResources ?? []).some(
    entry => String(entry.to).includes('windows-job-guardian'),
  ), false)
  assert.equal((config.mac.extraResources ?? []).some(
    entry => String(entry.to).includes('windows-job-guardian'),
  ), false)
  assert.equal((config.linux.extraResources ?? []).some(
    entry => String(entry.to).includes('windows-job-guardian'),
  ), false)
  assert.deepEqual(config.win.extraResources.filter(
    entry => String(entry.to).includes('windows-job-guardian'),
  ), [{from: 'build/native/windows-job-guardian.exe', to: 'native/windows-job-guardian.exe'}])
})

test('Windows signing covers executables, Node addons, and manifest-owned shared libraries', () => {
  assert.deepEqual(config.win.signExts, ['.exe', '.node', '.dll'])
})

test('the immutable endpointing capability assets are staged once at a fixed external path', () => {
  const matches = (config.extraResources ?? []).filter(
    entry => entry.to === 'endpointing/volcengine-v1',
  )
  assert.deepEqual(matches, [{
    from: 'build/endpointing/volcengine-v1',
    to: 'endpointing/volcengine-v1',
    filter: [
      'MANIFEST.json',
      'LICENSE.silero-vad.txt',
      'silence-16k-s16le.pcm',
      'speech-16k-s16le.pcm',
    ],
  }])
  for (const platform of ['mac', 'win', 'linux']) {
    assert.equal(
      (config[platform].extraResources ?? []).some(
        entry => String(entry.to).includes('endpointing'),
      ),
      false,
      `endpointing assets must not be duplicated under ${platform}`,
    )
  }
})

test('THIRD_PARTY_NOTICES.md and LICENSES/** ship in files for every platform', () => {
  assert.ok(config.files.includes('THIRD_PARTY_NOTICES.md'), 'expected THIRD_PARTY_NOTICES.md in files')
  assert.ok(config.files.includes('LICENSES/**/*'), 'expected LICENSES/**/* in files')
})

test('the packaged desktop declares the compiled Node runtime as a production dependency', async () => {
  const pkg = JSON.parse(await readFile(PACKAGE_JSON_PATH, 'utf8'))
  assert.equal(pkg.dependencies['@nova-audio-agent/runtime'], '0.1.0')
})

test('every package: script disables publishing explicitly', async () => {
  const pkg = JSON.parse(await readFile(PACKAGE_JSON_PATH, 'utf8'))
  const packageScripts = Object.entries(pkg.scripts).filter(([name]) => name.startsWith('package:'))

  assert.ok(packageScripts.length > 0, 'expected at least one package: script to check')
  for (const [name, command] of packageScripts) {
    assert.match(
      command,
      /--publish never\b/,
      `expected "${name}" to pass --publish never so CI never attempts to publish a release`,
    )
  }
})

test('CI runs checks and packaging across the supported automatic runner matrix', async () => {
  const text = await readFile(CI_WORKFLOW_PATH, 'utf8')
  const workflow = parseYaml(text)

  assert.deepEqual(Object.keys(workflow.on), ['push', 'pull_request'])
  assert.equal('python' in workflow.jobs, false)
  assert.deepEqual(workflow.jobs.electron.strategy.matrix.os, [
    'macos-latest', 'ubuntu-latest', 'windows-latest',
  ])
  assert.deepEqual(workflow.jobs.package.strategy.matrix.include, [
    {
      os: 'macos-latest',
      script: 'package:mac:candidate',
      artifact: 'ambient-orb-mac',
    },
    {
      os: 'windows-latest',
      script: 'package:win',
      artifact: 'ambient-orb-win',
    },
  ])
})

test('root npm commands require only the Node toolchain', async () => {
  const pkg = JSON.parse(await readFile(ROOT_PACKAGE_JSON_PATH, 'utf8'))
  const commands = Object.values(pkg.scripts).join('\n')

  assert.doesNotMatch(commands, /\b(?:python|pytest|uv)\b/u)
})

test('unsigned Windows workflow publishes tag builds only after digest-bound installed smoke', async () => {
  const text = await readFile(UNSIGNED_WORKFLOW_PATH, 'utf8')
  const workflow = parseYaml(text)

  assert.equal(workflow.name, 'Unsigned Windows package and release')
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch', 'push'])
  assert.deepEqual(workflow.on.push.branches, ['main'])
  assert.deepEqual(workflow.on.push.tags, ['v*'])
  assert.deepEqual(workflow.permissions, {contents: 'read'})

  const packageJob = workflow.jobs.package
  assert.deepEqual(packageJob.permissions, {contents: 'read'})
  assert.deepEqual(packageJob.strategy.matrix.include, [
    {
      os: 'windows-2022',
      target_id: 'win32-x64',
      package_script: 'package:win',
      artifact_name: 'unsigned-win32-x64',
    },
  ])

  const packageSteps = packageJob.steps
  const packageRuns = packageSteps.map(step => step.run).filter(Boolean).join('\n')
  for (const command of [
    'npm run check',
    'npm run test:runtime',
    'npm run test:desktop',
    'npm run build',
    'npm run ${{ matrix.package_script }} --workspace @nova-audio-agent/ambient-orb',
    'npm run inspect:release-package --workspace @nova-audio-agent/ambient-orb',
    'npm run collect:release-artifacts --workspace @nova-audio-agent/ambient-orb -- --target-id ${{ matrix.target_id }}',
    'npm run prepare:release-smoke-kit --workspace @nova-audio-agent/ambient-orb',
  ]) assert.ok(packageRuns.includes(command), command)
  const runtimeTests = packageSteps.find(step => step.run === 'npm run test:runtime')
  assert.equal(runtimeTests?.if, "runner.os != 'Windows'")
  const desktopTests = packageSteps.find(step => step.run === 'npm run test:desktop')
  assert.equal(desktopTests?.if, "runner.os != 'Windows'")
  assert.equal(packageSteps.some(step => step.uses === 'actions/attest-build-provenance@v3'), false)
  assert.ok(packageSteps.some(step => step.uses === 'actions/upload-artifact@v4'))
  assert.doesNotMatch(text, /continue-on-error|\|\| true/u)

  const upload = packageSteps.find(step => (
    step.uses === 'actions/upload-artifact@v4'
    && step.with?.name === '${{ matrix.artifact_name }}'
  ))
  assert.deepEqual(upload.with.path.split('\n'), [
    'desktop/ambient-orb/build/release-artifacts/**',
    'desktop/ambient-orb/build/release-digests/**',
    'desktop/ambient-orb/build/release-smoke-kit/**',
  ])
  assert.doesNotMatch(upload.with.path, /(?:^|\/)dist(?:\/|$)/u)

  const smokeJob = workflow.jobs['installed-smoke']
  assert.equal(smokeJob.needs, 'package')
  assert.deepEqual(smokeJob.permissions, {contents: 'read'})
  assert.deepEqual(smokeJob.strategy.matrix.include, [
    {
      os: 'windows-2022',
      target: 'win32-x64:nsis',
      artifact_name: 'unsigned-win32-x64',
      filename: 'nova-audio-agent-0.1.0-windows-x64.exe',
      command: 'node',
    },
  ])
  assert.doesNotMatch(text, /macos-|ubuntu-|linux-x64/u)
  assert.equal(smokeJob.steps.some(step => step.uses === 'actions/checkout@v4'), false)
  assert.ok(smokeJob.steps.some(step => step.uses === 'actions/download-artifact@v4'))
  const smokeStep = smokeJob.steps.find(step => step.run?.includes('run-unsigned-installed-smoke.mjs'))
  assert.deepEqual(smokeStep.env, {NOVA_RELEASE_SMOKE_DIAGNOSTICS: '1'})
  assert.equal(smokeStep['timeout-minutes'], '10')
  for (const argument of [
    '--sha256-file candidate/release-digests/${{ matrix.filename }}.sha256',
    '--camera-file candidate/release-smoke-kit/cat-sofa-guard.mp4',
  ]) assert.ok(smokeStep.run.includes(argument), argument)
  assert.doesNotMatch(smokeStep.run, /--commit|--signer-workflow/u)
  assert.doesNotMatch(text, /attestations:|id-token:|attest-build-provenance/u)

  const releaseJob = workflow.jobs.release
  assert.equal(releaseJob.if, "startsWith(github.ref, 'refs/tags/v')")
  assert.equal(releaseJob.needs, 'installed-smoke')
  assert.equal(releaseJob['runs-on'], 'windows-2022')
  assert.deepEqual(releaseJob.permissions, {contents: 'write'})
  assert.ok(releaseJob.steps.some(step => (
    step.uses === 'actions/download-artifact@v4'
    && step.with?.name === 'unsigned-win32-x64'
  )))
  const publishStep = releaseJob.steps.find(step => step.run?.includes('gh release create'))
  assert.deepEqual(publishStep.env, {
    GH_TOKEN: '${{ github.token }}',
    GH_REPO: '${{ github.repository }}',
  })
  assert.match(publishStep.run, /candidate\/release-artifacts\/\*\.exe/u)
  assert.match(publishStep.run, /candidate\/release-digests\/\*\.exe\.sha256/u)
  assert.match(publishStep.run, /--verify-tag/u)
})

function parseBooleanPlist(text) {
  const dict = /<dict>([\s\S]*?)<\/dict>/u.exec(text)?.[1]
  assert.ok(dict, 'expected one plist dict')
  const tokens = [...dict.matchAll(/<key>([^<]+)<\/key>|<(true|false)\s*\/>/gu)]
  const result = {}
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index]?.[1]
    const value = tokens[index + 1]?.[2]
    assert.ok(key && value, 'every plist key must be followed by a boolean')
    assert.equal(Object.hasOwn(result, key), false, `duplicate plist key: ${key}`)
    result[key] = value === 'true'
  }
  assert.equal(tokens.length, Object.keys(result).length * 2)
  return result
}

test('signed mac declarations catch an omitted camera entitlement or usage string', async () => {
  const parent = parseBooleanPlist(await readFile(ENTITLEMENTS_PATH, 'utf8'))
  const inherit = parseBooleanPlist(await readFile(INHERIT_ENTITLEMENTS_PATH, 'utf8'))

  assert.equal(parent['com.apple.security.device.camera'], true)
  assert.equal(inherit['com.apple.security.device.camera'], true)
  assert.equal(parent['com.apple.security.device.audio-input'], true)
  assert.equal(inherit['com.apple.security.device.audio-input'], true)
  assert.equal(parent['com.apple.security.cs.allow-jit'], true)
  assert.equal(inherit['com.apple.security.cs.allow-jit'], true)
  assert.equal(parent['com.apple.security.network.client'], true)
  assert.equal(config.mac.extendInfo.NSMicrophoneUsageDescription, 'Nova Audio Agent 使用麦克风进行带系统级回声消除的实时语音交互。')
  assert.equal(config.mac.extendInfo.NSCameraUsageDescription, 'Nova Audio Agent 使用摄像头按需捕获画面，用于本地视觉观察和安全提醒。')
})

test('renderer CSP catches widening camera media beyond the exact same origin', async () => {
  const html = await readFile(HTML_PATH, 'utf8')
  const content = /http-equiv="Content-Security-Policy" content="([^"]+)"/u.exec(html)?.[1]
  assert.ok(content, 'expected CSP meta content')
  const directives = Object.fromEntries(content.split(';').map(part => {
    const fields = part.trim().split(/\s+/u)
    return [fields[0], fields.slice(1)]
  }))

  assert.deepEqual(directives['default-src'], ["'self'"])
  assert.deepEqual(directives['script-src'], ["'self'"])
  assert.deepEqual(directives['style-src'], ["'self'"])
  assert.deepEqual(directives['connect-src'], ['ws://127.0.0.1:*'])
  assert.deepEqual(directives['img-src'], ["'none'"])
  assert.deepEqual(directives['media-src'], ["'self'"])
  assert.deepEqual(directives['object-src'], ["'none'"])
  assert.deepEqual(directives['base-uri'], ["'none'"])
  assert.deepEqual(directives['form-action'], ["'none'"])
  assert.doesNotMatch(directives['media-src'].join(' '), /file:|data:|blob:|https?:/u)
})

test('desktop build executes syntax checks for production camera and integration runner modules', async () => {
  assert.equal(typeof checkJavaScriptFiles, 'function')
  for (const malformed of [
    'src/main/camera-source.mjs',
    'src/renderer/camera.mjs',
    'src/renderer/release-camera.mjs',
    'src/renderer/release-camera-contract.mjs',
    'scripts/camera-file-integration.mjs',
    'scripts/camera-file-integration-contract.mjs',
    'scripts/camera-file-integration-renderer.mjs',
    'scripts/camera-file-integration-mutations.mjs',
  ]) {
    const temporary = await mkdtemp(resolve(tmpdir(), 'nova-camera-build-check-'))
    try {
      for (const file of EXPECTED_BUILD_SCRIPTS) {
        const target = resolve(temporary, file)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(
          target,
          file === malformed
            ? 'export const malformed ='
            : file.endsWith('.cjs') ? 'module.exports = true\n' : 'export const valid = true\n',
          'utf8',
        )
      }
      assert.throws(
        () => checkJavaScriptFiles(temporary),
        error => {
          assert.match(error.message, new RegExp(malformed.replaceAll('.', '\\.'), 'u'))
          return true
        },
        malformed,
      )
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
})

test('the dedicated camera-file script builds runtime before launching pinned Electron', async () => {
  const pkg = JSON.parse(await readFile(PACKAGE_JSON_PATH, 'utf8'))
  assert.equal(
    pkg.scripts['test:camera-file'],
    'npm run build --workspace @nova-audio-agent/runtime && electron scripts/camera-file-integration.mjs',
  )
})
