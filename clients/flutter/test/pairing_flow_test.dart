import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/protocol/pairing.dart';
import 'package:nova_mobile/services/pairing_flow.dart';
import 'support/fake_transport.dart';

void main() {
  test('cancelled pairing closes socket and ignores late result', () async {
    final socket = FakeTransport();
    final opening = Completer<FakeTransport>();
    final pairing = PairingFlow(open: (_) => opening.future);
    final result = pairing.redeem(
      PairingCode(Uri.parse('wss://example.com/client/v1'), 'a' * 32, null),
    );
    pairing.cancel();
    opening.complete(socket);
    expect(await result, isNull);
  });
}
