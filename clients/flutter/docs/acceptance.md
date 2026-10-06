# Mobile acceptance evidence

Android and iOS build/page checks are recorded below. Signed-device, live-service and physical-audio gates remain open; this is not release acceptance.

Verified locally:
- 57 Flutter tests, including shared protocol vectors, input/approval state,
  permissions cancelled before completion, AOQ ready fencing and large-text layouts.
- Dart analyzer clean at that run.
- Actual WebSocket integration with the repository ClientServer: cascaded text,
  correlated applied acknowledgement and returned caption. Synthetic host is
  `tool/mobile_mock.mjs`; run test with `--dart-define=NOVA_SOCKET_ACCEPTANCE=true`.
- Android relay debug APK and native JVM tests passed before UI plugin additions.
- Android native AOQ adapter compiles against official 1.2.0 SDK.
- iOS relay/AOQ source typechecks against device SDK and pinned AOQ framework.
- Native Swift core self-check covers ledger, callback fences, bounded handoff,
  mute pacing and the shared protocol fixture.

Pending:
- Signed physical-device acceptance (simulator has no device-only AOQ binary).
- Remaining source-to-screen visual differences and real-device navigation.
- Physical relay/AOQ voice on iOS and Android; permission, interruptions, route
  changes, Bluetooth, speaker playback, reconnect and lifecycle acceptance.
- Acoustic AEC: far-end only, double talk and close speech at multiple volumes;
  record echo leakage, false speech onset, interruption delay and route-specific
  differences. Availability/enabled diagnostics are not an AEC quality pass.
- Android 16 kHz input/24 kHz output device support: current adapter fails visibly
  on unsupported hardware; resampling fallback has not yet been implemented.

AOQ 1.2.0 Android libraries include arm64-v8a and armeabi-v7a only. x86 devices
must not advertise AOQ. iOS simulator builds do not advertise the device SDK.
Official reference: https://www.alibabacloud.com/help/en/model-studio/realtime-sdk-download
The fetch script pins archive hashes; vendor binaries are ignored and never
committed. No redistribution rights are inferred from SDK download access.

Independent source review: four findings fixed and covered by regressions (AOQ
clear ownership, edited-address token carryover, dictation onset isolation,
malformed display-event cleanup). Previous default suite: 56 passed, one opt-in
socket test skipped; the socket test separately passed with the synthetic host.

## Additional simulator evidence (2026-09-20)

Android API 36 executed all nine public screenshot scenes after composer and
primary-button layout corrections: disconnected, settings top/bottom, connected
empty, chat, draft, approval, expired approval, disconnected history.
Images reside on the local external disk in
`DeveloperStorage/Evidence/nova-flutter/public-android`.
The original SwiftUI public client also ran on iPhone 15/iOS 17.5 with a local
synthetic WebSocket host; disconnected/settings/connected/chat screenshots are
in the sibling `original-public-ios` directory. This is not pixel-perfect
acceptance: platform font/control rendering and some settings spacing differ.
The original Nova icon is reused without modification. The draft fixture does
not open the platform IME; keyboard coverage is not claimed.

Android instrumentation: two tests passed (three playback start/stop cycles
without capture, and oversized AOQ callbacks retaining a non-negative backlog).
The latter first failed at -65537, then passed after fixing reservation order.
Native JVM tests passed. Current public Dart tests: 57 passed, one opt-in socket
case skipped; analyzer passed. No acoustic AEC claim follows from these tests.

Final Android production-entry debug APK build passed. Original public SwiftUI
reference now has nine screenshots, including approval expiry (all buttons
disabled) and disconnected history. Public Flutter has nine Android screenshots.
The synthetic host actual-WebSocket acceptance passed after adding approval
fixtures. All screenshots are test data, not company service evidence.

Public Flutter iOS simulator production build passed (27 seconds after the
runtime cache became available). All nine integration screenshot scenes then
passed on iPhone 15/iOS 17.5, including three native playback-only start/stop
cycles and explicit disabled-button checks after approval expiry. Files are in
`public-ios`. Flutter integration images capture the Flutter surface; original
reference simctl images include system chrome. This is not pixel identity.

The public iOS device-target debug build passed without signing
on 2026-09-21. The public build took 89.7 seconds; its Runner.debug.dylib links
@rpath/AoqClientSdk.framework/AoqClientSdk and the framework is bundled. This
verifies compilation/packaging, not installation, live calls or acoustic AEC.
The final public Android nine-scene run passed after the approval presentation
fix; its production-entry APK was rebuilt successfully afterward.

## v0.3.0 workbench checkpoint (2026-10-04)

M1–M4 implementation and automated acceptance are recorded in
[workbench-progress.md](workbench-progress.md). Independent code reviews were
performed after M1, after M4 and before preparing this report. Automated checks
are not physical, model or acoustic acceptance.

- Full npm suite: 4549 passed, 11 existing skips. Final bounded runtime regressions
  after review: 70 passed, 1 existing skip.
- Flutter analyzer clean; 80 tests passed, 1 opt-in socket test skipped in the
  default run. The opt-in real-WebSocket synthetic test passed separately.
