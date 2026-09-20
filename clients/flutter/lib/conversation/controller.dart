import 'dart:async';
import 'package:flutter/foundation.dart';
import '../connection/session.dart';
import 'conversation_state.dart';
import 'input_state.dart';
import 'approvals.dart';

final class ConversationController extends ChangeNotifier {
  ConversationController(this.session) {
    input = InputState(
      command: session.command,
      start: (capture) => session.startCapture(capture: capture),
      stop: session.stopCapture,
      prepareDictation: (announce) =>
          session.startCapture(capture: true, beforeStart: announce),
      allowed: () =>
          session.connected &&
          session.editableInput &&
          !session.voice &&
          !session.voiceStarting &&
          session.foreground,
    );
    input.addListener(notifyListeners);
    session.addListener(notifyListeners);
    _events = session.hostEvents.listen((value) {
      try {
        receive(value);
      } catch (_) {
        unawaited(session.rejectHostData());
      }
    });
    _resets = session.resets.listen((_) {
      input.reset();
      approvals.clear();
      _sequence = -1;
      notifyListeners();
    });
  }
  final Session session;
  late final InputState input;
  final transcript = ConversationState();
  final approvals = Approvals();
  final tasks = <String, String>{}, results = <String, String>{};
  late final StreamSubscription<Map<String, dynamic>> _events;
  late final StreamSubscription<void> _resets;
  int _sequence = -1;
  void receive(Map<String, dynamic> value) {
    input.receive(value);
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

  void decide(ApprovalCard card, String decision) {
    if (!session.connected) return;
    final payload = approvals.decide(card, decision);
    if (payload != null) session.command(payload);
    notifyListeners();
  }

  Future<void> switchToText() async {
    if (session.voice || session.voiceStarting) {
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
    session.removeListener(notifyListeners);
    input.removeListener(notifyListeners);
    input.dispose();
    _events.cancel();
    _resets.cancel();
    super.dispose();
  }
}
