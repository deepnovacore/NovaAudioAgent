# Local wake word: Ni Hao Xing He

This volume is English-only by explicit user decision on 2026-09-06. This is an
intentional exception to the series convention requiring a Chinese summary.
The literal configured keyword remains `你好星核` (Ni Hao Xing He).

## User contract

Enable the feature in desktop Settings → Voice wake-up. It is off by default.
First enablement downloads the approximately 3-million-parameter bilingual KWS
model; automatic sleep is unavailable until the detector is ready. Microphone
permission and voice activation still use the existing controls. The default
idle timeout is 60 seconds; accepted values are `0` (disabled) or 30–3600 seconds.

- The orb hides after sustained idle. Model responses, executor work, listening,
  speaking, pending confirmation and connection failures prevent automatic sleep.
  When work ends, the idle timer starts again.
- While sleeping, microphone PCM goes only to the desktop worker, not the backend
  or a cloud service. Saying the keyword restores the window and existing session.
  Say the request afterward: pre-wake audio is not replayed and an immediately
  attached command is not guaranteed to survive in full.
- Muting blocks both conversation and wake detection. Showing the orb from the tray
  or shortcut preserves mute. Disabling voice stops capture.
- Manual hide tries the same sleep entry. If the model is loading or voice is not
  activated, the window still hides through the ordinary visibility fallback;
  local wake detection is unavailable until its readiness conditions are met.
- A detector failure during sleep shows the orb and forces mute (`blocked`). Retry
  successfully in Settings, or disable wake-up, then unmute manually. The current
  blocked-state tray/shortcut action restores active state rather than hiding.
  While blocked, reports cannot unmute it, and the orb has no inline Settings link.
  These user-visible limitations remain deferred; failure never uploads audio.
- Changes limited to wake enablement or timeout apply immediately without restarting
  the backend. This intentionally narrows volume 06's restart requirement for these
  desktop-only settings. Capability document commits still restart the backend,
  including combined capability and wake-setting saves. Wake-up never authorizes
  tools or changes confirmation.

## Audio and presence boundary

Native VoiceProcessingIO or a browser AudioWorklet feeds the shared audio router.
Active audio uses the existing WebSocket upload; sleeping audio uses the local KWS
worker. Electron main owns `active | sleeping | blocked` and a monotonic epoch.
Transitions and mute/activation changes advance the epoch; old frames and callbacks
are rejected. Swift snapshots the epoch before rendering each capture frame. Main
accepts only frames matching the current capture epoch, without waiting for a
`capture.epoch` acknowledgement. That acknowledgement remains in the producer
protocol for diagnostics; the initial `captureEpochSupported` handshake still
rejects older helpers and falls back to browser capture.

The renderer also gates automatic sleep on activation readiness
(`activationPending`), mute and connection state. `backgroundThrottling: false` already keeps the hidden
renderer's capture and presence reporting running; no additional throttling fix is
needed. This setting does not itself guarantee operation during OS suspension.

Settings add `wakeWordEnabled: boolean` and `autoHideSeconds: integer`. The preload
wake-word surface exposes reports, audio, user activity, retry and state changes.
Every inbound channel validates the sender window. Outbound presence contains only
`{state, status, epoch}`. Input is 16 kHz mono PCM16 with a 6400-byte per-message
limit and even byte length. There is at most one worker frame in flight, plus a
3200-byte queue (100 ms). Frames exceeding capacity or waiting over 100 ms are
dropped; transitions clear the queue. The queue never becomes a pre-wake replay.

The backend emits a best-effort `desktop.activity {idle: boolean}` heartbeat once
per second. Idle requires foreground idle, an idle floor, no active delegates and
an idle executor. Predicate failures report busy, and transport failures cannot
escape the timer callback. The timer is unreferenced and removed on abort, including
already-aborted startup. The renderer combines backend activity with playback,
capture, confirmations and connectivity. Reports older than 2.5 seconds prevent
automatic sleep; the timer restarts after suspension or stale reports.

## Engine, model and ownership

The engine is `sherpa-onnx` 1.13.4 WebAssembly, using one CPU thread. Production
requires neither Python nor an extra native inference plugin. The sherpa package
is explicitly unpacked from asar for filesystem loading. Packaged worker ESM
loading remains a platform acceptance item.

- Model: `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`.
- Archive SHA-256: `68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6`.
- Keyword token sequence: `n ǐ h ǎo x īng h é @你好星核`.
- Model source: [official model and conversion instructions](https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html).
  The original implementation record verified the v1.13.4 `text2token` ppinyin
  conversion against `tokens.txt`; Python was used only for that development check.
- Detection parameters: score 1.0, threshold 0.25, maxActivePaths 4 and
  numTrailingBlanks 1.

The first download verifies the full archive, extracts only the encoder, decoder,
joiner and tokens whitelist, validates keyword tokens and writes Nova's keyword
file. It then installs the verified staging directory by rename under Electron
userData's `models/wake-word`. A complete keyword cache can be reused offline.

