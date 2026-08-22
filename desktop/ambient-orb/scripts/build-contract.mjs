import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const BUILD_JAVASCRIPT_FILES = Object.freeze([
  'src/main/main.mjs',
  'src/main/app-protocol.mjs',
  'src/main/camera-source.mjs',
  'src/main/backend.mjs',
  'src/main/security.mjs',
  'src/main/native-audio.mjs',
  'src/main/drag-controller.mjs',
  'src/main/settings-store.mjs',
  'src/renderer/index.mjs',
  'src/renderer/camera.mjs',
  'src/renderer/audio.mjs',
  'src/renderer/state.mjs',
  'src/renderer/orb-visual.mjs',
  'src/renderer/settings.mjs',
  'scripts/utility-runtime-smoke.mjs',
  'scripts/packaged-runtime-import-smoke.cjs',
  'scripts/run-packaged-import-smoke.mjs',
  'scripts/packaged-production-codex-smoke.cjs',
  'scripts/run-packaged-codex-smoke.mjs',
  'scripts/run-release-candidate-codex-smoke.mjs',
  'scripts/release-codex-tool.mjs',
  'scripts/sign-mac-with-native-manifest.cjs',
  'scripts/after-sign.cjs',
  'scripts/inspect-package.mjs',
  'scripts/camera-file-integration.mjs',
  'scripts/camera-file-integration-contract.mjs',
  'scripts/camera-file-integration-renderer.mjs',
  'scripts/camera-file-integration-mutations.mjs',
  'scripts/build-contract.mjs',
])

export function checkJavaScriptFiles(root, files = BUILD_JAVASCRIPT_FILES) {
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', resolve(root, file)], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(result.status, 0, `${file}: ${result.error?.message ?? result.stderr}`)
  }
}
