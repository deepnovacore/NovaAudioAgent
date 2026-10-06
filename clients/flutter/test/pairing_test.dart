import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/protocol/pairing.dart';

void main() {
  test('pairing code uses WebSocket exchange and validates expiry', () {
    final now = DateTime.fromMillisecondsSinceEpoch(1000000);
    final data = {
      'type': 'nova.pair',
      'version': 1,
      'server': 'wss://example.com',
      'code': 'a' * 32,
      'expires_at': 1120000,
    };
    final p = PairingCode.parse(jsonEncode(data), now: now);
    expect(p.endpoint.toString(), 'wss://example.com/client/pair');
    expect(p.server.toString(), 'wss://example.com/client/v1');
    data['expires_at'] = 1000000;
    expect(
      () => PairingCode.parse(jsonEncode(data), now: now),
      throwsFormatException,
    );
    data.remove('expires_at');
    expect(PairingCode.parse(jsonEncode(data), now: now).expiresAt, isNull);
    data['server'] = 'wss://user:secret@example.com';
    expect(
      () => PairingCode.parse(jsonEncode(data), now: now),
      throwsFormatException,
    );
  });
}
