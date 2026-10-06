# Compressor grounding and pending-context repair — 2026-10-06

This fixes the two defects found in the preceding positive acceptance: model-written summaries invented aggregate counts, and pending records disappeared between summary coverage and the last-five window during cooldown. The prior reports remain historical evidence, not descriptions of the repaired behavior.

## Implementation

- The serving compressor now asks the model only for up to 16 source references. Strict JSON validation rejects prose, extra fields, empty selection, duplicate or unknown references. The program reconstructs the selected original records, including content, time, trust, outcome and source refs, in original input order. No model-generated prose or aggregate count is stored as the new summary. The JSON input serialization remains oracle-compatible; the old COMPRESSOR_SYSTEM export is explicitly legacy Python-oracle compatibility, not the serving selector prompt.
- Selected records are fitted whole into a 16,000-character budget, preferring later records. This does not truncate numbers, negations or source labels. If no selected record fits, the call fails safely: the runtime retains prior summary and original rows, records invalid_compressor_output, and does not immediately retry. New input can schedule another attempt after cooldown. No automatic extra model retry was added.
- Foreground context includes up to 40 not-yet-compressed rows, with a 16,000-character budget for additions beyond the existing last-five window. The last-five behavior itself remains available after compression. Overflow explicitly states the number of uncompressed rows omitted and the summary's processed-through sequence (or that no summary exists); it warns against assuming completeness or inferring totals. This is bounded visibility, not a promise to inject unlimited history.
- Expanding visible evidence does not expand automatic probes: they continue to inspect only the latest five rows.

Selection is lossy and original records remain retained. The excerpt header explicitly says selection is not complete history and missing excerpts do not prove absence. The change prevents invented prose entering memory through this compressor; it does not validate truth of original sources, migrate old persisted prose summaries, or make all future downstream model answers infallible.

## Automated verification

Two new regression tests failed on the prior implementation (missing pending records and raw model text accepted as summary). After repair, the combined 200-test run passed across context-view, model-adapters, prompting, runtime, causal-runtime, memory, blackboard clear/store, oracle fixtures, and ACP transport. Tests also cover bounded overflow text, large pending records, no revival of old probes, exact metadata/content copying, whole-record budget fitting, oversized selection rejection and empty-input handling. TypeScript build, changed-file ESLint, script syntax and git diff whitespace checks pass.

A subsequent regression specifically verifies that a rejected selection preserves the previous summary and pending rows without automatic retry; the final 150-test core/model/memory suite (including this added case) passed. Together with the unchanged 51 ACP checks, 201 relevant cases passed.

The broader repository suite was not rerun. The scoped tests include the earlier 1000-event compression-storm regressions.

## Real-model acceptance

The updated opt-in compressor-value script uses the real runtime and qwen-flash. It checks both returned excerpts against exact source records, validates six corrected/uncertain facts across two compression passes, queries CHECK-40 during cooldown (expected 920 rows), and asks for a total fixture count absent from the incomplete selection (expected null).

The first repaired run passed; the final run additionally uses the pending-character/probe and deterministic whole-record fitting changes. These are synthetic conversation/model runs, not additional ACP GUI/backend acceptance. The preceding ACP backend results still describe that separate test.

An exploratory repaired run failed because the cooldown query returned the wrong JSON shape with null despite the record being present. The harness now states the exact rows schema and puts the extraction question after the context. That failure was not accepted as a pass. No production output was weakened to accept unknown as 920.

Final live passed all eight model calls: six checked project facts are correct after both compression passes; cooldown query returns 920; unsupported total returns null. First compression input 3,943 tokens, compressed foreground input 907 versus full history 3,094 (70.7% reduction). Second compression starts 60.004s after the first finishes. Both excerpts exactly match their original selected source records. Input-only first-pass amortization remains two comparable reads; this excludes output prices, caching and later recompression.

Raw accepted evidence is stored alongside this document. Reports record dist hashes and script hashes; source HEAD was the pre-commit parent because these were working-tree builds. The final source changes are in the commit containing this report, rather than the older HEAD string alone.

## Reproduce

```sh
npm run build --workspace @nova-audio-agent/runtime
NOVA_LIVE_COMPRESSOR_VALUE=1 NOVA_ACP_AFTER_DIST="$PWD/runtime/dist" \
  node --env-file=/path/to/private.env runtime/scripts/live/compressor-value.mjs
```

DASHSCOPE_API_KEY is required. Two compression jobs, six downstream requests, 180-second deadline. Only synthetic records are submitted.


## Integration on current v0.4.0dev

Before integration, the target branch (c21a1a43) had a common ancestor at 931a059c and lacked the earlier full compression repair, despite its previous local integration. Merging the current target into the feature branch restores that complete repair while preserving current public changes, including native ACP truncated-output safety checks. Unrelated Flutter/protocol conflicts retain the target branch versions; both ACP regression sets are retained. No private pilot refs are involved.

Integrated production source: 163af7fd. All 202 core/model/memory/ACP tests passed; the provider-choice integration mock was updated for the new JSON compressor protocol and rechecked separately. Build and changed-file lint passed. The integrated positive live passes all eight calls, including exact source matching, cooldown rows 41–80, six project facts and unsupported-count=null. Compressed input is 931 versus full-history 3,092 (69.9% reduction on this synthetic workload).

The integrated real OpenCode ACP live also passes: 5 progress callbacks, zero compression jobs, verified artifact, same-session resume and cancellation/process teardown. Backend HTTP statuses are 200 and the foreground model call has no error. Evidence: integrated-value.json and integrated-acp.json. The final changes after 163af7fd affect only the test mock and verification records, not production behavior.
