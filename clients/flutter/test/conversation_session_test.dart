import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/connection/session.dart';
import 'package:nova_mobile/conversation/controller.dart';
import 'package:nova_mobile/personal/snapshot_cache.dart';
import 'package:nova_mobile/personal/models.dart';
import 'package:nova_mobile/services/credentials.dart';
import 'support/fake_audio.dart';
import 'support/fake_transport.dart';
import 'session_test.dart' show handshake;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));
  const endpoint = 'wss://example.com/client/v1',
      token = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  Future<void> tick() => Future<void>.delayed(Duration.zero);
  List<Map<String, dynamic>> payloads(FakeTransport t) => t.sent
      .whereType<String>()
      .map((s) => jsonDecode(s) as Map<String, dynamic>)
      .where((v) => v['type'] == 'client.command')
      .map((v) => Map<String, dynamic>.from(v['payload'] as Map))
      .toList();
  Future<void> ready(Session s) async {
    await s.connect(Uri.parse(endpoint), token);
    final h = jsonDecode(handshake()) as Map<String, dynamic>;
    h['media'] = {
      'transport': 'host_pcm_v1',
      'path': 'relay',
      'audio_owner': 'client',
      'pipeline': 'cascaded',
    };
    (h['capabilities'] as List).addAll(['personal', 'text_input', 'dictation']);
    await s.receive(jsonEncode(h), s.generation);
    await tick();
  }

  Future<void> state(Session s, int revision, String selected) => s.receive(
    jsonEncode({
      'type': 'personal.state',
      'revision': revision,
      'conversations': {
        'selected_id': selected,
        'items': [
          {'id': 'a'},
          {'id': 'b'},
        ],
        'messages': [
          {
            'id': 'history-$selected',
            'conversation_id': selected,
            'role': 'user',
            'text': 'history $selected',
          },
        ],
      },
    }),
    s.generation,
  );
  Future<void> result(Session s, Map<String, dynamic> command) => s.receive(
    jsonEncode({
      'type': 'personal.result',
      'request_id': command['request_id'],
      'ok': true,
    }),
    s.generation,
  );

  test(
    'late text receipt clears only its original conversation draft',
    () async {
      final t = FakeTransport(), a = FakeAudio();
      final s = Session(
        audio: a,
        requestMicrophone: () async => true,
        openTransport: (_) async => t,
      );
      final c = ConversationController(s);
      addTearDown(() {
        c.dispose();
        s.dispose();
      });
      await ready(s);
      await state(s, 1, 'a');
      c.input.draft = 'sent from A';
      await c.input.sendDraft();
      await tick();
      final sent = payloads(t).lastWhere((v) => v['type'] == 'input.text');
      expect(sent['conversation_id'], 'a');
      await state(s, 2, 'b');
      c.input.draft = 'unsent B';
      await s.receive(
        jsonEncode({
          'type': 'input.text_result',
          'request_id': sent['request_id'],
          'conversation_id': 'a',
          'ok': true,
        }),
        s.generation,
      );
      expect(c.input.draft, 'unsent B');
      await state(s, 3, 'a');
      expect(c.input.draft, isEmpty);
      expect(c.input.sending, false);
      await state(s, 4, 'b');
      expect(c.input.draft, 'unsent B');
    },
  );

  test(
    'forget before connecting deletes saved scope and replacing scope clears old cache',
    () async {
      final cache = SnapshotCache('$endpoint#$token');
      await cache.write(
        PersonalSnapshot({'type': 'personal.state', 'revision': 1, 'life': {}}),
      );
      final s = Session(
        audio: FakeAudio(),
        requestMicrophone: () async => false,
        openTransport: (_) async => FakeTransport(),
      );
      addTearDown(s.dispose);
      await s.forgetPersonal(cacheScope: '$endpoint#$token');
      expect(await cache.read(), isNull);
      await ready(s);
      await state(s, 1, 'a');
      await tick();
      expect(await cache.read(), isNotNull);
      await s.connect(Uri.parse(endpoint), 'b' * 32);
      await tick();
      expect(await cache.read(), isNull);
    },
  );

  test(
    'expired persisted credentials also remove their offline snapshot',
    () async {
      final credential = Credential(
        Uri.parse(endpoint),
        token,
        expiresAt: DateTime(2020),
      );
      const storage = FlutterSecureStorage();
      await storage.write(
        key: 'nova.mobile.credential.v1',
        value: jsonEncode(credential.toJson()),
      );
      final cache = SnapshotCache('$endpoint#$token', storage: storage);
      await cache.write(PersonalSnapshot({'revision': 1, 'life': {}}));
      expect(await SecureCredentialStore(storage: storage).read(), isNull);
      expect(await cache.read(), isNull);
    },
  );

  for (final select in [false, true]) {
    test(
      'cancel during host voice enable via ${select ? 'selection' : 'text mode'} releases voice',
      () async {
        final t = FakeTransport(), a = FakeAudio();
        final s = Session(
          audio: a,
          requestMicrophone: () async => true,
          openTransport: (_) async => t,
        );
        final c = ConversationController(s);
        addTearDown(() {
          c.dispose();
          s.dispose();
        });
        await ready(s);
        await state(s, 1, 'a');
        final starting = s.startVoice();
        await tick();
        final enable = payloads(
          t,
        ).lastWhere((v) => v['method'] == 'conversations.voice');
        final stopping = select ? state(s, 2, 'b') : c.switchToText();
        await tick();
        final disable = payloads(
          t,
        ).lastWhere((v) => v['method'] == 'conversations.voice');
        expect(disable['params'], {'id': 'a', 'enabled': false});
        await result(s, enable);
        await result(s, disable);
        await starting;
        await stopping;
        expect(a.startCount, 0);
        expect(s.voice, false);
        expect(s.voiceStarting, false);
        expect(s.connected, true);
      },
    );
  }

  for (final denied in [true, false]) {
    test(
      'host voice released after ${denied ? 'permission denial' : 'native start failure'}',
      () async {
        final t = FakeTransport(), a = FakeAudio()..failStart = !denied;
        final s = Session(
          audio: a,
          requestMicrophone: () async => !denied,
          openTransport: (_) async => t,
        );
        addTearDown(s.dispose);
        await ready(s);
        await state(s, 1, 'a');
        final starting = s.startVoice();
        await tick();
        await result(
          s,
          payloads(t).lastWhere((v) => v['method'] == 'conversations.voice'),
        );
        await tick();
        final disable = payloads(
          t,
        ).lastWhere((v) => v['method'] == 'conversations.voice');
        expect(disable['params'], {'id': 'a', 'enabled': false});
        await result(s, disable);
        await starting;
        expect(s.voice, false);
        expect(s.voiceStarting, false);
      },
    );
  }

  test(
    'forget clears persisted snapshot and all retained conversation data',
    () async {
      final a = FakeAudio();
      final s = Session(
        audio: a,
        requestMicrophone: () async => true,
        openTransport: (_) async => FakeTransport(),
      );
      final c = ConversationController(s);
      addTearDown(() {
        c.dispose();
        s.dispose();
      });
      await ready(s);
      await state(s, 1, 'a');
      c.input.draft = 'private A';
      await state(s, 2, 'b');
      c.input.draft = 'private B';
      await tick();
      final cache = SnapshotCache('$endpoint#$token');
      expect(await cache.read(), isNotNull);
      await s.end();
      await s.forgetPersonal();
      expect(s.personal.snapshot, isNull);
      expect(await cache.read(), isNull);
      expect(c.input.draft, isEmpty);
      expect(c.transcript.messages, isEmpty);
      await ready(s);
      await state(s, 3, 'a');
      expect(c.input.draft, isEmpty);
    },
  );

  test(
    'inactive immediately stops foreground eligibility and ready presence does not block',
    () async {
      final t = FakeTransport(), a = FakeAudio();
      final s = Session(
        audio: a,
        requestMicrophone: () async => true,
        openTransport: (_) async => t,
      );
      addTearDown(s.dispose);
      await ready(s);
      expect(
        payloads(t).any(
          (v) =>
              v['method'] == 'presentation.set' &&
              v['params']['mode'] == 'workbench',
        ),
        true,
      );
      final inactive = s.inactive();
      expect(s.foreground, false);
      await inactive;
      await tick();
      expect(s.connected, true);
      expect(await s.startCapture(capture: true), false);
      expect(
        payloads(
          t,
        ).lastWhere((v) => v['method'] == 'presentation.set')['params']['mode'],
        'background',
      );
      s.resumeForeground();
      await tick();
      expect(s.foreground, true);
      expect(
        payloads(
          t,
        ).lastWhere((v) => v['method'] == 'presentation.set')['params']['mode'],
        'workbench',
      );
    },
  );
  test(
    'shared approval path marks only delivered decisions submitted',
    () async {
      final transport = FakeTransport();
      final session = Session(
        audio: FakeAudio(),
        requestMicrophone: () async => true,
        openTransport: (_) async => transport,
      );
      final controller = ConversationController(session);
      addTearDown(() {
        controller.dispose();
        session.dispose();
      });
      void approval() => controller.receive({
        'type': 'executor.approval',
        'executor': 'codex',
        'pending_approval': true,
        'pending_approval_id': 'approval',
        'pending_approval_busy': false,
        'expires_in_seconds': 30,
        'allowed_decisions': ['acceptForSession'],
        'local_detail': {'command': 'test'},
      });
      approval();
      session.connected = true;
      expect(
        controller.decide(
          controller.approvals.cards.single,
          'acceptForSession',
        ),
        false,
      );
      expect(controller.approvals.submitted, isEmpty);
      await ready(session);
      approval();
      expect(
        controller.decide(
          controller.approvals.cards.single,
          'acceptForSession',
        ),
        true,
      );
      expect(
        controller.decide(
          controller.approvals.cards.single,
          'acceptForSession',
        ),
        false,
      );
      await tick();
      expect(payloads(transport).last, {
        'type': 'executor.approval_decision',
        'executor': 'codex',
        'approval_id': 'approval',
        'approved': true,
        'scope': 'session',
      });
    },
  );

  test(
    'failed host voice result still releases an uncertain voice start',
    () async {
      final transport = FakeTransport();
      final session = Session(
        audio: FakeAudio(),
        requestMicrophone: () async => true,
        openTransport: (_) async => transport,
      );
      addTearDown(session.dispose);
      await ready(session);
      await state(session, 1, 'a');
      final starting = session.startVoice();
      await tick();
      final enable = payloads(
        transport,
      ).lastWhere((v) => v['method'] == 'conversations.voice');
      await session.receive(
        jsonEncode({
          'type': 'personal.result',
          'request_id': enable['request_id'],
          'ok': false,
          'error': 'voice_failed',
        }),
        session.generation,
      );
      await tick();
      final disable = payloads(
        transport,
      ).lastWhere((v) => v['method'] == 'conversations.voice');
      expect(disable['params'], {'id': 'a', 'enabled': false});
      await result(session, disable);
      await starting;
      expect(session.voiceStarting, false);
    },
  );

  test('late native capture completion cannot survive cancellation', () async {
    final transport = FakeTransport(), audio = _DelayedAudio();
    final session = Session(
      audio: audio,
      requestMicrophone: () async => true,
      openTransport: (_) async => transport,
    );
    addTearDown(session.dispose);
    await ready(session);
    final starting = session.startCapture(capture: true);
    await tick();
    final stopping = session.stopCapture();
    await tick();
    audio.started.complete();
    expect(await starting, false);
    await stopping;
    expect(audio.active, false);
  });

  test(
    'revoked credential clears cached data and every conversation draft',
    () async {
      final transport = FakeTransport()..closeCode = 4003, audio = FakeAudio();
      final session = Session(
        audio: audio,
        requestMicrophone: () async => true,
        openTransport: (_) async => transport,
      );
      final controller = ConversationController(session);
      addTearDown(() {
        controller.dispose();
        session.dispose();
      });
      await ready(session);
      await state(session, 1, 'a');
      controller.input.draft = 'private';
      await tick();
      await transport.input.close();
      for (var i = 0; i < 20 && !session.credentialRevoked; i++) {
        await tick();
      }
      await tick();
      expect(session.credentialRevoked, true);
      expect(session.personal.snapshot, isNull);
      expect(controller.transcript.messages, isEmpty);
      expect(controller.input.draft, isEmpty);
      expect(await SnapshotCache('$endpoint#$token').read(), isNull);
    },
  );
}

class _DelayedAudio extends FakeAudio {
  final started = Completer<void>();
  bool active = false;
  @override
  Future<void> startRelay({
    required int generation,
    required bool capture,
    required double threshold,
  }) async {
    await started.future;
    active = true;
    await super.startRelay(
      generation: generation,
      capture: capture,
      threshold: threshold,
    );
  }

  @override
  Future<void> stop() async {
    active = false;
    await super.stop();
  }
}
