/** Offline acceptance gate for a successful, bounded before/after live pair. */
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
const [beforePath, afterPath] = process.argv.slice(2)
if (!beforePath || !afterPath) throw Error('Usage: acp-compression-compare.mjs BEFORE.json AFTER.json')
const [before, after] = await Promise.all([beforePath, afterPath].map(async path => JSON.parse(await readFile(path, 'utf8'))))
for (const run of [before, after]) {
  assert.equal(run.ok, true)
  assert.equal(run.artifactVerified, true)
  assert.ok(!run.budgetCapped && !run.cleanupFailed)
  assert.equal(run.transport.code, 'completed')
  assert.ok(run.backendRequests.every(request => request.status === 200))
  assert.ok(run.modelCalls.every(call => call.error_type === null && call.input_tokens !== null))
}
assert.equal(before.variant, 'before'); assert.equal(after.variant, 'after')
assert.notEqual(before.provenance.distSha256['executors/acp/transport'], after.provenance.distSha256['executors/acp/transport'])
assert.notEqual(before.provenance.distSha256['core/runtime'], after.provenance.distSha256['core/runtime'])
assert.ok(before.compressorJobs.length >= 2)
assert.equal(after.compressorJobs.length, 0)
assert.ok(after.compressorInputTokens <= before.compressorInputTokens * 0.1)
assert.ok(after.progress.length <= before.progress.length * 0.1)
assert.equal(before.progress.at(-1).internal_activity, before.transport.activity)
assert.equal(after.progress.at(-1).internal_activity, after.transport.activity)
assert.ok(after.progress.length <= Math.floor(after.progress.at(-1).elapsed / 5) + 3)
assert.ok(after.lifecycle.length >= 2 && after.lifecycle.every(step => step.ok))
console.log(JSON.stringify({ok: true, progress: [before.progress.length, after.progress.length],
  compressorCalls: [before.compressorJobs.length, after.compressorJobs.length],
  compressorInputTokens: [before.compressorInputTokens, after.compressorInputTokens],
  measuredCompressorShare: [before.totalCompressorShare, after.totalCompressorShare],
  scope: 'Measured Nova host and OpenCode session input tokens; OpenCode auxiliary calls without recorded token usage are excluded.'}, null, 2))
