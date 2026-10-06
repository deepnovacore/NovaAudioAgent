import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/personal/personal_store.dart';

void main() {
  test('revision ordering, conflict, reload, disconnect and timeout', () async {
    final sent = <Map<String, dynamic>>[];
    final store = PersonalStore(
      send: (frame) {
        sent.add(frame);
        return true;
      },
      timeout: const Duration(milliseconds: 20),
    );
    addTearDown(store.dispose);
    store.setConnected(true, instance: 'one');
    store.receive({'type': 'personal.state', 'revision': 4, 'life': {}});
    store.receive({'type': 'personal.state', 'revision': 2, 'life': {}});
    expect(store.snapshot!.revision, 4);
    final conflict = store.command('life.mutate', {});
    final conflictCheck = expectLater(
      conflict,
      throwsA(
        isA<PersonalCommandError>().having(
          (e) => e.code,
          'code',
          'version_conflict',
        ),
      ),
    );
    store.receive({
      'type': 'personal.result',
      'request_id': sent.last['request_id'],
      'ok': false,
      'error': 'version_conflict',
    });
    await conflictCheck;
    final before = sent.length;
    store.receive({
      'type': 'personal.state',
      'revision': 5,
      'reload_required': true,
    });
    expect(sent.length, before + 1);
    expect(sent.last['method'], 'state');
    expect(store.snapshot!.revision, 4);
    // A second oversized state must not create a tight refresh loop.
    store.receive({
      'type': 'personal.state',
      'revision': 5,
      'reload_required': true,
    });
    expect(sent.length, before + 1);
    final mutation = store.command('life.mutate', {});
    final disconnected = expectLater(
      mutation,
      throwsA(isA<PersonalCommandError>()),
    );
    store.setConnected(false);
    await disconnected;
    expect(store.snapshot!.revision, 4);
    store.setConnected(true, instance: 'two');
    store.receive({'type': 'personal.state', 'revision': 1, 'life': {}});
    expect(store.snapshot!.revision, 1);
    expect(sent.last['method'], 'state');
    await expectLater(
      store.command('life.mutate', {}),
      throwsA(isA<TimeoutException>()),
    );
  });
  test('oversized refresh stops looping and can be retried manually', () async {
    final sent = <Map<String, dynamic>>[];
    final store = PersonalStore(
      send: (frame) {
        sent.add(frame);
        return true;
      },
    );
    addTearDown(store.dispose);
    store.setConnected(true, instance: 'one');
    store.receive({
      'type': 'personal.result',
      'request_id': sent.last['request_id'],
      'ok': true,
      'data': {
        'type': 'personal.state',
        'revision': 2,
        'reload_required': true,
      },
    });
    await Future<void>.delayed(Duration.zero);
    expect(sent.length, 1);
    store.receive({
      'type': 'personal.state',
      'revision': 3,
      'reload_required': true,
    });
    expect(sent.length, 1);
    store.refresh(force: true);
    expect(sent.length, 2);
    store.receive({
      'type': 'personal.result',
      'request_id': sent.last['request_id'],
      'ok': true,
      'data': {'type': 'personal.state', 'revision': 3, 'life': {}},
    });
    await Future<void>.delayed(Duration.zero);
    expect(store.snapshot!.revision, 3);
    expect(store.error, isNull);
  });
  test(
    'pending commands bounded at 32 and not replayed on reconnect',
    () async {
      final sent = <Map<String, dynamic>>[];
      final store = PersonalStore(
        send: (v) {
          sent.add(v);
          return true;
        },
      );
      addTearDown(store.dispose);
      store.setConnected(true, instance: 'one');
      final futures = <Future<void>>[];
      for (var i = 0; i < 31; i++) {
        futures.add(
          store
              .command('life.mutate', {})
              .then<void>((_) {}, onError: (Object _) {}),
        );
      }
      await expectLater(
        store.command('life.mutate', {}),
        throwsA(isA<PersonalCommandError>()),
      );
      store.setConnected(false);
      await Future.wait(futures);
      final before = sent.length;
      store.setConnected(true, instance: 'one');
      expect(sent.length, before + 1);
      expect(sent.last['method'], 'state');
    },
  );
}
