# Task 6 Implementer Report

## Status

Implemented Settings schema version 2, retained separate integrated/cascaded voices and independent Qwen/Ark remembered cascaded models, expanded secure storage to seven platform-level secret keys, and made backend environment injection pipeline/provider aware. Renderer panel files were not edited.

## RED / GREEN

### Settings store RED

Command:

```bash
node --test desktop/ambient-orb/test/settings-store.test.mjs
```

Observed: 25 passed, 12 failed. The failures named the intended missing behavior: schema version remained 1, v2 public fields were absent, the shared `voice` field remained, the strict remembered-model map was absent, and the three new secret keys were not recognized.

### Settings store GREEN

Command:

```bash
node --test desktop/ambient-orb/test/settings-store.test.mjs
```

Observed after implementation: 37 passed, 0 failed.

### Backend mapping RED

Command:

```bash
node --test desktop/ambient-orb/test/backend.test.mjs
```

Observed mapping failures: integrated/cascaded selectors, active remembered model, and Ark/Doubao secret overrides were absent. The same sandboxed run also reported unrelated `listen EPERM` failures because loopback socket binding is denied inside the filesystem sandbox.

### Backend mapping GREEN

Focused command:

```bash
node --test --test-name-pattern='^(integrated launch|cascaded|absent cascaded|launch spec)' desktop/ambient-orb/test/backend.test.mjs
```

Observed: 13 passed, 0 failed.

## Final verification

Complete Main/security command, run outside the sandbox so readiness tests could bind `127.0.0.1`:

```bash
node --test desktop/ambient-orb/test/settings-store.test.mjs desktop/ambient-orb/test/backend.test.mjs desktop/ambient-orb/test/preload.test.mjs desktop/ambient-orb/test/main-security.test.mjs desktop/ambient-orb/test/security.test.mjs
```

Observed: 137 passed, 0 failed.

Static verification:

```bash
node --check desktop/ambient-orb/src/main/settings-store.mjs
node --check desktop/ambient-orb/src/main/backend.mjs
node --check desktop/ambient-orb/src/main/main.mjs
git diff --check
```

Observed: every command exited 0 with no syntax or whitespace errors.

## Secret-key matrix

| Settings key | Environment name | Stored form | Integrated Qwen | Cascaded Qwen | Cascaded Ark |
| --- | --- | --- | --- | --- | --- |
| `dashscopeApiKey` | `DASHSCOPE_API_KEY` | `safeStorage` or explicit `enc:none` fallback | active | active LLM key | inactive |
| `tavilyApiKey` | `TAVILY_API_KEY` | same | active support key | active support key | active support key |
| `modelApiKey` | `NOVA_AUDIO_AGENT_MODEL_API_KEY` | same | active optional override | active optional override | active optional override |
| `codexApiKey` | `NOVA_AUDIO_AGENT_CODEX_API_KEY` | same | active optional override | active optional override | active optional override |
| `arkApiKey` | `ARK_API_KEY` | same | inactive | inactive | active LLM key |
| `doubaoBigmodelApiKey` | `DOUBAO_BIGMODEL_API_KEY` | same | inactive | active TTS and ASR fallback | active TTS and ASR fallback |
| `doubaoAsrApiKey` | `DOUBAO_ASR_API_KEY` | same | inactive | optional ASR override | optional ASR override |

All seven keys share the existing forward-only renderer flow, per-field rejection, presence-only public flags, queued/atomic writes, key-name-only diagnostics, and opportunistic `enc:none` re-sealing. Empty, whitespace-only, non-string, or control-character launch overrides are omitted so inherited parent values survive. An absent `doubaoAsrApiKey` never copies the big-model key into `DOUBAO_ASR_API_KEY`; runtime performs that fallback itself.

## Environment mapping matrix

| Public Settings v2 field | Runtime environment | Injection rule |
| --- | --- | --- |
| `version` | none | schema/public-view metadata only |
| `palette` | none | desktop-only live appearance |
| `proactivity` | `NOVA_AUDIO_AGENT_PROACTIVITY_PRESET` | every launch |
| `codexHeartbeatSeconds` | `NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL` | every launch, stringified |
| `pipelineMode` | `NOVA_AUDIO_AGENT_PIPELINE_MODE` | every launch |
| `integratedProvider` | `NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER` | integrated only |
| `integratedModel` | `NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL` | integrated only |
| `integratedVoice` | `NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE` | integrated only |
| `cascadedEndpointingProvider` | `NOVA_AUDIO_AGENT_CASCADE_ENDPOINTING_PROVIDER` | cascaded only |
| `cascadedAsrProvider` | `NOVA_AUDIO_AGENT_CASCADE_ASR_PROVIDER` | cascaded only |
| `cascadedLlmProvider` | `NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER` | cascaded only |
| `cascadedLlmModels[active provider]` | `NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL` | cascaded only; inactive remembered model is not injected or mutated |
| `cascadedTtsProvider` | `NOVA_AUDIO_AGENT_CASCADE_TTS_PROVIDER` | cascaded only |
| `cascadedTtsVoice` | `NOVA_AUDIO_AGENT_DOUBAO_TTS_VOICE` | cascaded only |

The environment object has one assignment per active node selector. Inactive panel overrides never replace inherited parent values.

## Files changed

- `desktop/ambient-orb/src/main/settings-store.mjs`
- `desktop/ambient-orb/src/main/backend.mjs`
- `desktop/ambient-orb/src/main/main.mjs`
- `desktop/ambient-orb/test/settings-store.test.mjs`
- `desktop/ambient-orb/test/backend.test.mjs`
- `.superpowers/sdd/2026-08-22-extensible-audio-pipelines/task-6-implementer-report.md`

`desktop/ambient-orb/test/preload.test.mjs` was verified but required no edit.

## Self-review and concerns

- Confirmed schema v1 receives no compatibility/migration path: normalization rebuilds version 2 and drops the old shared `voice` field.
- Confirmed `cascadedLlmModels` always rebuilds exactly `{qwen, ark}` and falls back each nested value independently, including against a caller-supplied base.
- Confirmed public settings contain no secret object, ciphertext, or plaintext; secret presence is seven booleans only.
- Confirmed integrated, cascaded Qwen, and cascaded Ark launch tests include inactive credentials to prove they are not injected by panel overrides.
- Confirmed no secret value or ciphertext was added to logs or return values.
- No Task 6 implementation concern remains. The existing Settings renderer still targets schema v1 by design and is reserved for Task 7, per scope.
