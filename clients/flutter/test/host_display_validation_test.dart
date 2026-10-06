import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connection/session.dart';
import 'package:nova_mobile/conversation/controller.dart';
import 'support/fake_audio.dart';
import 'support/fake_transport.dart';
import 'session_test.dart' show handshake;

void main() {
  test('malformed display event stops connection', () async {
    final session = Session(
      audio: FakeAudio(),
      requestMicrophone: () async => true,
      openTransport: (_) async => FakeTransport(),
    );
    final model = ConversationController(session);
    addTearDown(() {
      model.dispose();
      session.dispose();
    });
    await session.connect(Uri.parse('wss://example.com/client/v1'), 'a' * 32);
    await session.receive(handshake(), session.generation);
    await session.receive(
      jsonEncode({
        'type': 'caption',
        'sequence': 0,
        'role': 'assistant',
        'text': 'x',
        'full_text': [],
      }),
      session.generation,
    );
    await Future<void>.delayed(Duration.zero);
    expect(session.connected, false);
  });
}
