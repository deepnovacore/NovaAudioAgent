import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/conversation/input_state.dart';

void main() {
  test(
    'dictation start reaches host before microphone starts producing PCM',
    () async {
      var hostStarted = false;
      final state = InputState(
        command: (v) {
          if (v['action'] == 'start') hostStarted = true;
          return 'request';
        },
        start: (_) async {
          expect(hostStarted, true);
          return true;
        },
        stop: () async {},
        allowed: () => true,
      );
      addTearDown(state.dispose);
      await state.beginDictation();
    },
  );

  test('acknowledgement never erases a newer draft', () async {
    final state = InputState(
      command: (_) => 'request',
      start: (_) async => true,
      stop: () async {},
      allowed: () => true,
    );
    addTearDown(state.dispose);
    state.draft = 'A';
    await state.sendDraft();
    state.draft = 'B';
    state.receive({
      'type': 'client.command_result',
      'request_id': 'request',
      'status': 'applied',
    });
    expect(state.draft, 'B');
    expect(state.sending, false);
  });
  test('cancelled transcription cannot edit draft', () async {
    final commands = <Map<String, dynamic>>[];
    final state = InputState(
      command: (v) {
        commands.add(v);
        return 'request';
      },
      start: (_) async => true,
      stop: () async {},
      allowed: () => true,
    );
    addTearDown(state.dispose);
    state.draft = 'original';
    await state.beginDictation();
    final id = commands.first['id'];
    await state.finishDictation();
    await state.cancelDictation();
    state.receive({'type': 'input.transcription', 'id': id, 'text': 'late'});
    expect(state.draft, 'original');
  });
}
