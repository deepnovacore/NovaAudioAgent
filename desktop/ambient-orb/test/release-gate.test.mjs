import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {releaseGateFailures, RELEASE_REQUIREMENTS} from '../../../runtime/scripts/check-release-gate.mjs'

test('release gate requires every milestone and platform with evidence, while dev remains an integration branch', async () => {
  const rows = RELEASE_REQUIREMENTS.map(id => `| ${id} | passed | [candidate evidence](evidence.md) |`)
  assert.deepEqual(releaseGateFailures(rows.join('\n')), [])
  for (const invalid of [rows.slice(1), [...rows, rows[0]], [...rows, rows[0].replace('passed', 'invalid')], rows.map((row, i) => i === 0 ? row.replace('passed', 'pending') : row), rows.map((row, i) => i === 0 ? row.replace('[candidate evidence](evidence.md)', '—') : row)]) {
    assert.ok(releaseGateFailures(invalid.join('\n')).length > 0)
  }
  const ledger = await readFile(new URL('../../../docs/specs/v0.2.0/RELEASE-GATE.md', import.meta.url), 'utf8')
  for (const id of RELEASE_REQUIREMENTS) assert.ok(ledger.includes(`| ${id} |`))
  const workflow = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(workflow, /release-readiness:[\s\S]*github\.base_ref == 'main'[\s\S]*check:release-gate/u)
  assert.doesNotMatch(workflow.slice(workflow.indexOf('  release-readiness:'), workflow.indexOf('  electron:')), /refs\/tags/u)
  const publish = await readFile(new URL('../../../.github/workflows/release-publish.yml', import.meta.url), 'utf8')
  assert.ok(publish.includes('git merge-base --is-ancestor "$EXPECTED_COMMIT" origin/main'))
  assert.match(workflow, /needs: \[electron\]/u)
  assert.doesNotMatch(workflow, /needs: \[electron, release-readiness\]/u)
  assert.ok(publish.includes('check:release-gate'))
  assert.ok(publish.indexOf('check:release-gate') < publish.indexOf('npm whoami'))
})
