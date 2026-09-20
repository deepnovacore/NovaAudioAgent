import 'dart:async';
import 'package:flutter/foundation.dart';
import '../protocol/request_id.dart';

final class InputState extends ChangeNotifier {
  InputState({
    required this.command,
    required this.start,
    required this.stop,
    required this.allowed,
    this.prepareDictation,
  });
  final String? Function(Map<String, dynamic>) command;
  final Future<bool> Function(bool) start;
  final Future<bool> Function(bool Function())? prepareDictation;
  final Future<void> Function() stop;
  final bool Function() allowed;
  String draft = '', notice = '';
  bool sending = false,
      holding = false,
      recording = false,
      transcribing = false;
  String? _dictation, _request;
  String _base = '', _sent = '';
  final _dictationCommands = <String>{};
  Timer? _dictationTimer, _textTimer;
  bool _disposed = false;
  bool get busy => sending || holding || recording || transcribing;
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> sendDraft() async {
    final text = draft.trim();
    if (!allowed() || busy || text.isEmpty || text.length > 4000) return;
    sending = true;
    _notify();
    if (!await start(false) || !allowed() || _disposed || !sending) {
      sending = false;
      _notify();
      return;
    }
    final id = command({'type': 'input.text', 'text': text});
    if (id == null) {
      sending = false;
      _notify();
      return;
    }
    _request = id;
    _sent = text;
    notice = '';
    _textTimer = Timer(const Duration(seconds: 15), () {
      if (_request != id) return;
      _request = null;
      sending = false;
      notice =
          'No acknowledgement. Check the conversation before sending again. Draft preserved.';
      _notify();
    });
    _notify();
  }

  Future<void> beginDictation() async {
    if (!allowed() || busy) return;
    holding = true;
    final id = requestId();
    _dictation = id;
    _base = draft;
    notice = '';
    _notify();
    bool announce() {
      if (_disposed || _dictation != id || !holding || !allowed()) return false;
      final request = command({
        'type': 'input.dictation',
        'id': id,
        'action': 'start',
      });
      if (request == null) return false;
      _dictationCommands.add(request);
      return true;
    }

    final started = prepareDictation != null
        ? await prepareDictation!(announce)
        : (announce() && await start(true));
    if (_disposed || _dictation != id || !holding || !allowed()) return;
    if (!started) {
      await cancelDictation();
      notice = 'Unable to start microphone';
      _notify();
      return;
    }
    recording = true;
    _dictationTimer = Timer(
      const Duration(seconds: 45),
      () => unawaited(finishDictation()),
    );
    _notify();
  }

  Future<void> finishDictation() async {
    holding = false;
    final id = _dictation;
    if (!recording || id == null) {
      await cancelDictation();
      return;
    }
    recording = false;
    transcribing = true;
    _dictationTimer?.cancel();
    await stop();
    if (_dictation != id || _disposed) return;
    final request = command({
      'type': 'input.dictation',
      'id': id,
      'action': 'finish',
    });
    if (request != null) _dictationCommands.add(request);
    _dictationTimer = Timer(const Duration(seconds: 35), () {
      unawaited(cancelDictation());
      notice = 'Transcription timed out. Draft preserved.';
      _notify();
    });
    _notify();
  }

  Future<void> cancelDictation() async {
    final id = _dictation;
    final active = holding || recording;
    _dictation = null;
    holding = recording = transcribing = false;
    _dictationTimer?.cancel();
    _dictationCommands.clear();
    if (id != null) {
      command({'type': 'input.dictation', 'id': id, 'action': 'cancel'});
    }
    if (active) await stop();
    _notify();
  }

  void receive(Map<String, dynamic> value) {
    if (value['type'] == 'input.transcription' &&
        transcribing &&
        value['id'] == _dictation) {
      final text = value['text'];
      if (text is String && text.trim().isNotEmpty && text.length <= 4000) {
        draft = _base.isEmpty ? text : '$_base\n$text';
        notice = 'Edit before sending';
      } else {
        notice = 'No transcription. Draft preserved.';
      }
      unawaited(cancelDictation());
    }
    if (value['type'] == 'client.command_result') {
      final id = value['request_id'];
      if (_dictationCommands.remove(id) && value['status'] != 'applied') {
        unawaited(cancelDictation());
        notice = 'Host rejected transcription';
      }
      if (_request != null && _request == id) {
        _textTimer?.cancel();
        _request = null;
        sending = false;
        if (value['status'] == 'applied') {
          if (draft.trim() == _sent) draft = '';
        } else {
          notice = 'Message not accepted. Draft preserved.';
        }
      }
    }
    _notify();
  }

  void reset() {
    _dictation = null;
    holding = recording = transcribing = sending = false;
    _request = null;
    _dictationCommands.clear();
    _dictationTimer?.cancel();
    _textTimer?.cancel();
    _notify();
  }

  @override
  void dispose() {
    _disposed = true;
    _dictationTimer?.cancel();
    _textTimer?.cancel();
    super.dispose();
  }
}
