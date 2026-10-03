import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connection/session.dart';
import 'package:nova_mobile/conversation/controller.dart';
import 'support/fake_audio.dart';

void main() {
  test(
    'real socket synchronizes life, conversations and semantic text receipts',
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
      while (session.personal.snapshot?.selectedId == null &&
          DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
      expect(session.personal.snapshot?.selectedId, 'chat:main');
      final todo =
          await session.personal.command('life.mutate', {
                'op': 'create',
                'kind': 'todo',
                'title': 'Socket todo',
              })
              as Map;
      await session.personal.command('life.mutate', {
        'op': 'update',
        'kind': 'todo',
        'id': todo['id'],
        'expected_version': todo['version'],
        'status': 'done',
      });
      await expectLater(
        session.personal.command('life.mutate', {
          'op': 'update',
          'kind': 'todo',
          'id': todo['id'],
          'expected_version': todo['version'],
          'status': 'open',
        }),
        throwsA(anything),
      );
      final idea =
          await session.personal.command('life.mutate', {
                'op': 'create',
                'kind': 'idea',
                'title': 'Socket idea',
              })
              as Map;
      await session.personal.command('life.mutate', {
        'op': 'convert',
        'id': idea['id'],
        'expected_version': idea['version'],
        'target': 'goal',
      });
      await session.personal.command('conversations.create');
      await session.personal.command('state');
      final selected = session.personal.snapshot!.selectedId;
      expect(selected, isNot('chat:main'));
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
      await session.personal.command('state');
      final life = session.personal.snapshot!.object('life');
      expect(
        (life['todos'] as List).singleWhere(
          (r) => r['id'] == todo['id'],
        )['status'],
        'done',
      );
      expect(
        (life['goals'] as List).any((r) => r['idea_id'] == idea['id']),
        true,
      );
      expect(
        session.personal.snapshot!.object('conversations')['messages'],
        everyElement(containsPair('conversation_id', selected)),
      );
      await session.end();
      expect(session.personal.snapshot!.selectedId, selected);
    },
    skip: !const bool.fromEnvironment('NOVA_SOCKET_ACCEPTANCE'),
  );
}
