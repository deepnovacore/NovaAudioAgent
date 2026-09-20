import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:nova_audio/nova_audio.dart';
import '../protocol/wire.dart';
import '../protocol/request_id.dart';
import 'recovery.dart';
import 'package:nova_audio/aoq_port.dart';
import '../protocol/aoq_bridge.dart';
import 'transport.dart';

final class Session extends ChangeNotifier {
  Session({
    required this.audio,
    required this.requestMicrophone,
    this.openTransport = SocketTransport.open,
    int Function()? clock,
  }) {
    final watch = Stopwatch()..start();
    nowMs = clock ?? () => watch.elapsedMilliseconds;
    _audioSubscription = audio.events.listen(
      _onAudio,
      onError: (_) {
        unawaited(_fail(generation, 0, 'Audio device failed'));
      },
    );
  }
  final AudioPort audio;
  final Future<bool> Function() requestMicrophone;
  final Future<TransportPort> Function(Uri) openTransport;
  late final int Function() nowMs;
  final _host = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  Stream<Map<String, dynamic>> get hostEvents => _host.stream;
  final _resets = StreamController<void>.broadcast(sync: true);
  Stream<void> get resets => _resets.stream;
  late final StreamSubscription<Map<String, Object?>> _audioSubscription;
  StreamSubscription<void>? _subscription;
  TransportPort? _transport;
  final _queue = Queue<_Packet>();
  int _queuedBytes = 0;
  bool _sending = false, _requested = false, _disposed = false;
  Timer? _watchdog, _retry;
  Recovery _recovery = Recovery();
  Uri? _endpoint;
  String _token = '';
  int generation = 0;
  int _captureRevision = 0;
  bool connected = false,
      connecting = false,
      voice = false,
      voiceStarting = false;
  bool muted = false, speaker = false, foreground = true;
  double inputLevel = 0, speechThreshold = 0.045;
  String status = 'Not connected', language = 'en', mediaPreference = 'auto';
  Ready? ready;
  bool _offeredAOQ = false;
  String? _aoqRequest;
  AOQRuntimeBridge? _aoqBridge;
  bool get editableInput => ready?.editableInput ?? false;
  String? get connection => ready?.connection;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> connect(Uri endpoint, String token) async {
    await end();
    if (_disposed) return;
    _endpoint = Wire.endpoint(endpoint.toString(), debugLocalhost: kDebugMode);
    if (!RegExp(r'^[0-9a-f]{32}$').hasMatch(token)) {
      status = 'Enter the connection token';
      _notify();
      return;
    }
    _token = token;
    _recovery = Recovery();
    _requested = true;
    await _open();
  }

  Future<void> _open() async {
    if (!_requested || _endpoint == null || _disposed) return;
    final id = ++generation;
    connecting = true;
    status = 'Connecting';
    _notify();
    _watchdog = Timer(
      const Duration(seconds: 10),
      () => unawaited(_fail(id, 0, 'Handshake timed out')),
    );
    try {
      final transport = await openTransport(_endpoint!);
      if (generation != id || !_requested) {
        await transport.close();
        return;
      }
      _transport = transport;
      _subscription = transport.incoming
          .asyncMap((m) => receive(m, id))
          .listen(
            (_) {},
            onError: (_) => unawaited(
              _fail(id, transport.closeCode ?? 1006, 'Connection interrupted'),
            ),
            onDone: () => unawaited(
              _fail(id, transport.closeCode ?? 1006, 'Connection closed'),
            ),
          );
      _offeredAOQ =
          audio is AoqPort &&
          (await audio.capabilities())['aoq'] == true &&
          mediaPreference != 'relay';
      if (id != generation || !_requested) return;
      if (mediaPreference == 'aoq' && !_offeredAOQ) {
        await _fail(id, 4006, 'This build does not include AOQ');
        return;
      }
      await transport
          .send(
            jsonEncode({
              'type': 'hello',
              'token': _token,
              'protocol_version': 1,
              'language': language == 'zh' ? 'zh-CN' : language,
              'media': {
                'transports': [
                  if (mediaPreference != 'aoq') 'host_pcm_v1',
                  if (_offeredAOQ) ...[
                    'qwen_aoq_runtime_v1',
                    'qwen_aoq_chat_v1',
                  ],
                ],
              },
            }),
          )
          .timeout(const Duration(seconds: 5));
    } catch (_) {
      await _fail(id, 1006, 'Could not connect');
    }
  }

