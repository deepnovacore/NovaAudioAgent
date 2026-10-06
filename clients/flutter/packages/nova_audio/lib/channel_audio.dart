import 'dart:async';
import 'dart:typed_data';
import 'package:flutter/services.dart';
import 'nova_audio.dart';
import 'aoq_port.dart';

/// One instance owns platform audio for the application lifetime.
final class ChannelAudio implements AudioPort, AoqPort {
  ChannelAudio() {
    _control.setMethodCallHandler((call) async {
      if (call.method == 'event' && call.arguments is Map) {
        final value = Map<String, Object?>.from(call.arguments as Map);
        if (value['generation'] == _generation) _events.add(value);
      }
    });
    _pcm.setMessageHandler((data) async {
      if (data == null || data.lengthInBytes < 8) {
        return Uint8List.fromList([0]).buffer.asByteData();
      }
      final generation = data.getInt64(0, Endian.big);
      if (generation != _generation) {
        return Uint8List.fromList([0]).buffer.asByteData();
      }
      final bytes = data.buffer.asUint8List(
        data.offsetInBytes + 8,
        data.lengthInBytes - 8,
      );
      _events.add({
        'kind': 'pcm',
        'generation': generation,
        'pcm': Uint8List.fromList(bytes),
      });
      // Acknowledgement means handoff, never network delivery or heard audio.
      return Uint8List.fromList([1]).buffer.asByteData();
    });
  }
  static const _control = MethodChannel('nova/audio');
  static const _pcm = BasicMessageChannel<ByteData>(
    'nova/audio/pcm',
    BinaryCodec(),
  );
  final _events = StreamController<Map<String, Object?>>.broadcast(sync: true);
  int? _generation;
  @override
  Stream<Map<String, Object?>> get events => _events.stream;
  Future<bool> requestMicrophone() async =>
      await _control.invokeMethod<bool>('requestMicrophone') ?? false;
  @override
  Future<Map<String, Object?>> capabilities() async =>
      Map<String, Object?>.from(
        await _control.invokeMapMethod<String, Object?>('capabilities') ?? {},
      );
  @override
  Future<void> startRelay({
    required int generation,
    required bool capture,
    required double threshold,
  }) async {
    _generation = generation;
    try {
      await _control.invokeMethod<void>('startRelay', {
        'generation': generation,
        'capture': capture,
        'threshold': threshold,
      });
    } catch (_) {
      if (_generation == generation) _generation = null;
      rethrow;
    }
  }

  @override
  Future<void> startAoq(
    Map<String, Object?> payload, {
    required int generation,
    required bool runtime,
  }) async {
    _generation = generation;
    try {
      await _control.invokeMethod<void>('startAoq', {
        'generation': generation,
        'runtime': runtime,
        'payload': payload,
      });
    } catch (_) {
      if (_generation == generation) _generation = null;
      rethrow;
    }
  }

  @override
  Future<void> aoqCommand(Map<String, dynamic> event) =>
      _call('aoqCommand', {'event': event});
  @override
  Future<void> aoqClear() => _call('aoqClear');
  Future<void> _call(String name, [Map<String, Object?> args = const {}]) =>
      _control.invokeMethod<void>(name, {'generation': _generation, ...args});
  @override
  Future<void> enqueue(Uint8List frame) => _call('enqueue', {'frame': frame});
  @override
  Future<void> terminal(String utteranceId, int epoch) => _call('terminal', {
    'utterance_id': utteranceId,
    'generation_epoch': epoch,
  });
  @override
  Future<void> clear(String utteranceId, int epoch) =>
      _call('clear', {'utterance_id': utteranceId, 'generation_epoch': epoch});
  @override
  Future<void> mute(bool muted) => _call('mute', {'muted': muted});
  @override
  Future<void> setSpeaker(bool enabled) =>
      _call('speaker', {'enabled': enabled});
  @override
  Future<void> stop() async {
    try {
      await _call('stop');
    } finally {
      _generation = null;
    }
  }

  @override
  Future<void> disconnect() async {
    try {
      await _call('disconnect');
    } finally {
      _generation = null;
    }
  }
}
