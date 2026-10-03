import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'models.dart';

final class SnapshotCache {
  SnapshotCache(String host, {FlutterSecureStorage? storage})
    : _key = 'nova.personal.${sha256.convert(utf8.encode(host))}',
      _storage = storage ?? const FlutterSecureStorage();
  final String _key;
  final FlutterSecureStorage _storage;
  Future<void> _writes = Future.value();
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
    return _writes = _writes
        .catchError((Object _) {})
        .then((_) => _storage.write(key: _key, value: raw));
  }

  Future<void> clear() => _writes = _writes
      .catchError((Object _) {})
      .then((_) => _storage.delete(key: _key));
}
