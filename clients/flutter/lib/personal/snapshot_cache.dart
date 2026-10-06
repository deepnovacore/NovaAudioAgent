import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'models.dart';

final class SnapshotCache {
  SnapshotCache(String host, {FlutterSecureStorage? storage})
    : _key = 'nova.personal.${sha256.convert(utf8.encode(host))}',
      _storage =
          storage ??
          // Same keychain class as the credential, so a backup cannot carry the
          // private snapshot to another device without the credential.
          const FlutterSecureStorage(
            iOptions: IOSOptions(
              accessibility: KeychainAccessibility.unlocked_this_device,
            ),
          );
  final String _key;
  final FlutterSecureStorage _storage;
  Future<void> _writes = Future.value();
  String? _pending;
  bool _scheduled = false;
  Future<PersonalSnapshot?> read() async {
    final raw = await _storage.read(key: _key);
    if (raw == null || utf8.encode(raw).length > 1048576) return null;
    try {
      return PersonalSnapshot(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  Future<void> write(PersonalSnapshot snapshot) {
    final raw = jsonEncode(snapshot.data);
    if (utf8.encode(raw).length > 1048576) return Future.value();
    // Only the newest snapshot matters: at most one write waits behind the
    // one in flight, instead of queueing every snapshot (up to 1 MiB each).
    _pending = raw;
    if (_scheduled) return _writes;
    _scheduled = true;
    return _writes = _writes.catchError((Object _) {}).then((_) async {
      _scheduled = false;
      final value = _pending;
      _pending = null;
      if (value != null) await _storage.write(key: _key, value: value);
    });
  }

  Future<void> clear() {
    _pending = null;
    return _writes = _writes
        .catchError((Object _) {})
        .then((_) => _storage.delete(key: _key));
  }
}
