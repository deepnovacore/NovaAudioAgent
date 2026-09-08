# v0.2.0 release acceptance

`v0.2.0dev` is an integration branch. Passing deterministic tests permits feature merges there.
Merging into `main` is the release boundary: every requirement below must pass before that merge
and before publishing. M2, M3, M4, cascaded speech, and opt-in wake word are required even when
those features remain disabled by default. Linux is deferred as a release target; Ubuntu source
checks remain enabled.

Tag CI may build candidate artifacts while acceptance is pending. That does not publish a release:
the main branch check and `release-publish.yml` enforce this ledger. There is no acceptance bypass
for a hotfix; validate the applicable candidate and supply evidence before publication.

This table is the single release-readiness declaration read by `npm run check:release-gate`.
Replace `pending` with `passed` only after reviewing linked evidence identifying the tested
candidate commit, platform, procedure and results. Revalidate affected rows after product changes.
The script checks completeness of declarations; it does not perform or certify human acceptance.
Existing package identity, installation, version and release-authority checks still apply.
Configure branch protection to require the `release-readiness` check for PRs into `main`; direct
pushes must not bypass that review. This task does not merge into main or publish a version.

| Requirement | State | Evidence |
|---|---|---|
| m1 | pending | — |
| m15 | pending | — |
| m2 | pending | — |
| m3 | pending | — |
| m4 | pending | — |
| voice | pending | — |
| approvals | pending | — |
| cascaded | pending | — |
| wake-word | pending | — |
| darwin-arm64 | pending | — |
| darwin-x64 | pending | — |
| win32-x64 | pending | — |

- `m1` / `m15`: complete the applicable acceptance rows in volumes 05, 07 and 08,
  including the fixture executor proof and camera/Vision behavior.
- `m2` / `m3` / `m4`: complete volumes 03a, 03b and 04, including real configured
  services, failure paths and knowledge retrieval through MCP.
- `voice`: perform the ten current-surface human voice scripts in STATUS, including
  headset playback, interruption and project selection/creation.
- `approvals`: real concurrent executor approvals, ordering, accept/reject and project
  confirmation isolation; model transcripts alone never authorize execution.
- `cascaded`: real ASR → LLM → TTS, interruption, host narration and multi-step tool results.
- `wake-word`: volume 11 microphone, standby, mute, download recovery and packaged Worker/WASM.
- Each platform row: installed-candidate checks and all applicable feature/hardware evidence
  on that release target. A source test, simulated filesystem error or package manifest check
  does not substitute for an installed application or microphone acceptance.

Historical evidence remains in IMPLEMENTATION; no unperformed acceptance is marked passed here.
