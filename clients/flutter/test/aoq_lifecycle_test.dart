import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_audio/aoq_port.dart';
import 'package:nova_mobile/connection/session.dart';
import 'support/fake_audio.dart';
import 'support/fake_transport.dart';
import 'session_test.dart' show handshake;

class FakeAoq extends FakeAudio implements AoqPort {
  bool started = false;
  int clears = 0;
  @override
  Future<Map<String, Object?>> capabilities() async => {
    'relay': true,
    'aoq': true,
  };
  @override
  Future<void> startAoq(
    Map<String, Object?> payload, {
    required int generation,
    required bool runtime,
  }) async {
    expect(stopCount, greaterThan(0));
    started = true;
  }

  @override
  Future<void> aoqCommand(Map<String, dynamic> event) async {}
  @override
  Future<void> aoqClear() async {
    clears++;
  }
}

void main() {
  test(
    'AOQ waits for native ready and ignores late callback after end',
    () async {
      final audio = FakeAoq(), transport = FakeTransport();
      final s = Session(
        audio: audio,
        requestMicrophone: () async => true,
        openTransport: (_) async => transport,
      );
      addTearDown(s.dispose);
      await s.connect(Uri.parse('wss://example.com/client/v1'), 'a' * 32);
      final ready = jsonDecode(handshake()) as Map<String, dynamic>;
      ready['media'] = {
        'pipeline': 'integrated',
        'transport': 'qwen_aoq_runtime_v1',
        'path': 'direct',
        'audio_owner': 'aoq_sdk',
        'mode': 'runtime',
      };
      await s.receive(jsonEncode(ready), s.generation);
      expect(s.connected, true);
      await s.startVoice();
      await Future<void>.delayed(Duration.zero);
      final request = transport.sent
          .whereType<String>()
          .map(jsonDecode)
          .firstWhere((v) => v['type'] == 'aoq.connect');
      await s.receive(
        jsonEncode({
          'type': 'aoq.credentials',
          'request_id': request['request_id'],
          'connection_id': s.connection,
          'mode': 'runtime',
          'credentials': {},
        }),
        s.generation,
      );
      expect(audio.started, true);
      expect(s.voice, false);
      expect(s.voiceStarting, true);
      final generation = s.generation;
      audio.controller.add({'kind': 'aoq_ready', 'generation': generation});
      expect(s.voice, true);
      await s.receive(
        jsonEncode({
          'type': 'playback.clear',
          'utterance_id': 'reply',
          'generation_epoch': 1,
        }),
        s.generation,
      );
      expect(audio.clears, 1);
      await s.end();
      audio.controller.add({'kind': 'aoq_ready', 'generation': generation});
      expect(s.voice, false);
    },
  );
}
