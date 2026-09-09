#!/bin/sh
set -eu
[ "$PLATFORM_NAME" = iphoneos ] || exit 0
nova_framework="$SRCROOT/Vendor/AoqClientSdk.framework"
[ -d "$nova_framework" ] || { echo 'Run sh clients/ios/Nova/scripts/fetch-aoq.sh before a device build.' >&2; exit 1; }
mkdir -p "$TARGET_BUILD_DIR/$FRAMEWORKS_FOLDER_PATH"
ditto "$nova_framework" "$TARGET_BUILD_DIR/$FRAMEWORKS_FOLDER_PATH/AoqClientSdk.framework"
if [ "${CODE_SIGNING_ALLOWED:-NO}" = YES ] && [ -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]; then
  codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" --preserve-metadata=identifier,flags "$TARGET_BUILD_DIR/$FRAMEWORKS_FOLDER_PATH/AoqClientSdk.framework"
fi
