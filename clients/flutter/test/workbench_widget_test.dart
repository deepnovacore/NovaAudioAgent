import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/personal/personal_store.dart';
import 'package:nova_mobile/ui/workbench_page.dart';

void main() {
  testWidgets('Plan edits use the item version and expose ideas and goals', (
    tester,
  ) async {
    final sent = <Map<String, dynamic>>[];
    final store = PersonalStore(
      send: (v) {
        sent.add(v);
        return true;
      },
    );
    addTearDown(store.dispose);
    store.setConnected(true, instance: 'one');
    store.receive({
      'type': 'personal.state',
      'revision': 1,
      'life': {
        'todos': [
          {
            'kind': 'todo',
            'id': 't',
            'title': 'Write report',
            'note': '',
            'status': 'open',
            'version': 3,
          },
        ],
        'ideas': [],
        'goals': [],
        'profile': {'about': '', 'version': 0},
      },
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: WorkbenchPage(store: store, page: 2, onSettings: () {}),
        ),
      ),
    );
    expect(find.text('Write report'), findsOneWidget);
    expect(find.text('Ideas'), findsOneWidget);
    expect(find.text('Goals'), findsOneWidget);
    await tester.tap(find.byType(Checkbox));
    await tester.pump();
    expect(sent.last['method'], 'life.mutate');
    expect(sent.last['params'], containsPair('expected_version', 3));
    final id = sent.last['request_id'];
    store.receive({
      'type': 'personal.result',
      'request_id': id,
      'ok': false,
      'error': 'version_conflict',
    });
    await tester.pump();
    expect(find.textContaining('another device'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    store.setConnected(false);
    await tester.pump();
  });
  testWidgets('Today and Me show offline snapshot without enabling writes', (
    tester,
  ) async {
    final store = PersonalStore(send: (_) => false);
    addTearDown(store.dispose);
    store.receive({
      'type': 'personal.state',
      'revision': 1,
      'life': {
        'todos': [],
        'ideas': [],
        'goals': [],
        'profile': {'about': 'Engineer', 'version': 2},
      },
      'memory': {'entries': []},
      'tasks': [],
      'feed': [],
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: WorkbenchPage(store: store, page: 3, onSettings: () {}),
        ),
      ),
    );
    expect(find.text('Engineer'), findsOneWidget);
    expect(find.textContaining('Offline'), findsWidgets);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: WorkbenchPage(store: store, page: 1, onSettings: () {}),
        ),
      ),
    );
    expect(find.text('Today'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    store.setConnected(false);
    await tester.pump();
  });
}
