import 'dart:async';
import 'dart:typed_data';
import 'package:nova_audio/nova_audio.dart';

class FakeAudio implements AudioPort {
  final controller = StreamController<Map<String, Object?>>.broadcast(
    sync: true,
  );
  int startCount = 0, stopCount = 0;
  bool failStart = false;
  @override
  Stream<Map<String, Object?>> get events => controller.stream;
  @override
  Future<Map<String, Object?>> capabilities() async => {
    'relay': true,
    'aoq': false,
  };
  @override
  Future<void> startRelay({
    required int generation,
    required bool capture,
    required double threshold,
  }) async {
    if (failStart) throw StateError('capture failed');
    startCount++;
  }

  @override
  Future<void> enqueue(Uint8List f) async {}
  @override
  Future<void> terminal(String u, int e) async {}
  @override
  Future<void> clear(String u, int e) async {}
  @override
  Future<void> mute(bool v) async {}
  @override
  Future<void> setSpeaker(bool v) async {}
  @override
  Future<void> stop() async {
    stopCount++;
  }

  @override
  Future<void> disconnect() async {
    stopCount++;
  }
}