  Future<void> receive(Object message, int id) async {
    if (id != generation || _disposed) return;
    try {
      if (ready == null) {
        if (message is! String) {
          throw const FormatException('Expected client.ready');
        }
        ready = Wire.ready(
          Wire.json(Uint8List.fromList(utf8.encode(message))),
          allowAOQ: _offeredAOQ,
          allowAOQRuntime: _offeredAOQ,
        );
        if (ready!.aoqChat && _transport is SocketTransport) {
          (_transport as SocketTransport).monitorHeartbeat();
        }
        if (ready!.aoqRuntime) _aoqBridge = AOQRuntimeBridge(ready!.connection);
        _watchdog?.cancel();
        _watchdog = null;
        _recovery.markReady(nowMs());
        connected = true;
        connecting = false;
        status = 'Connected';
        _notify();
        return;
      }
      if (message is List<int>) {
        if (ready!.aoqChat) {
          throw const FormatException(
            "AOQ control connection cannot carry PCM",
          );
        }
        final bytes = Uint8List.fromList(message);
        Wire.audio(bytes);
        await audio.enqueue(bytes);
        return;
      }
      if (message is! String) throw const FormatException('Unsupported frame');
      final value = Wire.json(
        Uint8List.fromList(utf8.encode(message)),
        limit: ready!.aoqRuntime ? 131072 : 16384,
      );
      switch (value['type']) {
        case 'aoq.credentials':
          if (!ready!.aoqChat ||
              !voiceStarting ||
              _aoqRequest == null ||
              value['request_id'] != _aoqRequest ||
              value['connection_id'] != connection ||
              (ready!.aoqRuntime &&
                  (value['mode'] != 'runtime' || value['session'] != null))) {
            throw const FormatException('Stale AOQ credentials');
          }
          _aoqRequest = null;
          await audio.stop();
          if (id != generation || !voiceStarting || !foreground) return;
          await (audio as AoqPort).startAoq(
            value,
            generation: id,
            runtime: ready!.aoqRuntime,
          );
        case 'aoq.command':
          if (_aoqBridge == null || audio is! AoqPort) {
            throw const FormatException('Unexpected AOQ command');
          }
          await (audio as AoqPort).aoqCommand(_aoqBridge!.command(value));
        case 'aoq.error':
          await end();
          status = 'AOQ unavailable. Check host configuration.';
          _notify();
        case 'playback.alert':
          status = 'Playback interrupted';
          _notify();
        case 'playback.clear':
          final identity = Wire.identity(value);
          if (ready?.aoqRuntime == true) {
            await (audio as AoqPort).aoqClear();
          } else {
            await audio.clear(identity.utteranceId, identity.epoch);
          }
        case 'playback.terminal':
          final identity = Wire.identity(value);
          if (ready?.aoqRuntime != true) {
            await audio.terminal(identity.utteranceId, identity.epoch);
          }
        case 'clock.ping':
          command({
            'type': 'clock.pong',
            'ping_id': Wire.identifier(value['ping_id']),
            't_render_ms': nowMs(),
          });
        default:
          _host.add(value);
      }
    } catch (error) {
      await _fail(
        id,
        ready == null ? 4006 : 1002,
        error is FormatException
            ? 'Incompatible host data'
            : 'Audio playback failed',
      );
    }
  }

  String? command(Map<String, dynamic> payload) {
    if (!connected || connection == null) return null;
    final id = requestId();
    unawaited(
      sendRaw(
        jsonEncode({
          'type': 'client.command',
          'request_id': id,
          'connection_id': connection,
          'payload': payload,
        }),
      ),
    );
    return id;
  }

