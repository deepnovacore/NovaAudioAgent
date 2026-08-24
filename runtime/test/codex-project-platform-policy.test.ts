import assert from 'node:assert/strict'
import {chmod, mkdir, mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {
  ProjectStateError,
  hostManagedProjectRootForTest,
  hostProjectRootForTest,
} from '../src/codex-project-store.js'

test('Windows root admission defers ownership and ACL authority to the native handle probe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-project-windows-policy-'))
  const state = join(root, 'state')
  const managed = join(root, 'managed')
  try {
    await mkdir(state, {mode: 0o755})
    await mkdir(managed, {mode: 0o777})
    assert.doesNotThrow(() => hostProjectRootForTest(state, 'win32'))
    assert.doesNotThrow(() => hostManagedProjectRootForTest(managed, 'win32'))
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('POSIX root admission retains exact owner-only mode checks', async t => {
  if (process.platform === 'win32') {
    t.skip('Windows cannot model POSIX ownership and mode semantics')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'nova-project-posix-policy-'))
  const state = join(root, 'state')
  try {
    await mkdir(state, {mode: 0o700})
    assert.doesNotThrow(() => hostProjectRootForTest(state, process.platform))
    await chmod(state, 0o755)
    assert.throws(
      () => hostProjectRootForTest(state, process.platform),
      (error: unknown) => error instanceof ProjectStateError && error.code === 'state_permissions',
    )
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})
