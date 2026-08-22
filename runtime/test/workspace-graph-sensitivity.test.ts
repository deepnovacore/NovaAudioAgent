import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SensitiveContentPolicy,
  SensitivePathPolicy,
} from '../src/workspace-graph/sensitivity.js'

test('denies sensitive paths without returning their labels', () => {
  const policy = new SensitivePathPolicy()
  const path = '/repo/.env.production'

  assert.ok(!policy.allows(path), 'denied path was allowed')
  assert.ok(policy.redactLabel(path) === null, 'denied label was returned')
})

test('denies credential files nested under git metadata', () => {
  const policy = new SensitivePathPolicy()
  const path = '/repo/.git/credentials'

  assert.ok(!policy.allows(path), 'nested credential file was allowed')
  assert.ok(policy.redactLabel(path) === null, 'nested credential label was returned')
})

test('allows an ordinary absolute repository file with a normalized label', () => {
  const policy = new SensitivePathPolicy()

  assert.ok(policy.allows('/repo/src/../src/index.ts'), 'ordinary repository file was denied')
  assert.equal(policy.redactLabel('/repo/src/../src/index.ts'), 'index.ts')
})

test('denies configured roots before returning a display label', () => {
  const policy = new SensitivePathPolicy({deniedRoots: ['/repo/private']})
  const path = '/repo/private/notes.txt'

  assert.ok(!policy.allows(path), 'configured denied root was allowed')
  assert.ok(policy.redactLabel(path) === null, 'configured denied root label was returned')
})

test('denies relative paths without exposing their labels', () => {
  const policy = new SensitivePathPolicy()
  const path = 'relative/token.txt'

  assert.ok(!policy.allows(path), 'relative path was allowed')
  assert.ok(policy.redactLabel(path) === null, 'relative label was returned')
})

test('redacts credentials in episode summaries before persistence', () => {
  const policy = new SensitiveContentPolicy()
  const providerKey = 'sk-abc123XYZsecretsecret'
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature'
  const result = policy.scrub(
    'summary',
    `deployed with ${providerKey} and Authorization: Bearer ${jwt}`,
  )

  assert.equal(result.kind, 'redacted')
  if (result.kind !== 'redacted') return
  assert.ok(!result.value.includes(providerKey), 'provider key was returned')
  assert.ok(!result.value.includes(jwt), 'authorization value was returned')
  assert.ok(result.value.includes('deployed with'), 'safe surrounding text was discarded')
  assert.equal(result.matches, 2)
})

test('redacts every credential span in a field', () => {
  const policy = new SensitiveContentPolicy()
  const firstSecret = 'sk-abc123XYZsecretsecret'
  const secondSecret = 'token: abcdefghijklmnopqrstuvwxyz123456'
  const result = policy.scrub('summary', `first ${firstSecret}; second ${secondSecret}; complete`)

  assert.equal(result.kind, 'redacted')
  if (result.kind !== 'redacted') return
  assert.ok(!result.value.includes(firstSecret), 'first credential was returned')
  assert.ok(!result.value.includes(secondSecret), 'second credential was returned')
  assert.equal(result.value, 'first [redacted]; second [redacted]; complete')
  assert.equal(result.matches, 2)
})

test('redacts private URLs carrying query credentials', () => {
  const policy = new SensitiveContentPolicy()
  const privateUrl = 'https://service.example/v1?accessToken=credential-value-12345&mode=sync'
  const result = policy.scrub('detail', `calling ${privateUrl} completed`)

  assert.equal(result.kind, 'redacted')
  if (result.kind !== 'redacted') return
  assert.ok(!result.value.includes(privateUrl), 'private URL was returned')
  assert.equal(result.value, 'calling [redacted] completed')
})

test('redacts private URLs carrying userinfo credentials', () => {
  const policy = new SensitiveContentPolicy()
  const privateUrl = 'https://deploy-user:credential-value-12345@service.example/v1/status'
  const result = policy.scrub('detail', `calling ${privateUrl} completed`)

  assert.equal(result.kind, 'redacted')
  if (result.kind !== 'redacted') return
  assert.ok(!result.value.includes(privateUrl), 'private URL was returned')
  assert.equal(result.value, 'calling [redacted] completed')
})

test('redacts cookie header values while retaining surrounding text', () => {
  const policy = new SensitiveContentPolicy()
  const cookie = 'Cookie: session=credential-value-12345; preference=compact'
  const result = policy.scrub('detail', `request sent with ${cookie} successfully`)

  assert.equal(result.kind, 'redacted')
  if (result.kind !== 'redacted') return
  assert.ok(!result.value.includes(cookie), 'cookie header was returned')
  assert.equal(result.value, 'request sent with Cookie: [redacted]')
})

test('returns clean fields byte-identically', () => {
  const policy = new SensitiveContentPolicy()
  const value = 'commit 0123456789abcdef0123456789abcdef01234567 completed successfully with a detailed explanation'

  assert.deepEqual(policy.scrub('summary', value), {kind: 'clean'})
})

test('rejects a field when a redaction leaves no meaningful content', () => {
  const policy = new SensitiveContentPolicy()

  assert.deepEqual(policy.scrub('summary', 'password=only-secret-value-12345'), {kind: 'rejected'})
})

test('rejects a bare cookie header after its value is redacted', () => {
  const policy = new SensitiveContentPolicy()

  assert.deepEqual(policy.scrub('detail', 'Cookie: session=credential-value-12345'), {kind: 'rejected'})
})
