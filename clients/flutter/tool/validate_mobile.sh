#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
flutter pub get
flutter analyze
flutter test
flutter build apk --debug
(cd android && ./gradlew :nova_audio:testDebugUnitTest :nova_audio:assembleDebugAndroidTest)
if [ "$(uname -s)" = Darwin ]; then
  flutter build ios --debug --no-codesign
fi
# Physical AEC and AOQ acceptance requires devices and host-issued credentials.
# See docs/acceptance.md; successful builds are not acoustic acceptance.
