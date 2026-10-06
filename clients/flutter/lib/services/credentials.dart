import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../protocol/wire.dart';
import '../personal/snapshot_cache.dart';

final class Credential {
  Credential(this.server, this.token, {this.expiresAt}) {
    Wire.endpoint(server.toString());
    if (!RegExp(r'^[0-9a-f]{32}$').hasMatch(token)) {
      throw const FormatException('Invalid device token');
    }
  }
  final Uri server;
  final String token;
  final DateTime? expiresAt;
  bool get expired => expiresAt != null && !expiresAt!.isAfter(DateTime.now());
  Map<String, Object?> toJson() => {
    'server': server.toString(),
    'token': token,
    'expires_at': expiresAt?.millisecondsSinceEpoch,
  };
  factory Credential.fromJson(Map<String, dynamic> data) => Credential(
    Uri.parse(data['server'] as String),
    data['token'] as String,
    expiresAt: data['expires_at'] == null
        ? null
        : DateTime.fromMillisecondsSinceEpoch(data['expires_at'] as int),
  );
}

abstract interface class CredentialStore {
  Future<Credential?> read();
  Future<void> write(Credential credential);
  Future<void> clear();
}

final class SecureCredentialStore implements CredentialStore {
  SecureCredentialStore({FlutterSecureStorage? storage})
    : _storage =
          storage ??
          const FlutterSecureStorage(
            iOptions: IOSOptions(
              accessibility: KeychainAccessibility.unlocked_this_device,
            ),
          );
  final FlutterSecureStorage _storage;
  static const _key = 'nova.mobile.credential.v1';
  @override
  Future<Credential?> read() async {
    final text = await _storage.read(key: _key);
    if (text == null) return null;
    try {
      final value = Credential.fromJson(
        jsonDecode(text) as Map<String, dynamic>,
      );
      if (value.expired) {
        await clear();
        return null;
      }
      return value;
    } on FormatException {
      await clear();
      return null;
    } on TypeError {
      await clear();
      return null;
    }
  }

  @override
  Future<void> write(Credential credential) async {
    if (credential.expired) throw const FormatException('Credential expired');
    await _storage.write(key: _key, value: jsonEncode(credential.toJson()));
  }

  @override
  Future<void> clear() async {
    final raw = await _storage.read(key: _key);
    Credential? credential;
    try {
      if (raw != null) {
        credential = Credential.fromJson(jsonDecode(raw) as Map<String, dynamic>);
      }
    } on FormatException {
      /* malformed credential has no usable cache scope */
    } on TypeError {
      /* malformed credential has no usable cache scope */
    }
    if (credential != null) {
      await SnapshotCache(
        '${credential.server}#${credential.token}',
        storage: _storage,
      ).clear();
    }
    await _storage.delete(key: _key);
  }
}
