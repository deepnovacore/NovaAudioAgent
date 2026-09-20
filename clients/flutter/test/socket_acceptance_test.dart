import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connection/session.dart';
import 'package:nova_mobile/conversation/controller.dart';
import 'support/fake_audio.dart';

void main() {
  test(
    'real websocket host acknowledges input and returns captions',
    () async {
      final session = Session(
        audio: FakeAudio(),
        requestMicrophone: () async => false,
      );
      final model = ConversationController(session);
      addTearDown(() {
        model.dispose();
        session.dispose();
      });
      await session.connect(
        Uri.parse('ws://127.0.0.1:18787/client/v1'),
        '0123456789abcdef0123456789abcdef',
      );
      final deadline = DateTime.now().add(const Duration(seconds: 5));
      while (!session.connected && DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
      expect(session.connected, true);
      expect(session.editableInput, true);
      model.input.draft = 'mobile acceptance';
      await model.input.sendDraft();
      while (model.input.sending && DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
      expect(model.input.draft, isEmpty);
      expect(
        model.transcript.messages.any(
          (m) => m.text == 'Synthetic reply: mobile acceptance',
        ),
        true,
      );
      await session.end();
    },
    skip: !const bool.fromEnvironment('NOVA_SOCKET_ACCEPTANCE'),
  );
}
