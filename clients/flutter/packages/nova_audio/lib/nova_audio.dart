import 'dart:typed_data';

abstract interface class AudioPort {
  Stream<Map<String, Object?>> get events;
  Future<Map<String, Object?>> capabilities();
  Future<void> startRelay({
    required int generation,
    required bool capture,
    required double threshold,
  });
  Future<void> enqueue(Uint8List frame);
  Future<void> terminal(String utteranceId, int epoch);
  Future<void> clear(String utteranceId, int epoch);
  Future<void> mute(bool muted);
  Future<void> setSpeaker(bool enabled);
  Future<void> stop();
  Future<void> disconnect();
}
