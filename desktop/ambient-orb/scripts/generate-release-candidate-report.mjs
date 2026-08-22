import {readFile, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {parseStrictJson} from './strict-json.mjs'
import {
  validateCandidateLedgerStructure,
  verifyCandidateLedger,
} from './verify-release-evidence.mjs'

export function releaseCandidateReport(ledger, {now = Date.now()} = {}) {
  validateCandidateLedgerStructure(ledger, {now})
  const result = verifyCandidateLedger(ledger, {now})
  const lines = [
    '# Node runtime release candidate',
    '',
    `- Version: \`${ledger.release_version}\``,
    `- Commit: \`${ledger.commit}\``,
    `- Status: \`${result.status}\` (\`${result.result_code}\`)`,
    '',
    '| Target | SHA-256 |',
    '| --- | --- |',
    ...ledger.artifacts.map(record => `| \`${record.target}\` | \`${record.sha256}\` |`),
    '',
    `Pending gates: ${result.pending_gate_ids.map(value => `\`${value}\``).join(', ') || 'none'}`,
    '',
    'This is an unpublished candidate report. It is not a release or external-evidence claim.',
    '',
  ]
  return lines.join('\n')
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  void (async () => {
    const ledger = parseStrictJson(await readFile(resolve(option('--ledger') ?? ''), 'utf8'))
    const report = releaseCandidateReport(ledger)
    await writeFile(resolve(option('--output') ?? ''), report, {encoding: 'utf8', mode: 0o600})
    process.stdout.write('pending release candidate report generated\n')
  })().catch(() => {
    process.stderr.write('pending release candidate report rejected\n')
    process.exitCode = 1
  })
}
