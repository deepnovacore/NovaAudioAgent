# Compressor positive live acceptance — 2026-10-06

Follow-up: the two discovered defects are addressed in [Compressor grounding and pending-context repair](compressor-grounding-2026-10-06.md). Results below describe the pre-repair implementation.

This supplements the ACP heartbeat storm acceptance. It tests the real CausalRuntime conversation input path, production watermark 40, GatewayCompressor and qwen-flash downstream calls. Inputs are synthetic; this is not another ACP backend/GUI run. No production implementation changes were made.

## What was exercised

Forty distinct inputs include six LANTERN project facts with owner/port/deadline corrections and an unresolved release blocker, followed by unrelated verification records. The runtime naturally schedules compression. The same downstream question is answered from (1) the production last-five context without summary, (2) the production summary plus last five, and (3) all retained history. Full history is an alternative baseline, not the current compressor-disabled behavior.

Then forty new verification records are ingested. The runtime must wait until the 60-second completion-based cooldown expires, compress again without more input, and preserve the six earlier facts. The repeated run removes repeated LANTERN reminders from new records, asserts all 40 original items remain, checks compression job sizes [40, 80], uses identical downstream system prompts, and records actual dist hashes and raw answers.

The six-field score is deliberately narrow: owner, port, deadline, release status, unresolved blocker, rollback artifact. Equivalent unresolved-checksum-audit wording, including exactly “checksum audit” paired with status “blocked”, is normalized; other fields require exact matches. It is not a general summary quality benchmark or a comparison against retrieval or equal-token window selection.

## Results

Run 1: recent-only 0/6, compressed 6/6, full-history 6/6; the second summary also supports all six answers. Two real compression calls; second started 60.004 seconds after the first compressor returned. First compressor input 3,879 tokens; downstream recent 527, compressed 697, full history 3,081. Compressed context reduces input by 77.4% relative to full history, while adding 170 tokens relative to recent-only. First-pass compression input is amortized after two such downstream reads **counting input tokens only**. This is not a monetary break-even: output pricing, cache effects and later recompression are excluded.

Run 2 (final stricter harness): recent-only 0/6, compressed and full-history 6/6, second-summary answers 6/6. Two compression jobs with 40 then 80 items; cooldown 60.003 seconds. First compression input 3,874 tokens; downstream recent 517, compressed 706, full-history 3,083 (77.1% input reduction versus full history). Input-only first-pass amortization is again two reads. All six model calls in each passing run reported no gateway error. Evidence: run-1.json and run-2.json. Script syntax and git diff whitespace checks passed; no production code changed, so the full runtime suite was not rerun.

## Limitations discovered (not fixed by this acceptance)

- The first successful run's summary invents aggregate counts: ITEM-6 through ITEM-39 is 34 fixtures, but summary says 39; CHECK-40 through CHECK-79 is 40 checks, but second summary says 15. The six targeted facts pass, **not every fact in the summary**. Do not use an unverified summary as authoritative evidence for counts or release authorization.
- During cooldown, new records between the summary's coverage and the last five are absent from the ordinary foreground context. The repeated run explicitly records this gap: after 80 inputs, summary covers through 40, recent includes 76–80, and CHECK-40 (sequence 41) is not visible. This last-five/summary gap can occur whenever compression lags, and cooldown lengthens it. Source records remain retained; summary coverage is not exposed in ChannelView. A bounded unsummarized-context window or explicit retrieval/coverage indicator is separate follow-up work, not silently included here.
- The first summary already discards many unrelated per-fixture details. No source-ref fidelity assertion is made. Two synthetic runs do not establish broad factual reliability.
- The second compression still reads the full retained 80-item window. Cooldown bounds frequency; it does not remove this cost.
- A local Claude Sonnet 5.5 read-only review identified baseline, provenance, cooldown and context-gap limitations. Stronger assertions were incorporated, while the comparison remains intentionally scoped.

An initial sandbox run had TransportError and timed out (no usable model result). The first network-enabled attempt rejected a semantically equivalent blocker wording; the narrow normalization above fixes that harness assertion. A later repeat also rejected the equivalent combination blocker="checksum audit", status="blocked"; its raw failure is retained as run-2-wording-failure.json. This exact combination is now normalized without accepting resolved audits. These attempts are not counted as passing runs.

## Reproduce

Build the intended runtime first, and use a fresh dist path. The recorded runs use the final independent build from the preceding ACP acceptance (/tmp/nova-acp-final-dist, source 20c96434).

```sh
NOVA_LIVE_COMPRESSOR_VALUE=1 NOVA_ACP_AFTER_DIST=/path/to/built/runtime/dist \
  node --env-file=/path/to/private.env runtime/scripts/live/compressor-value.mjs
```

Requires DASHSCOPE_API_KEY. Default report: /tmp/nova-compressor-value.json (override NOVA_VALUE_REPORT). Two compressor jobs, four downstream calls, 180-second deadline. No personal data or ACP subprocess is used. The baseline source commit is provenance, not a claim about newer v0.4.0dev commits.
