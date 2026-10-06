import 'dart:async';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/personal/models.dart';
import 'package:nova_mobile/personal/snapshot_cache.dart';

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  PersonalSnapshot snapshot(int revision) =>
      PersonalSnapshot({'type': 'personal.state', 'revision': revision});

  test('concurrent writes keep the newest snapshot', () async {
    final cache = SnapshotCache('host#token');
    await Future.wait([for (var i = 1; i <= 5; i++) cache.write(snapshot(i))]);
    expect((await cache.read())!.revision, 5);
  });

  test('clear wins over a write that has not started yet', () async {
    final cache = SnapshotCache('host#token');
    unawaited(cache.write(snapshot(1)));
    await cache.clear();
    expect(await cache.read(), isNull);
  });
}
