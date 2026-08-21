import assert from 'node:assert/strict'
import {test} from 'node:test'

import * as runtime from '../src/index.js'

test('the runtime package root does not export Codex authority bypasses or test seams', () => {
  for (const name of [
    'approvedCodexSpawnDetails',
    'createApprovedCodexSpawnSpecForTest',
    'hostBinaryForTest',
    'hostCodexHomeForTest',
    'hostWorkspaceForTest',
    'hostBinaryFromConfig',
    'hostEphemeralCodexHomeFromConfig',
    'hostPersistentCodexHomeFromConfig',
    'createApprovedCodexSpawnSpec',
    'createPlatformCodexProcessOwnerFactory',
    'PosixCodexProcessOwnerFactory',
    'hostCodexHomeValue',
    'takeUnconfirmedCodexProcessOwner',
    'unconfirmedCodexProcessOwnerError',
    'windowsGuardianHelperFromPackage',
    'prepareCodexCredentialSnapshotForTest',
    'splitCredentialAtomicTargetForTest',
    'windowsGuardianHelperForTest',
    'windowsGuardianHelperPath',
    'resolveCodexHostConfig',
    'codexCredentialApiKey',
    'createCodexAssemblyResource',
    'OwnedCodexBackendTransportFactory',
    'unavailableCodexBackendTransportFactory',
  ]) assert.equal(Object.hasOwn(runtime, name), false, name)
})