  Future<void> sendRaw(Object message) async {
    if (!connected || _transport == null) return;
    final count = message is String
        ? utf8.encode(message).length
        : (message as List<int>).length;
    if (_queuedBytes + count > 131072 || _queue.length >= 128) {
      await _fail(generation, 0, 'Network backlog; reconnecting');
      return;
    }
    _queue.add(_Packet(message, count));
    _queuedBytes += count;
    if (_sending) return;
    _sending = true;
    final id = generation;
    try {
      while (_queue.isNotEmpty && generation == id && connected) {
        final packet = _queue.first;
        await _transport!
            .send(packet.message)
            .timeout(const Duration(seconds: 5));
        if (id != generation) return;
        _queue.removeFirst();
        _queuedBytes -= packet.bytes;
      }
    } catch (_) {
      await _fail(id, 1006, 'Upload interrupted');
    } finally {
      if (id == generation) _sending = false;
    }
  }

  Future<bool> startCapture({
    required bool capture,
    bool Function()? beforeStart,
  }) async {
    if (!connected || !foreground || _disposed) return false;
    final id = generation;
    final captureRevision = ++_captureRevision;
    if (capture) {
      final granted = await requestMicrophone();
      if (id != generation ||
          captureRevision != _captureRevision ||
          !connected ||
          !foreground) {
        return false;
      }
      if (!granted) {
        status = 'Microphone permission denied';
        _notify();
        return false;
      }
    }
    if (beforeStart != null && !beforeStart()) return false;
    if (id != generation ||
        captureRevision != _captureRevision ||
        !connected ||
        !foreground) {
      return false;
    }
    try {
      await audio.startRelay(
        generation: id,
        capture: capture,
        threshold: speechThreshold,
      );
      return id == generation &&
          captureRevision == _captureRevision &&
          connected &&
          foreground;
    } catch (e) {
      if (id == generation) {
        await audio.stop();
        status = 'Audio startup failed: $e';
        _notify();
      }
      return false;
    }
  }

  Future<void> startVoice() async {
    if (!connected || voice || voiceStarting || !foreground) return;
    voiceStarting = true;
    _notify();
    final id = generation;
    if (ready?.aoqChat == true) {
      final revision = ++_captureRevision;
      final granted = await requestMicrophone();
      if (id != generation ||
          revision != _captureRevision ||
          !connected ||
          !foreground) {
        return;
      }
      if (!granted) {
        voiceStarting = false;
        status = 'Microphone permission denied';
        _notify();
        return;
      }
      await audio.stop();
      if (id != generation ||
          revision != _captureRevision ||
          !connected ||
          !foreground) {
        return;
      }
      _aoqRequest = requestId();
      await sendRaw(
        jsonEncode({
          'type': 'aoq.connect',
          'request_id': _aoqRequest,
          'connection_id': connection,
        }),
      );
      _watchdog = Timer(const Duration(seconds: 25), () {
        if (id == generation && voiceStarting) {
          unawaited(_fail(id, 0, 'AOQ startup timed out'));
        }
      });
      status = 'Connecting AOQ';
      _notify();
      return;
    }
    if (editableInput) command({'type': 'input.audio'});
    final started = await startCapture(capture: true);
    if (id != generation) return;
    voiceStarting = false;
    voice = started;
    muted = false;
    speaker = false;
    if (started) status = 'Listening';
    _notify();
  }

  Future<void> stopCapture() async {
    _captureRevision++;
    voice = false;
    voiceStarting = false;
    await audio.stop();
    inputLevel = 0;
    _notify();
  }

  Future<void> toggleMute() async {
    if (!voice) return;
    final id = generation, next = !muted;
    try {
      await audio.mute(next);
      if (id == generation) {
        muted = next;
        inputLevel = 0;
        _notify();
      }
    } catch (_) {
      await _fail(id, 0, 'Could not change microphone state');
    }
  }

  Future<void> toggleSpeaker() async {
    if (!voice) return;
    final id = generation, next = !speaker;
    try {
      await audio.setSpeaker(next);
      if (id == generation) {
        speaker = next;
        _notify();
      }
    } catch (_) {
      await _fail(id, 0, 'Could not change audio route');
    }
  }

