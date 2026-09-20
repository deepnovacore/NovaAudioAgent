# Mobile development environment

Verified 2026-09-20: Flutter 3.44.6, Dart 3.12.2, Xcode 16.4 (16F6), Android
platform 36/36.1, build-tools 36.0.0, Eclipse Temurin 21.0.12.1+1.
Flutter SDK, Android SDK/AVDs, Gradle cache, Pub cache and this app build output
resolve through symlinks to the external DeveloperStorage volume. Do not run a
build with the external volume unmounted. The previous Pub cache was copied,
39822 entries verified by SHA-256 and link targets, and retained for rollback.
No existing shared Xcode cache or device data was removed.

Android shell debug APK built successfully. No Android device is attached.
iOS Flutter destination build is blocked because Xcode reports iOS 18.5 platform
not installed. No usable iOS simulator runtime is installed. A wireless iPhone
is discoverable, but newer OS compatibility/signing/install are unverified.
Direct SDK compilation also stops at asset catalog compilation because no iOS simulator
runtime is available. This is an environment gate, not a passed iOS build.

Source and tool versions are recorded for reproducibility; caches, credentials,
signing material, local SDK configuration and device identifiers are not committed.
