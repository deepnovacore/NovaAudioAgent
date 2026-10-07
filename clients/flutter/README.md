# Nova Flutter mobile client

Migration of the public native iOS client, targeting iOS 17+ and Android 24+.
Implementation is in progress and this client is not part of the 0.3.0 release:
signed-device, Android, live-service and physical-audio acceptance are still open.
See docs/acceptance.md, docs/parity.md and docs/environment.md for actual evidence
and missing gates. The supported iPhone app remains the native one in clients/ios/Nova.
No Apple development team is committed; select yours in Xcode or pass `DEVELOPMENT_TEAM`.

Run `flutter pub get`, `flutter test`, and `flutter analyze` from this directory.
Use external SDK/cache/build storage as documented in the approved migration design.
No production endpoint or token is embedded. Development app identity is separate
from the original native application so both can coexist during comparison.
