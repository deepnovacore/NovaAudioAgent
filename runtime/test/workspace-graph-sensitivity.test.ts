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

test('denies descendants whose names begin with parent traversal characters', () => {
  const policy = new SensitivePathPolicy({deniedRoots: ['/repo/private']})
  const path = '/repo/private/..vault/notes.md'

  assert.ok(!policy.allows(path), 'denied-root descendant was allowed')
  assert.ok(policy.redactLabel(path) === null, 'denied-root descendant label was returned')
})

test('denies concatenated credential filenames without returning their labels', () => {
  const policy = new SensitivePathPolicy()
  const path = '/repo/config/accessToken.json'

  assert.ok(!policy.allows(path), 'concatenated credential filename was allowed')
  assert.ok(policy.redactLabel(path) === null, 'concatenated credential label was returned')
})

test('allows ordinary filenames that merely contain a credential word fragment', () => {
  const policy = new SensitivePathPolicy()

  assert.ok(policy.allows('/repo/src/tokenizer.ts'), 'ordinary filename was denied')
  assert.equal(policy.redactLabel('/repo/src/tokenizer.ts'), 'tokenizer.ts')
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

test('redacts complete authorization header values for every scheme', () => {
  const policy = new SensitiveContentPolicy()
  const basicCredential = 'dXNlcjpjcmVkZW50aWFsLXZhbHVlLTEyMzQ1'
  const digestCredential = 'credential-response-value-12345'
  const proxyCredential = 'cHJveHktY3JlZGVudGlhbC12YWx1ZS0xMjM0NQ=='
  const values = [
    `Authorization: Basic ${basicCredential}`,
    `Authorization: Digest username="user", response="${digestCredential}"`,
    `Proxy-Authorization: Basic ${proxyCredential}`,
  ]

  for (const value of values) {
    const result = policy.scrub('detail', `before\n${value}\nafter`)
    assert.ok(result.kind === 'redacted', 'authorization header was not redacted')
    if (result.kind !== 'redacted') continue
    assert.ok(!result.value.includes(basicCredential), 'basic credential was returned')
    assert.ok(!result.value.includes(digestCredential), 'digest credential was returned')
    assert.ok(!result.value.includes(proxyCredential), 'proxy credential was returned')
    assert.ok(result.value.includes('before\n'), 'text before authorization header was discarded')
    assert.ok(result.value.includes('\nafter'), 'text after authorization header was discarded')
  }
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
  assert.ok(
    result.value === 'first [redacted]; second [redacted]; complete',
    'credential spans were not replaced with the redaction marker',
  )
  assert.equal(result.matches, 2)
})

test('redacts private URLs carrying query credentials', () => {
  const policy = new SensitiveContentPolicy()
  const privateUrl = 'https://service.example/v1?accessToken=credential-value-12345&mode=sync'
  const result = policy.scrub('detail', `calling ${privateUrl} completed`)

  assert.equal(result.kind, 'redacted')
  if (result.kind !== 'redacted') return
  assert.ok(!result.value.includes(privateUrl), 'private URL was returned')
  assert.ok(result.value === 'calling [redacted] completed', 'private URL was not redacted as one span')
})

test('redacts private URLs carrying client secret query credentials', () => {
  const policy = new SensitiveContentPolicy()
  const privateUrl = 'https://service.example/v1?client_secret=credential-value-12345&mode=sync'
  const result = policy.scrub('detail', `calling ${privateUrl} completed`)

  assert.equal(result.kind, 'redacted')
  if (result.kind !== 'redacted') return
  assert.ok(!result.value.includes(privateUrl), 'private URL was returned')
  assert.ok(result.value === 'calling [redacted] completed', 'private URL was not redacted as one span')
})

test('redacts private URLs carrying userinfo credentials', () => {
  const policy = new SensitiveContentPolicy()
  const privateUrl = 'https://deploy-user:credential-value-12345@service.example/v1/status'
  const result = policy.scrub('detail', `calling ${privateUrl} completed`)

  assert.equal(result.kind, 'redacted')
  if (result.kind !== 'redacted') return
  assert.ok(!result.value.includes(privateUrl), 'private URL was returned')
  assert.ok(result.value === 'calling [redacted] completed', 'private URL was not redacted as one span')
})

test('redacts cookie header values through end-of-line while retaining adjacent safe text', () => {
  const policy = new SensitiveContentPolicy()
  const cookie = 'Cookie: session=credential-value-12345; preference=compact'
  const result = policy.scrub('detail', `request sent with ${cookie}\nrequest completed`)

  assert.equal(result.kind, 'redacted')
  if (result.kind !== 'redacted') return
  assert.ok(!result.value.includes(cookie), 'cookie header was returned')
  assert.ok(
    result.value === 'request sent with Cookie: [redacted]\nrequest completed',
    'cookie header was not redacted through its complete line',
  )
})

test('redacts quoted credential keys in JSON-like content', () => {
  const policy = new SensitiveContentPolicy()
  const credential = 'credential-value-12345'
  const result = policy.scrub('detail', `deployed {"password": "${credential}", "secret": "${credential}", "token": "${credential}"}`)

  assert.ok(result.kind === 'redacted', 'quoted credential keys were not redacted')
  if (result.kind !== 'redacted') return
  assert.ok(!result.value.includes(credential), 'quoted credential value was returned')
})

test('redacts quoted Chinese credential keys in JSON-like content', () => {
  const policy = new SensitiveContentPolicy()
  const credential = 'credential-value-12345'
  const result = policy.scrub('detail', `deployed {"密码": "${credential}"}`)

  assert.ok(result.kind === 'redacted', 'quoted Chinese credential key was not redacted')
  if (result.kind !== 'redacted') return
  assert.ok(!result.value.includes(credential), 'quoted Chinese credential value was returned')
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

test('rejects a bare set-cookie header after its value is redacted', () => {
  const policy = new SensitiveContentPolicy()

  assert.deepEqual(policy.scrub('detail', 'Set-Cookie: session=credential-value-12345'), {kind: 'rejected'})
})

test('does not redact the safe line after an empty cookie header', () => {
  const policy = new SensitiveContentPolicy()

  assert.deepEqual(policy.scrub('detail', 'Cookie:\nafter'), {kind: 'clean'})
})

test('does not redact the safe line after an empty set-cookie header', () => {
  const policy = new SensitiveContentPolicy()

  assert.deepEqual(policy.scrub('detail', 'Set-Cookie:\nafter'), {kind: 'clean'})
})

test('does not redact the safe line after empty authorization headers', () => {
  const policy = new SensitiveContentPolicy()

  assert.deepEqual(policy.scrub('detail', 'Authorization:\nafter'), {kind: 'clean'})
  assert.deepEqual(policy.scrub('detail', 'Proxy-Authorization:\nafter'), {kind: 'clean'})
})
