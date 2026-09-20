# Mobile development environment

Verified 2026-09-20: Flutter 3.44.6, Dart 3.12.2, Xcode 16.4 (16F6), Android
platform 36/36.1, build-tools 36.0.0, Eclipse Temurin 21.0.12.1+1.
Flutter SDK, Android SDK/AVDs, Gradle cache, Pub cache and this app build output
resolve through symlinks to the external DeveloperStorage volume. Do not run a
build with the external volume unmounted. The previous Pub cache was copied,
39822 entries verified by SHA-256 and link targets, and retained for rollback.
No existing shared Xcode cache or device data was removed.

Full public Android debug APK built and launched on an API 36 arm64 emulator.
The existing external AVD is used read-only; emulator results are not AEC proof.
iOS 17.5 runtime is mounted read-only from the existing external DMG and the
original SwiftUI app builds with the external acceptance Xcode copy. Flutter's
asset compiler additionally requires 18.5, downloading to external storage.
CoreSimulator rejected creating a device set on external storage; an existing
local iPhone simulator is used, without deleting or relocating user device data.

The pinned AOQ iOS SDK contains device binaries only. For simulator builds use
`NOVA_AOQ_SIMULATOR=1 flutter build ios --simulator`; omit this environment flag
for device builds to include the real SDK. The simulator advertises no AOQ.

Source and tool versions are recorded for reproducibility; caches, credentials,
signing material, local SDK configuration and device identifiers are not committed.
