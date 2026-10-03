import 'dart:async';
import 'package:flutter/foundation.dart';
import '../connection/session.dart';
import 'conversation_state.dart';
import 'input_state.dart';
import 'approvals.dart';

final class ConversationController extends ChangeNotifier {
  ConversationController(this.session) {
    session.addListener(notifyListeners);
    session.personal.addListener(_personalChanged);
    _events = session.hostEvents.listen((value) {
      try {
        receive(value);
      } catch (_) {
        unawaited(session.rejectHostData());
      }
    });
    _resets = session.resets.listen((_) {
      for (final state in _inputs.values.toList()) {
        state.reset();
      }
      approvals.clear();
      _sequence = -1;
      notifyListeners();
    });
  }
  final Session session;
  final _inputs = <String?, InputState>{};
  InputState get input =>
      _inputs.putIfAbsent(_selected, () => _createInput(_selected));
  InputState _createInput(String? conversation) {
    final state = InputState(
      command: session.command,
      conversationId: () => conversation,
      semanticReceipts: () => session.ready?.personal == true,
      start: (capture) => session.startCapture(capture: capture),
      stop: session.stopCapture,
      prepareDictation: (announce) =>
          session.startCapture(capture: true, beforeStart: announce),
      allowed: () =>
          _selected == conversation &&
          session.connected &&
          session.editableInput &&
          !session.voice &&
          !session.voiceStarting &&
          session.foreground,
    );
    state.addListener(notifyListeners);
    return state;
  }

  final transcript = ConversationState();
  final approvals = Approvals();
  final tasks = <String, String>{}, results = <String, String>{};
  late final StreamSubscription<Map<String, dynamic>> _events;
  late final StreamSubscription<void> _resets;
  int _sequence = -1;
  String? _selected;
  Object? _snapshot;
  void _personalChanged() {
    final snapshot = session.personal.snapshot;
    if (snapshot == null) {
      _snapshot = null;
      _selected = null;
      _sequence = -1;
      for (final state in _inputs.values) {
        state.dispose();
      }
      _inputs.clear();
      transcript.clear();
      approvals.clear();
      tasks.clear();
      results.clear();
      notifyListeners();
      return;
    }
    if (identical(snapshot, _snapshot)) return;
    _snapshot = snapshot;
    if (_selected != snapshot.selectedId) {
      unawaited(input.cancelDictation());
      if (session.voice || session.voiceStarting) {
        unawaited(session.stopCapture());
      }
      _selected = snapshot.selectedId;
      _sequence = -1;
    }
    transcript.clear();
    for (final row
        in snapshot.object('conversations')['messages'] as List? ?? []) {
      if (row is Map &&
          row['conversation_id'] == _selected &&
          row['role'] is String &&
          row['text'] is String) {
        transcript.receive(
          role: row['role'],
          text: row['text'],
          finalText: true,
          id: row['id'] as String?,
        );
      }
    }
    notifyListeners();
  }

  void receive(Map<String, dynamic> value) {
    final conversation = value['conversation_id'];
    if (conversation is String &&
        session.ready?.personal == true &&
        conversation != session.personal.snapshot?.selectedId &&
        [
          'caption',
          'conversation.completed',
          'conversation.generated',
          'conversation.delivered',
        ].contains(value['type'])) {
      return;
    }
    for (final state in _inputs.values.toList()) {
      state.receive(value);
    }
    approvals.receive(value);
    switch (value['type']) {
      case 'aoq_caption':
        if (value['role'] is String && value['text'] is String) {
          transcript.receive(
            role: value['role'],
            text: value['text'],
            finalText: value['role'] == 'user',
          );
        }
      case 'caption':
        final sequence = value['sequence'];
        if (sequence is int &&
            sequence > _sequence &&
            value['role'] is String &&
            value['text'] is String) {
          _sequence = sequence;
          transcript.receive(
            role: value['role'],
            text: value['full_text'] as String? ?? value['text'],
            finalText: value['final'] == true,
            id: value['message_id'] as String?,
          );
        }
      case 'executor.state':
        if (value['executor'] is String) {
          tasks[value['executor']] = value['state'] as String? ?? 'Unknown';
        }
      case 'executor.progress':
        if (value['delegate_id'] is String) {
          tasks[value['delegate_id']] = [
            value['phase'],
            value['summary'],
          ].whereType<String>().join(' · ');
        }
      case 'executor.results.reset':
        results.clear();
      case 'executor.result':
        final id = value['work_id'];
        if (id is String) {
          final result = value['result'];
          if (result is Map) {
            results[id] = [
              result['project'],
              result['title'],
              result['outcome'],
              result['summary'],
            ].whereType<String>().join(' · ');
          } else {
            results.remove(id);
          }
        }
    }
    while (tasks.length > 64) {
      tasks.remove(tasks.keys.first);
    }
    while (results.length > 32) {
      results.remove(results.keys.first);
    }
    notifyListeners();
  }

  bool decide(ApprovalCard card, String decision) {
    if (!session.connected) return false;
    final payload = approvals.decide(card, decision);
    if (payload == null) return false;
    final sent = session.command(payload) != null;
    if (!sent) approvals.submitted.remove(card.id);
    notifyListeners();
    return sent;
  }

  Future<void> switchToText() async {
    if (session.ready?.aoqChat == true &&
        (session.voice || session.voiceStarting)) {
      await session.end();
    } else {
      await session.stopCapture();
    }
  }

  Future<void> switchToVoice() => input.cancelDictation();
  Future<void> startVoice() async {
    if (!input.busy) await session.startVoice();
  }

  @override
  void dispose() {
    session.personal.removeListener(_personalChanged);
    session.removeListener(notifyListeners);
    for (final state in _inputs.values) {
      state.dispose();
    }
    _inputs.clear();
    _events.cancel();
    _resets.cancel();
    super.dispose();
  }
}
