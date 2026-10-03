import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'models.dart';
export 'models.dart';

abstract final class Wire {
  static const maxPCM = 65536, maxJSON = 16384, maxHeader = 2048;
  static const maxInteger = 9007199254740991;
  static final _uuid = RegExp(
    r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  );
  static Uri endpoint(String text, {bool debugLocalhost = false}) {
    final u = Uri.tryParse(text);
    if (u == null ||
        u.host.isEmpty ||
        u.userInfo.isNotEmpty ||
        u.hasQuery ||
        u.hasFragment ||
        !['', '/', '/client/v1'].contains(u.path)) {
      throw const FormatException(
        'Enter a server URL without credentials or query parameters.',
      );
    }
    final local =
        kDebugMode &&
        debugLocalhost &&
        u.scheme == 'ws' &&
        ['localhost', '127.0.0.1', '::1'].contains(u.host);
    if (u.scheme != 'wss' && !local) {
      throw const FormatException('A secure wss:// server is required.');
    }
    return u.replace(path: '/client/v1');
  }

  static Map<String, dynamic> json(Uint8List data, {int limit = maxJSON}) {
    if (data.length > limit) throw const FormatException('Oversized JSON');
    final text = utf8.decode(data);
    final value = jsonDecode(text);
    if (value is! Map<String, dynamic>) {
      throw const FormatException('Expected JSON object');
    }
    // Preserve root-member lexical integer validation, including last duplicate
    // member wins and escaped keys. Nested payload schemas validate themselves.
    final tokens = RegExp(
      r'"(?:\\.|[^"\\])*"|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null|[{}\[\]:,]',
    ).allMatches(text).map((m) => m.group(0)!).toList();
    const checked = {
      'generation_epoch',
      'sequence',
      'protocol_version',
      'played_ms',
    };
    final sources = <String, String>{};
    var depth = 0;
    for (var i = 0; i < tokens.length; i++) {
      final t = tokens[i];
      if (depth == 1 &&
          t.startsWith('"') &&
          i + 2 < tokens.length &&
          tokens[i + 1] == ':') {
        final key = jsonDecode(t);
        if (key is String && checked.contains(key)) {
          sources[key] = tokens[i + 2];
        }
      }
      if (t == '{' || t == '[') depth++;
      if (t == '}' || t == ']') depth--;
    }
    for (final s in sources.values) {
      if (s == 'null') continue;
      final n = int.tryParse(s);
      if (n == null || n < 0 || n > maxInteger || '$n' != s) {
        throw const FormatException('Invalid integer token');
      }
    }
    return value;
  }

  static String identifier(Object? value) {
    if (value is! String || value.trim().isEmpty || value.runes.length > 256) {
      throw const FormatException('Invalid identity');
    }
    return value;
  }

  static int integer(Object? value, {int min = 0}) {
    if (value is! int || value < min || value > maxInteger) {
      throw const FormatException('Invalid integer');
    }
    return value;
  }

  static PlaybackIdentity identity(Map<String, dynamic> value) =>
      PlaybackIdentity(
        identifier(value['utterance_id']),
        integer(value['generation_epoch'], min: 1),
      );
  static AudioFrame audio(Uint8List bytes) {
    if (bytes.length < 8 ||
        bytes.length > 6 + maxHeader + maxPCM ||
        bytes[0] != 78 ||
        bytes[1] != 79 ||
        bytes[2] != 86 ||
        bytes[3] != 65) {
      throw const FormatException('Invalid NOVA frame');
    }
    final size = ByteData.sublistView(bytes).getUint16(4, Endian.big);
    if (size < 2 || size > maxHeader || 6 + size >= bytes.length) {
      throw const FormatException('Invalid audio header length');
    }
    final header = json(
      Uint8List.sublistView(bytes, 6, 6 + size),
      limit: maxHeader,
    );
    final pcm = Uint8List.sublistView(bytes, 6 + size);
    if (pcm.length > maxPCM || pcm.length.isOdd) {
      throw const FormatException('Invalid PCM16 length');
    }
    return AudioFrame(identity(header), integer(header['sequence']), pcm);
  }

  static Ready ready(
    Map<String, dynamic> value, {
    bool allowAOQ = false,
    bool allowAOQRuntime = false,
  }) {
    final caps = value['capabilities'];
    final instance = value['server_instance_id'],
        connection = value['connection_id'];
    if (value['type'] != 'client.ready' ||
        integer(value['protocol_version']) != 1 ||
        instance is! String ||
        !_uuid.hasMatch(instance) ||
        connection is! String ||
        !_uuid.hasMatch(connection) ||
        caps is! List ||
        caps.any((c) => c is! String)) {
      throw const FormatException('Incompatible server handshake');
    }
    final capabilities = caps.cast<String>().toSet();
    if (!capabilities.containsAll(['audio', 'captions'])) {
      throw const FormatException('Missing capabilities');
    }
    for (final entry in {'input_audio': 16000, 'output_audio': 24000}.entries) {
      final f = value[entry.key];
      if (f is! Map ||
          f['encoding'] != 'pcm_s16le' ||
          integer(f['sample_rate']) != entry.value ||
          integer(f['channels']) != 1) {
        throw const FormatException('Unsupported audio format');
      }
    }
    String? pipeline;
    var aoqChat = false, aoqRuntime = false;
    if (value.containsKey('media')) {
      final m = value['media'];
      if (m is! Map || !['integrated', 'cascaded'].contains(m['pipeline'])) {
        throw const FormatException('Unsupported media pipeline');
      }
      pipeline = m['pipeline'] as String;
      if (m['transport'] == 'qwen_aoq_chat_v1') {
        if (!allowAOQ ||
            pipeline != 'integrated' ||
            m['path'] != 'direct' ||
            m['audio_owner'] != 'aoq_sdk' ||
            m['mode'] != 'chat_only' ||
            capabilities.contains('executor') ||
            capabilities.contains('projects')) {
          throw const FormatException('Incompatible AOQ chat handshake');
        }
        aoqChat = true;
      } else if (m['transport'] == 'qwen_aoq_runtime_v1') {
        if (!allowAOQRuntime ||
            pipeline != 'integrated' ||
            m['path'] != 'direct' ||
            m['audio_owner'] != 'aoq_sdk' ||
            m['mode'] != 'runtime' ||
            !capabilities.containsAll(['projects', 'executor'])) {
          throw const FormatException('Incompatible AOQ runtime handshake');
        }
        aoqChat = true;
        aoqRuntime = true;
      } else if (m['transport'] != 'host_pcm_v1' ||
          m['path'] != 'relay' ||
          m['audio_owner'] != 'client') {
        throw const FormatException('Unsupported media transport');
      }
    }
    if (!aoqChat && !capabilities.containsAll(['projects', 'executor'])) {
      throw const FormatException('Missing host capabilities');
    }
    return Ready(
      instance: instance,
      connection: connection,
      pipeline: pipeline,
      editableInput:
          pipeline == 'cascaded' &&
          capabilities.containsAll(['text_input', 'dictation']),
      personal: capabilities.contains('personal'),
      aoqChat: aoqChat,
      aoqRuntime: aoqRuntime,
    );
  }
}
