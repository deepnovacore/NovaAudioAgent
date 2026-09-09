#!/bin/sh
set -eu
nova_ios_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
nova_sdk_tmp=$(mktemp -d)
trap 'rm -rf "$nova_sdk_tmp"' EXIT
curl -fL --max-time 120 'https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260817/xojbbu/AoqClientSdk.framework.zip' -o "$nova_sdk_tmp/sdk.zip"
printf '%s  %s\n' 'ea01f00ab3c78e061d082faa5e30f9906b9156f9f6cfd2630509b54cd19e24b4' "$nova_sdk_tmp/sdk.zip" | shasum -a 256 -c -
unzip -q "$nova_sdk_tmp/sdk.zip" -d "$nova_sdk_tmp/unpacked"
mkdir -p "$nova_ios_root/Vendor"
ditto "$nova_sdk_tmp/unpacked/AoqClientSdk.framework" "$nova_ios_root/Vendor/AoqClientSdk.framework"
