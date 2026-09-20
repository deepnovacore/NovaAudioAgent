# Mobile acceptance evidence

Android implementation/build/page checks are recorded below. iOS device, live-service and physical-audio gates remain open; this is not release acceptance.

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
- Full iOS device/AOQ build and physical-device acceptance (simulator has no
  device-only AOQ binary).
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
