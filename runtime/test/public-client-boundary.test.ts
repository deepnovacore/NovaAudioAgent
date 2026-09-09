import assert from 'node:assert/strict'
import {existsSync, readFileSync} from 'node:fs'
import {test} from 'node:test'

const root = new URL('../../../', import.meta.url)
test('public clients retain configurable login without pilot modules or an embedded login host', () => {
  for (const path of ['deploy/enterprise', 'runtime/src/enterprise-entry.ts', 'runtime/src/workspace-runtime.ts',
    'clients/ios/Nova/Nova/Protocol/CompanyWorkspace.swift', 'clients/ios/Nova/Nova/Views/CompanyWorkspaceView.swift']) {
    assert.equal(existsSync(new URL(path, root)), false, path)
  }
  const login = readFileSync(new URL('clients/ios/Nova/Nova/Protocol/EnterpriseSSO.swift', root), 'utf8')
  assert.ok(login.includes('NovaFeishuLoginOrigin'))
  assert.doesNotMatch(login, /https?:\/\/[a-z0-9]/iu)
  assert.ok(readFileSync(new URL('clients/ios/Nova/Nova/Views/ContentView.swift', root), 'utf8').includes('feishu-login'))
})
