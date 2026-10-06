#!/usr/bin/env python3
"""Fetch pinned official SDKs into an explicitly selected external directory."""
import argparse
import hashlib
from pathlib import Path
import subprocess
import urllib.request
import zipfile

SDK = {
    'android': ('https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/en-US/20260817/crexrt/AoqClientSdk-release.aar', '3cb2ba3aa9a3133cb7847d5ecfcc6b054f379b368d19e4a855347a35299fb4d1', 'AoqClientSdk-release.aar'),
    'ios': ('https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260817/xojbbu/AoqClientSdk.framework.zip', 'ea01f00ab3c78e061d082faa5e30f9906b9156f9f6cfd2630509b54cd19e24b4', 'ios.zip'),
}

def link(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink() and target.resolve() == source.resolve():
        return
    if target.exists() or target.is_symlink():
        raise RuntimeError(f'Refusing to replace existing path: {target}')
    target.symlink_to(source)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--storage', required=True, type=Path)
    parser.add_argument('--platform', choices=['ios', 'android', 'all'], default='all')
    args = parser.parse_args()
    storage = args.storage.resolve() / 'nova-aoq' / '1.2.0'
    storage.mkdir(parents=True, exist_ok=True)
    package = Path(__file__).resolve().parents[1] / 'packages/nova_audio'
    for platform, (url, expected, filename) in SDK.items():
        if args.platform not in ['all', platform]:
            continue
        archive = storage / filename
        if not archive.exists():
            partial = archive.with_suffix(archive.suffix + '.partial')
            urllib.request.urlretrieve(url, partial)
            if hashlib.file_digest(partial.open('rb'), 'sha256').hexdigest() != expected:
                raise RuntimeError(f'{platform} SDK checksum mismatch')
            partial.rename(archive)
        if hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest() != expected:
            raise RuntimeError(f'{platform} SDK checksum mismatch')
        if platform == 'android':
            link(archive, package / 'Vendor/AoqClientSdk-release.aar')
        else:
            framework = storage / 'AoqClientSdk.xcframework'
            if not framework.exists():
                unpacked = storage / 'ios'
                with zipfile.ZipFile(archive) as zip_file:
                    for info in zip_file.infolist():
                        if not (unpacked / info.filename).resolve().is_relative_to(unpacked.resolve()):
                            raise RuntimeError('Invalid archive path')
                    zip_file.extractall(unpacked)
                subprocess.run(['xcodebuild', '-create-xcframework', '-framework', str(unpacked / 'AoqClientSdk.framework'), '-output', str(framework)], check=True)
            link(framework, package / 'ios/nova_audio/Vendor/AoqClientSdk.xcframework')
        print(f'{platform}: verified AOQ 1.2.0 {expected}')

if __name__ == '__main__':
    main()
