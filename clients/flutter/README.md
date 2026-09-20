# Nova Flutter mobile client

Migration of the public native iOS client, targeting iOS 17+ and Android 24+.
Implementation is in progress. See docs/parity.md and docs/environment.md for
actual evidence and missing gates. The native app remains in clients/ios/Nova.

Run `flutter pub get`, `flutter test`, and `flutter analyze` from this directory.
Use external SDK/cache/build storage as documented in the approved migration design.
No production endpoint or token is embedded. Development app identity is separate
from the original native application so both can coexist during comparison.
