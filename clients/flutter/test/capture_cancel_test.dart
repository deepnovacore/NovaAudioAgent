import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connection/session.dart';
import 'support/fake_audio.dart';
import 'support/fake_transport.dart';
import 'session_test.dart' show handshake;

void main() {
  test(
    'stop invalidates pending permission without disconnecting host',
    () async {
      final permission = Completer<bool>();
      final audio = FakeAudio();
      final s = Session(
        audio: audio,
        requestMicrophone: () => permission.future,
        openTransport: (_) async => FakeTransport(),
      );
      addTearDown(s.dispose);
      await s.connect(Uri.parse('wss://example.com/client/v1'), 'a' * 32);
      await s.receive(handshake(), s.generation);
      final starting = s.startVoice();
      await s.stopCapture();
      permission.complete(true);
      await starting;
      expect(audio.startCount, 0);
      expect(s.voice, false);
      expect(s.connected, true);
    },
  );
}