Each preparation owns `.wake-word-download-<pid>-<threadId>` containing its archive
and staging tree. Normal completion/failure removes it in `finally`; main also
removes that exact directory after its Worker exits, including forced termination.
A replacement worker has a different thread ID, so an old exit callback cannot
remove its files. Startup removes only recognized temporary paths whose owner PID
is proven dead (`ESRCH`), including the prior timestamp-based layout. Live owners,
permission-denied probes and unrelated entries are preserved. PID reuse can retain
a stale directory conservatively; same-process live workers are never swept.
Removal uses ten bounded retries with 100 ms retry delay; installation rename also
retries transient permission/busy/nonempty errors at most ten times. These bounds
help with Windows antivirus and handle release but do not replace packaged tests.

## Verification and reproduction

From the repository root:

```sh
npm run check
npm run test:desktop
node --test runtime/dist/test/desktop-bridge.test.js runtime/dist/test/desktop-service.test.js runtime/dist/test/desktop-realtime.test.js
npm run package:mac
```

For an actual model recording, provide 16 kHz mono signed little-endian PCM16:

```sh
npm run smoke:wake-word --workspace @nova-audio-agent/ambient-orb -- \
  --model-root /absolute/path/models/wake-word \
  --pcm /absolute/path/recording.pcm --expect-hits 1
```

Use `--expect-hits 0` for a negative sample. `--realtime` sends frames every 10 ms
through the production state machine without awaiting inference, reporting offered,
accepted and droppedFrames. Each sample can wake at most once in this mode. An
empty model root downloads the official archive. For a packaged check, execute the
same script with Electron and `--app-root /absolute/path/app.asar`; this loads the
packaged production worker, sherpa and WASM.

Historical evidence from 2026-09-05 on macOS arm64: the verified official model
loaded; a Tingting synthetic keyword sample hit once, and a different greeting plus
ordinary requests hit zero times. Node and Electron asar workers passed. The final
recorded packaged real-time samples accepted 128/128 positive frames and 567/567
negative frames, both with zero drops. These are observed samples, not universal
latency or drop guarantees. The earlier complete automated run reported 828 desktop
passes and three platform skips, 56 backend transport passes and a passing root
check. Those counts describe that snapshot, not the post-review merged branch.

The 2026-09-06 regression checks cover real interrupted download workers and active
replacement ownership, stale cleanup, bounded rename retry, manual-hide fallback,
matching native frames before acknowledgement, and heartbeat predicate/error/abort/
unref behavior. Before integration, the branch passed `npm run check` (206 audited files,
331 occurrences), the full desktop suite (839 tests: 836 passes, three platform
skips; source startup smoke skipped), and 57 backend desktop transport tests.
Loopback/Electron tests required running outside the restricted sandbox. These
checks do not include a new packaged model smoke. Merged-branch evidence is
recorded separately after integration.

After the single rebase onto `v0.2.0dev` at `2356305`, `npm run check` passed
(224 files, 387 audited occurrences). Desktop build and the complete test suite
passed: 876 tests, 873 passes and three platform skips; source startup smoke was
skipped. The 57 backend desktop transport tests passed. A production-handler
regression covers capability-only, wake-only and combined settings commits;
removing the capability restart condition makes that regression fail. No new
packaged or human-microphone acceptance is implied by these results.

Human microphone tests, distance/noise/echo variation, long standby and actual
Windows installed packages remain open. Linux releases are deferred; Ubuntu source
tests remain required, and Linux package evidence is needed before restoring that
release target. Record device, distance, sample count
and hit count; also check mute, restored session context and startup readiness.
Synthetic functional smoke cannot establish false-wake or missed-wake rates.

The 2026-09-06 review follow-up adds deterministic checks for blocked-state
`hideOrb` and the actual tray/shortcut callbacks, missing/false native epoch
capability handshakes, compressed USTAR+bzip2 extraction (including malformed and
truncated input), exact desktop dependency sets, and parity between electron-builder
`asarUnpack` and the final owned-ASAR layout. These checks address the corresponding
review test gaps; they do not close hardware or installed Windows acceptance.
Final integrated rerun results belong in [IMPLEMENTATION](IMPLEMENTATION.md).

## Deferred review items

The agreed review scope leaves I5 (snapshot copying in every heartbeat), I7 (native
onset visualization during disconnect), and I8 (encrypted settings comparison)
for later investigation. I4's blocked-state UX is described above. Minor findings
also remain deferred: initial lastReport initialization, optional worker access,
per-frame detector error recovery, explicit KWS stream release, per-key activity
IPC volume, limited pointer/keyboard activity sources, exposed dropped-frame
observability and settings confirmation wording. Windows retry and interruption
cleanup were pulled forward because they directly affect model installation.
