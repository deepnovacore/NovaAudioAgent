import 'dart:convert';
import 'dart:typed_data';
import 'wire.dart';

final class PairingCode {
  const PairingCode(this.server, this.code, this.expiresAt);
  final Uri server;
  final String code;
  final DateTime? expiresAt;
  Uri get endpoint => server.replace(path: '/client/pair');
  static PairingCode parse(String text, {DateTime? now}) {
    final v = Wire.json(Uint8List.fromList(utf8.encode(text)), limit: 4096);
    if (v['type'] != 'nova.pair' ||
        v['version'] != 1 ||
        v['version'] is! int ||
        v['server'] is! String ||
        v['code'] is! String ||
        !RegExp(r'^[0-9a-f]{32}$').hasMatch(v['code'])) {
      throw const FormatException('Invalid Nova pairing code');
    }
    final raw = v['expires_at'];
    DateTime? expiry;
    if (raw != null) {
      if (raw is! num || !raw.isFinite || raw.abs() > 8640000000000000) {
        throw const FormatException('Invalid pairing expiry');
      }
      expiry = DateTime.fromMillisecondsSinceEpoch(raw.toInt());
      if (!expiry.isAfter(now ?? DateTime.now())) {
        throw const FormatException('Pairing code expired');
      }
    }
    return PairingCode(Wire.endpoint(v['server']), v['code'], expiry);
  }
}