- Four phone-size cached-workbench golden scenes passed comparison and visual
  inspection. Android debug APK/native checks and iOS simulator debug build passed.
- Final `tool/validate_mobile.sh` rerun passed, including unsigned iOS
  device-target debug compilation. This does not validate signing or installation.
- iPhone signing team/installation and both physical phones are deferred at the
  user's request. No current physical results are inferred from older checkpoints.

| Physical scenario | Xiaomi | iPhone |
| --- | --- | --- |
| QR pair, restart reconnect, device revocation returns to pairing | pending | pending |
| Bidirectional todo create/complete within one second | pending | pending |
| Concurrent edit version conflict | pending | pending |
| Idea-to-goal linkage on both devices | pending | pending |
| Reminder badge/read counts and execute/later/ignore | pending | pending |
| Text and dictation reach the selected conversation | pending | pending |
| Delegated task approval and completion handoff card | pending | pending |
| Offline cache, Mac restart, reconnect without duplicate writes | pending | pending |
| Live voice smoke, including first microphone permission | pending | pending |

Run the two phones sequentially: a second concurrent phone receives 4009.
Use the Mac built-in shared endpoint over Tailscale. An explicitly configured
external phone server owns separate state and is not local-workbench sync.
Public-history audit found no new company pilot integration, but an old deleted
public document still has a real tailnet address in reachable history; see the
progress record. That legacy history was not rewritten.


### Five-tab UI update (2026-10-04)

The intermediate Flutter navigation was Nova / Feeds / Todos / Ideas·Goals / Profile.
The earlier four-tab screenshot checkpoint above describes the previous revision.
Five replacement widget goldens and 320dp large-text layout checks passed; the
full Flutter suite passed 86 tests with one existing opt-in socket skip. These are
synthetic UI checks, not M5 phone-to-Mac acceptance. All unobserved live scenarios
remain pending. Android package installation is preparation, not sync acceptance.


### Topbar / independent Ideas and Goals (2026-10-04)

Current bottom tabs: Nova / Feeds / Todos / Ideas / Goals. Profile moved to the
new shared topbar. Feeds includes read-only desktop news recommendations and
saved articles as well as reminders and task activity. Source/connector management
remains unavailable. Six golden scenes cover the five tabs plus Profile, including
320dp large-text navigation. Flutter analyzer passed; 87 tests passed with one
existing opt-in socket skip. Runtime client-server tests: 20 passed. Independent
Claude Sonnet review found no concrete P1/P2; producer limits were checked (at most
100 saved articles and bounded recommendation list, 700-character summaries).

Physical iPhone preparation: a signed Release package was installed and launched
successfully after trusting the development identity. The user attempted QR pairing;
agent-observed last state was Disconnected with empty credentials. Later the user
reported a connection, which still needs on-screen verification. macOS iPhone
Mirroring intermittently reports the phone in use/unavailable. USB CoreDevice
reports connected. These observations do not establish the cause of the Nova
connection issue, or implicate WireGuard. All nine live scenarios remain pending.

The latest Topbar/independent-tab signed iPhone Release also built successfully
(34.3 MB), passed strict/deep codesign verification, and was installed and launched
on the connected iPhone 13 Pro. The Mac workbench was rebuilt and restarted with
the news projection. Device screenshots and real data parity remain pending.


### Physical follow-up (2026-10-04, 23:22 CST)

- Xiaomi 14 (`<device-serial>`): installed the current debug APK over USB with
  `adb install -r` (Success). The user confirmed that basic acceptance passed.
  This is a user-reported basic pass, not an agent-observed pass of every M5
  scenario. The app was then stopped to release the one-phone connection slot.
- iPhone 13 Pro: current Release build succeeded (34.1 MB), strict/deep
  codesign verification passed, and CoreDevice installation and launch succeeded.
  Developer Mode was reported enabled. Mirroring showed the new Nova and Profile
  UI, but the client was disconnected with empty connection fields. Real-data
  synchronization and the remaining iPhone checks still require physical QR scan.
- Desktop: started this worktree against the existing local profile. Full desktop
  build failed during release-app dependency staging with ENOSPC; runtime
  compilation succeeded. Removed only the incomplete generated release-app stage.
  Source-mode launch later displayed real workbench suggestions.
- Desktop outage investigated: captured `backend control unavailable` in settings
  handlers and runtime process exit code 0. The two earlier telemetry runs at
  22:20 and 22:23 recorded pipeline configuration but no successful provider
  connection. Those logs do not establish the original exit trigger. A fresh
  diagnostic run at 23:13:50 reached supervisor connected at 23:14:27 (about
  37 seconds), restored the workbench and pairing UI, and remained connected
  through 23:22. This is recovery evidence, not a root-cause fix or a long-duration
  stability pass. Temporary source diagnostics were removed after collection.
- Mac Tailscale was initially stopped; resumed the existing connection. A new QR
  code was prepared for the iPhone. Mirroring cannot operate its camera, so scan
  remains a physical user step.

All unobserved conflict, bidirectional-write, approval, reconnect, live-voice and
large-font checks remain pending; the Xiaomi basic confirmation does not close
those individual gates. No commit or push was performed.
