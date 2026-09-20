import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/protocol/wire.dart';

Uint8List bytes(String s) => Uint8List.fromList(utf8.encode(s));
Uint8List unhex(String s) => Uint8List.fromList([
  for (var i = 0; i < s.length; i += 2)
    int.parse(s.substring(i, i + 2), radix: 16),
]);
Map<String, dynamic> ready() => {
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
};
void main() {
  final vectors =
      jsonDecode(
            File(
              '../../fixtures/client-protocol/v1/vectors.json',
            ).readAsStringSync(),
          )
          as List;
  for (final v in vectors) {
    test('shared ${v['name']}', () {
      if (v['valid'] != true) {
        expect(() => Wire.audio(unhex(v['hex'])), throwsFormatException);
        return;
      }
      final f = Wire.audio(unhex(v['hex']));
      expect(f.identity.utteranceId, v['expected']['utterance_id']);
      expect(f.identity.epoch, v['expected']['generation_epoch']);
      expect(f.sequence, v['expected']['sequence']);
      expect(f.pcm, orderedEquals(unhex(v['expected']['pcm_hex'])));
    });
  }
  for (final token in ['1.0', '1e0', '-0', 'true', '-1', '9007199254740992']) {
    test(
      'reject epoch token $token',
      () => expect(
        () => Wire.json(bytes('{"generation_epoch":$token}')),
        throwsFormatException,
      ),
    );
  }
  test('last duplicate escaped key wins', () {
    expect(
      Wire.json(bytes(r'{"sequence":1.0,"sequen\u0063e":2}'))['sequence'],
      2,
    );
    expect(
      () => Wire.json(bytes(r'{"sequence":2,"sequen\u0063e":1.0}')),
      throwsFormatException,
    );
    expect(
      Wire.json(bytes('{"nested":{"sequence":1.0},"sequence":2}'))['sequence'],
      2,
    );
  });
  test('bad JSON and invalid UTF8 cannot enter protocol', () {
    for (final value in [
      bytes('[]'),
      Uint8List.fromList([0xff]),
      bytes('{'),
      bytes('{"a":1}'),
    ]) {
      expect(() => Wire.json(value, limit: 3), throwsFormatException);
    }
  });
  test('secure endpoint prevents credential-bearing URL', () {
    expect(
      Wire.endpoint('wss://example.com').toString(),
      'wss://example.com/client/v1',
    );
    for (final s in [
      'ws://example.com',
      'wss://u:p@example.com',
      'wss://example.com/other',
      'wss://example.com?token=x',
      'wss://example.com#x',
    ]) {
      expect(
        () => Wire.endpoint(s, debugLocalhost: true),
        throwsFormatException,
      );
    }
    expect(
      Wire.endpoint('ws://127.0.0.1:18787', debugLocalhost: true).port,
      18787,
    );
  });
  test('handshake requires advertised format and capabilities', () {
    expect(Wire.ready(ready()).editableInput, false);
    final r = ready()
      ..['media'] = {
        'transport': 'host_pcm_v1',
        'pipeline': 'cascaded',
        'path': 'relay',
        'audio_owner': 'client',
      };
    r['capabilities'] = [
      'audio',
      'captions',
      'projects',
      'executor',
      'text_input',
      'dictation',
    ];
    expect(Wire.ready(r).editableInput, true);
    r['input_audio']['sample_rate'] = 48000;
    expect(() => Wire.ready(r), throwsFormatException);
  });
  test('AOQ is rejected unless compiled capability permits it', () {
    final r = ready()
      ..['media'] = {
        'transport': 'qwen_aoq_runtime_v1',
        'pipeline': 'integrated',
        'path': 'direct',
        'audio_owner': 'aoq_sdk',
        'mode': 'runtime',
      };
    expect(() => Wire.ready(r), throwsFormatException);
    expect(Wire.ready(r, allowAOQRuntime: true).aoqRuntime, true);
    r['capabilities'] = ['audio', 'captions'];
    expect(() => Wire.ready(r, allowAOQRuntime: true), throwsFormatException);
  });
}
