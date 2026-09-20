# Mobile acceptance evidence

Implementation is in progress; this is not release acceptance.

Verified locally:
- 53 Flutter tests, including shared protocol vectors, input/approval state,
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
- Full current Android APK: SDK platform 35 installation was interrupted and is
  being completed on external storage. Earlier Maven download timeout recovered.
- Full iOS build: matching iOS 18.5 simulator platform runtime absent; download
  is on external storage. A 17.5 runtime does not satisfy storyboard compilation.
- Simulator/device navigation and side-by-side original visual comparisons.
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
malformed display-event cleanup). Latest default suite: 56 passed, one opt-in
socket test skipped; the socket test separately passed with the synthetic host.
