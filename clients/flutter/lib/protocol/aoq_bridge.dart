import 'dart:convert';
import 'wire.dart';

int _size(Map<String, dynamic> value) {
  try {
    return utf8.encode(jsonEncode(value)).length;
  } catch (_) {
    throw const FormatException('Invalid AOQ JSON');
  }
}

final class AOQRuntimeBridge {
  AOQRuntimeBridge(this.connection);
  final String connection;
  int _commandSequence = 0, _eventSequence = 0;
  static const _commands = {
    'session.update',
    'conversation.item.create',
    'conversation.item.delete',
    'conversation.item.truncate',
    'input_audio_buffer.clear',
    'response.create',
    'response.cancel',
  };
  Map<String, dynamic> command(Map<String, dynamic> value) {
    final e = value['event'];
    if (value.length != 4 ||
        value['type'] != 'aoq.command' ||
        value['connection_id'] != connection ||
        Wire.integer(value['sequence'], min: 1) != _commandSequence + 1 ||
        e is! Map<String, dynamic> ||
        !_commands.contains(e['type']) ||
        _size(e) > 65536) {
      throw const FormatException('Invalid AOQ command');
    }
    _commandSequence++;
    return e;
  }

  Map<String, dynamic>? envelope(Map<String, dynamic> event) {
    if (event['type'] is! String) {
      throw const FormatException('Invalid AOQ event');
    }
    if ([
      'response.audio.delta',
      'response.output_audio.delta',
      'input_audio_buffer.append',
    ].contains(event['type'])) {
      return null;
    }
    if (_size(event) > 65536) {
      throw const FormatException('AOQ event too large');
    }
    final value = <String, dynamic>{
      'type': 'aoq.event',
      'connection_id': connection,
      'sequence': _eventSequence + 1,
      'event': event,
    };
    if (_size(value) > 131072) {
      throw const FormatException('AOQ envelope too large');
    }
    _eventSequence++;
    return value;
  }
}

final class AOQPendingCommands {
  final _values = <Map<String, dynamic>>[];
  int _bytes = 0;
  void append(Map<String, dynamic> event) {
    final count = _size(event);
    if (_bytes + count > 262144) {
      throw const FormatException('AOQ command backlog');
    }
    _values.add(jsonDecode(jsonEncode(event)) as Map<String, dynamic>);
    _bytes += count;
  }

  List<Map<String, dynamic>> drain() {
    final result = List<Map<String, dynamic>>.of(_values);
    _values.clear();
    _bytes = 0;
    return result;
  }
}
