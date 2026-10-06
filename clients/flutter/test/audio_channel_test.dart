import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_audio/channel_audio.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('native commands carry generation and typed PCM frames', () async {
    final calls = <MethodCall>[];
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(const MethodChannel('nova/audio'), (
      call,
    ) async {
      calls.add(call);
      return null;
    });
    final audio = ChannelAudio();
    await audio.startRelay(generation: 9, capture: true, threshold: 0.045);
    await audio.enqueue(Uint8List.fromList([78, 79, 86, 65]));
    expect(calls.first.arguments, {
      'generation': 9,
      'capture': true,
      'threshold': 0.045,
    });
    expect(calls[1].arguments['generation'], 9);
    await audio.disconnect();
    expect(calls.last.method, 'disconnect');
    messenger.setMockMethodCallHandler(const MethodChannel('nova/audio'), null);
  });
}