  void _onAudio(Map<String, Object?> event) {
    if (event['generation'] != generation || !connected || _disposed) return;
    switch (event['kind']) {
      case 'aoq_ready':
        if (!voiceStarting || ready?.aoqChat != true) return;
        _watchdog?.cancel();
        _watchdog = null;
        voiceStarting = false;
        voice = true;
        status = 'Listening';
        _notify();
      case 'aoq_caption':
        _host.add({
          'type': 'aoq_caption',
          'role': event['role'],
          'text': event['text'],
        });
      case 'aoq_event':
        try {
          final value = event['event'] is Map
              ? Map<String, dynamic>.from(event['event'] as Map)
              : Wire.json(
                  Uint8List.fromList(utf8.encode(event['json'] as String)),
                  limit: 65536,
                );
          final envelope = _aoqBridge?.envelope(value);
          if (envelope != null) unawaited(sendRaw(jsonEncode(envelope)));
        } catch (_) {
          unawaited(_fail(generation, 0, 'Invalid AOQ event'));
        }
      case 'pcm':
        final pcm = event['pcm'];
        if (pcm is Uint8List) unawaited(sendRaw(pcm));
      case 'level':
        final level = event['level'];
        if (level is num && level.isFinite) {
          inputLevel = muted ? 0 : level.toDouble().clamp(0, 1);
          _notify();
        }
      case 'control':
        final control = event['control'];
        if (control is Map && (control['type'] != 'speech.onset' || voice)) {
          command(Map<String, dynamic>.from(control));
        }
      case 'stopped':
        unawaited(
          end().then((_) {
            status = 'Audio stopped. Reconnect to resume.';
            _notify();
          }),
        );
    }
  }

  Future<void> _reset() async {
    _captureRevision++;
    generation++;
    connected = false;
    connecting = false;
    ready = null;
    _aoqRequest = null;
    _aoqBridge = null;
    _offeredAOQ = false;
    voice = false;
    voiceStarting = false;
    muted = false;
    inputLevel = 0;
    _watchdog?.cancel();
    _watchdog = null;
    final subscription = _subscription;
    _subscription = null;
    final transport = _transport;
    _transport = null;
    _queue.clear();
    _queuedBytes = 0;
    _sending = false;
    if (!_resets.isClosed) _resets.add(null);
    unawaited(subscription?.cancel());
    if (transport != null) unawaited(transport.close().catchError((_) {}));
    await audio.disconnect();
  }

  Future<void> _fail(int id, int code, String reason) async {
    if (id != generation || _disposed) return;
    final resetGeneration = generation + 1;
    await _reset();
    if (generation != resetGeneration || _disposed) return;
    if ([4003, 4006, 4009].contains(code)) {
      _requested = false;
      status = {
        4003: 'Connection token rejected',
        4006: 'Incompatible host or media configuration',
        4009: 'Another device is active',
      }[code]!;
    } else if (_requested) {
      final delay = _recovery.nextDelay(nowMs());
      if (delay != null) {
        connecting = true;
        status = reason;
        _retry = Timer(delay, () => unawaited(_open()));
      } else {
        _requested = false;
        status = 'Connection recovery exhausted. Reconnect to retry.';
      }
    } else {
      status = reason;
    }
    _notify();
  }

  Future<void> rejectHostData() =>
      _fail(generation, 4006, 'Incompatible host data');

  Future<void> end() async {
    _requested = false;
    _retry?.cancel();
    _retry = null;
    await _reset();
    status = 'Disconnected';
    _notify();
  }

  Future<void> background() async {
    foreground = false;
    await end();
  }

  void resumeForeground() {
    foreground = true;
    _notify();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    unawaited(end());
    unawaited(_audioSubscription.cancel());
    unawaited(_host.close());
    unawaited(_resets.close());
    super.dispose();
  }
}

final class _Packet {
  const _Packet(this.message, this.bytes);
  final Object message;
  final int bytes;
}
