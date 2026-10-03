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
asset compiler additionally requires 18.5, now installed from external storage.
CoreSimulator rejected creating a device set on external storage; an existing
local iPhone simulator is used, without deleting or relocating user device data.

The pinned AOQ iOS SDK contains device binaries only. For simulator builds use
`NOVA_AOQ_SIMULATOR=1 flutter build ios --simulator`; omit this environment flag
for device builds to include the real SDK. The simulator advertises no AOQ.

Source and tool versions are recorded for reproducibility; caches, credentials,
signing material, local SDK configuration and device identifiers are not committed.

## Runtime recovery, 2026-09-21

iOS 18.5 official Apple asset now resides under external
`SDKs/ios-runtime-downloads`. SHA-256 was verified before decrypting.
The asset requires `aea decrypt`, then `aa patch` from an empty directory;
`aa extract` does not unpack this asset format. Its outer image mounts as
`/Volumes/iOS 18.5 Simulator Bundle`; the nested Restore image mounts as
`/Volumes/iOS 18.5 Simulator`. A runtime symlink was added only to the task
Xcode copy. The global Xcode selection was not changed.

The two public Flutter Runner DerivedData directories were moved to external
`Builds/nova-flutter-xcode-derived` and linked back. Existing simulator device
data remains local because CoreSimulator rejected the external device-set path.
Short-lived SwiftPM diagnostics used /private/tmp; the task Xcode ManifestAPI
was restored after the local-library experiment failed to resolve startup.
Do not treat SDK installation as a successful iOS build.

Task environment persists at external `Environments/nova-flutter.sh`. Source it
before builds. It explicitly sets `JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=...`
because Java/Gradle did not honor TMPDIR alone and previously filled local temp.
The iOS 18.5 system dyld cache finished generating (~2.6 GB); with it available,
the public full simulator build passed in 27 seconds. Moving this root-owned
cache to the external disk still requires the user's administrator command.

## Workbench build recovery (2026-10-04)

On this machine the SDKs and acceptance Xcode are on `$NOVA_EXT`,
not their default locations. Source
`$NOVA_EXT/Environments/nova-flutter.sh` before
validation. Other machines must configure equivalent paths themselves.

After a reboot the pre-existing runtime symlinks may point to unmounted images.
The iOS 18.5 images were restored read-only with:

```sh
hdiutil attach -readonly -nobrowse $NOVA_EXT/SDKs/ios-runtime-downloads/runtime/AssetData/044-89849-100.dmg
hdiutil attach -readonly -nobrowse '/Volumes/iOS 18.5 Simulator Bundle/Restore/044-89417-100.dmg'
```

The app and nova_audio already require iOS 17.0. When runtimes were unavailable,
Flutter temporarily generated a Swift package with its 13.0 fallback; a fresh
build after Xcode could read build settings restored the correct target without
changing the project. `NOVA_AOQ_SIMULATOR=1 flutter build ios --simulator --debug`
then passed. No signing identity, system Xcode selection or device settings were
changed. Device signing and physical acceptance remain separate steps.
