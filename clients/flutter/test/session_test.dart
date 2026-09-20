import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connection/session.dart';
import 'support/fake_audio.dart';
import 'support/fake_transport.dart';

String handshake() => jsonEncode({
  'type': 'client.ready',
  'protocol_version': 1,
  'server_instance_id': '01234567-0123-4123-8123-012345678901',
  'connection_id': '01234567-0123-4123-8123-012345678902',
  'capabilities': ['audio', 'captions', 'projects', 'executor'],
  'input_audio': {'encoding': 'pcm_s16le', 'sample_rate': 16000, 'channels': 1},
  'output_audio': {
    'encoding': 'pcm_s16le',
    'sample_rate': 24000,
    'channels': 1,
  },
});
void main() {
  Future<void> ready(Session s) async {
    await s.connect(Uri.parse('wss://example.com/client/v1'), 'a' * 32);
    await s.receive(handshake(), s.generation);
  }

  for (final background in [true, false]) {
    test(
      'late microphone grant after ${background ? 'background' : 'end'} cannot capture',
      () async {
        final a = FakeAudio(),
            t = FakeTransport(),
            permission = Completer<bool>();
        final s = Session(
          audio: a,
          openTransport: (_) async => t,
          requestMicrophone: () => permission.future,
        );
        addTearDown(s.dispose);
        await ready(s);
        final pending = s.startVoice();
        if (background) {
          await s.background();
        } else {
          await s.end();
        }
        permission.complete(true);
        await pending;
        expect(a.startCount, 0);
        expect(s.voice, false);
        expect(s.connected, false);
      },
    );
  }
  test('obsolete ready and PCM do not revive connection', () async {
    final a = FakeAudio(), t = FakeTransport();
    final s = Session(
      audio: a,
      openTransport: (_) async => t,
      requestMicrophone: () async => true,
    );
    addTearDown(s.dispose);
    await ready(s);
    final old = s.generation;
    await s.end();
    await s.receive(handshake(), old);
    await s.receive(Uint8List(1), old);
    expect(s.connected, false);
  });
  test('native startup failure releases voice state', () async {
    final a = FakeAudio()..failStart = true, t = FakeTransport();
    final s = Session(
      audio: a,
      openTransport: (_) async => t,
      requestMicrophone: () async => true,
    );
    addTearDown(s.dispose);
    await ready(s);
    await s.startVoice();
    expect(s.voice, false);
    expect(s.voiceStarting, false);
    expect(s.status, contains('capture failed'));
  });
  test('oversized outbound packet fails bounded session', () async {
    final a = FakeAudio(), t = FakeTransport();
    final s = Session(
      audio: a,
      openTransport: (_) async => t,
      requestMicrophone: () async => true,
    );
    addTearDown(s.dispose);
    await ready(s);
    await s.sendRaw(Uint8List(131073));
    expect(s.connected, false);
    expect(t.sent.whereType<Uint8List>(), isEmpty);
  });
  test('refusal close never schedules recovery', () async {
    final a = FakeAudio(), t = FakeTransport()..closeCode = 4003;
    var opens = 0;
    final s = Session(
      audio: a,
      openTransport: (_) async {
        opens++;
        return t;
      },
      requestMicrophone: () async => true,
    );
    addTearDown(s.dispose);
    await ready(s);
    await t.input.close();
    await Future<void>.delayed(Duration.zero);
    expect(s.connected, false);
    expect(s.connecting, false);
    expect(opens, 1);
  });
  test('malformed initial handshake is incompatible, never audio', () async {
    final a = FakeAudio(), t = FakeTransport();
    final s = Session(
      audio: a,
      openTransport: (_) async => t,
      requestMicrophone: () async => true,
    );
    addTearDown(s.dispose);
    await s.connect(Uri.parse('wss://example.com'), 'a' * 32);
    await s.receive('{}', s.generation);
    expect(s.connected, false);
    expect(s.connecting, false);
    expect(a.startCount, 0);
  });
}
