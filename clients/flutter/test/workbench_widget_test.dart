import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/personal/personal_store.dart';
import 'package:nova_mobile/ui/workbench_page.dart';
import 'package:nova_mobile/ui/components.dart';
import 'package:nova_mobile/ui/task_details.dart';

void main() {
  testWidgets('Feeds renders ranked and saved desktop news from cache', (
    tester,
  ) async {
    final store = PersonalStore(send: (_) => false);
    addTearDown(store.dispose);
    store.receive({
      'type': 'personal.state',
      'revision': 1,
      'news': {
        'items': [
          {
            'id': 'n',
            'title': 'Desktop article',
            'summary': 'Cached summary',
            'url': 'https://example.com',
          },
        ],
        'saved': [
          {
            'id': 's',
            'title': 'Saved desktop article',
            'summary': 'Saved summary',
          },
        ],
      },
    });
    await tester.pumpWidget(
      MaterialApp(
        home: WorkbenchPage(store: store, page: 1, onSettings: () {}),
      ),
    );
    expect(find.text('Desktop article'), findsOneWidget);
    expect(find.text('Cached summary'), findsOneWidget);
    await tester.tap(find.text('Desktop article'));
    await tester.pumpAndSettle();
    expect(find.text('Cached summary'), findsNWidgets(2));
    expect(find.text('Open original'), findsOneWidget);
    Navigator.of(tester.element(find.text('Open original'))).pop();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Saved'));
    await tester.pumpAndSettle();
    expect(find.text('Saved desktop article'), findsOneWidget);
  });

  testWidgets('Todos edits use the item version', (tester) async {
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
    expect(find.text('Other todos'), findsOneWidget);
    await tester.tap(find.byType(RoundCheck));
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
  testWidgets(
    'Feeds and Profile show offline snapshot without enabling writes',
    (tester) async {
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
            body: WorkbenchPage(store: store, page: 5, onSettings: () {}),
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
      expect(find.text('Feeds'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      store.setConnected(false);
      await tester.pump();
    },
  );
  testWidgets('Todos groups each item once and collapses completed items', (
    tester,
  ) async {
    final store = PersonalStore(send: (_) => false);
    addTearDown(store.dispose);
    store.receive({
      'type': 'personal.state',
      'revision': 1,
      'life': {
        'todos': [
          for (final pair in [
            ('Due item', 'open'),
            ('Doing item', 'doing'),
            ('Waiting item', 'waiting'),
            ('Done item', 'done'),
          ])
            {
              'id': pair.$1,
              'kind': 'todo',
              'title': pair.$1,
              'status': pair.$2,
              'due': '2020-01-01',
            },
        ],
      },
    });
    await tester.pumpWidget(
      MaterialApp(
        home: WorkbenchPage(store: store, page: 2, onSettings: () {}),
      ),
    );
    expect(find.text('Due item'), findsOneWidget);
    expect(find.text('Doing item'), findsOneWidget);
    expect(find.text('Waiting item'), findsOneWidget);
    expect(find.text('Done item'), findsNothing);
    await tester.scrollUntilVisible(find.text('Completed (1)'), 150);
    await tester.tap(find.text('Completed (1)'));
    await tester.pumpAndSettle();
    expect(find.text('Done item'), findsOneWidget);
  });

  testWidgets(
    'Reminders sort cards and Discuss opens its topic before switching',
    (tester) async {
      final sent = <Map<String, dynamic>>[];
      final store = PersonalStore(
        send: (value) {
          sent.add(value);
          return true;
        },
      );
      addTearDown(store.dispose);
      store.setConnected(true);
      store.receive({
        'type': 'personal.state',
        'revision': 1,
        'feed': [
          for (final pair in [('Low', 1), ('High', 10)])
            {
              'id': pair.$1,
              'title': pair.$1,
              'priority': pair.$2,
              'lifecycle': 'active',
              'user_state': 'new',
              'delivery': {'presented_at': 'already'},
            },
        ],
      });
      var opened = false;
      await tester.pumpWidget(
        MaterialApp(
          home: WorkbenchPage(
            store: store,
            page: 0,
            onSettings: () {},
            onOpenConversation: () => opened = true,
          ),
        ),
      );
      expect(
        tester.getTopLeft(find.text('High')).dy,
        lessThan(tester.getTopLeft(find.text('Low')).dy),
      );
      await tester.tap(find.text('Discuss').first);
      await tester.pump();
      expect(sent.last['method'], 'conversations.open_feed');
      expect(sent.last['params'], {'feed_id': 'High'});
      expect(opened, false);
      store.receive({
        'type': 'personal.result',
        'request_id': sent.last['request_id'],
        'ok': true,
        'data': {},
      });
      await tester.pump();
      expect(opened, true);
      await tester.pumpWidget(const SizedBox());
      store.setConnected(false);
      await tester.pump();
    },
  );

  testWidgets('Ideas and Goals keep the create action scoped to each page', (
    tester,
  ) async {
    final sent = <Map<String, dynamic>>[];
    final store = PersonalStore(
      send: (value) {
        sent.add(value);
        return true;
      },
    );
    addTearDown(store.dispose);
    store.setConnected(true);
    await tester.pumpWidget(
      MaterialApp(
        home: WorkbenchPage(store: store, page: 3, onSettings: () {}),
      ),
    );
    expect(find.byTooltip('New idea'), findsOneWidget);
    await tester.pumpWidget(
      MaterialApp(
        home: WorkbenchPage(
          key: const ValueKey('goals'),
          store: store,
          page: 4,
          onSettings: () {},
        ),
      ),
    );
    await tester.pump();
    await tester.tap(find.byTooltip('New goal'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Ship the update');
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(sent.last['params'], {
      'op': 'create',
      'kind': 'goal',
      'title': 'Ship the update',
    });
    store.receive({
      'type': 'personal.result',
      'request_id': sent.last['request_id'],
      'ok': true,
      'data': {'id': 'goal'},
    });
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
    store.setConnected(false);
    await tester.pump();
  });
  testWidgets('Todo details save retains the version and closes cleanly', (
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
    store.setConnected(true);
    store.receive({
      'type': 'personal.state',
      'revision': 1,
      'life': {
        'todos': [
          {
            'kind': 'todo',
            'id': 't',
            'title': 'Original',
            'status': 'open',
            'version': 7,
            'note': '',
          },
        ],
        'goals': [],
      },
    });
    await tester.pumpWidget(
      MaterialApp(
        home: WorkbenchPage(store: store, page: 2, onSettings: () {}),
      ),
    );
    await tester.tap(find.text('Original'));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, 'Title'), 'Updated');
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(sent.last['params'], containsPair('expected_version', 7));
    expect(sent.last['params'], containsPair('title', 'Updated'));
    store.receive({
      'type': 'personal.result',
      'request_id': sent.last['request_id'],
      'ok': true,
      'data': {},
    });
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
    store.setConnected(false);
    await tester.pump();
  });

  testWidgets(
    'Dismissing task details before discussion reply keeps the page',
    (tester) async {
      final sent = <Map<String, dynamic>>[];
      final store = PersonalStore(
        send: (v) {
          sent.add(v);
          return true;
        },
      );
      addTearDown(store.dispose);
      store.setConnected(true);
      store.receive({
        'type': 'personal.state',
        'revision': 1,
        'tasks': [
          {
            'id': 'task',
            'goal': 'Review task',
            'phase': 'running',
            'conversation_id': 'chat',
          },
        ],
      });
      var opened = false;
      await tester.pumpWidget(
        MaterialApp(
          home: WorkbenchPage(
            store: store,
            page: 0,
            onSettings: () {},
            onOpenConversation: () => opened = true,
          ),
        ),
      );
      await tester.tap(find.text('Review task'));
      await tester.pump();
      store.receive({
        'type': 'personal.result',
        'request_id': sent.last['request_id'],
        'ok': true,
        'data': {
          'id': 'task',
          'goal': 'Review task',
          'phase': 'running',
          'events': {'items': [], 'next': 0},
        },
      });
      await tester.pumpAndSettle();
      await tester.tap(find.text('Discuss / add input in Nova'));
      await tester.pump();
      final request = sent.last['request_id'];
      Navigator.of(
        tester.element(find.text('Discuss / add input in Nova')),
      ).pop();
      await tester.pumpAndSettle();
      store.receive({
        'type': 'personal.result',
        'request_id': request,
        'ok': true,
        'data': {},
      });
      await tester.pumpAndSettle();
      expect(find.text('Reminders'), findsOneWidget);
      expect(opened, false);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      store.setConnected(false);
      await tester.pump();
    },
  );
  testWidgets(
    'Task cancel receipt stays current until a newer snapshot arrives',
    (tester) async {
      final sent = <Map<String, dynamic>>[];
      final store = PersonalStore(
        send: (v) {
          sent.add(v);
          return true;
        },
      );
      addTearDown(store.dispose);
      store.setConnected(true);
      final task = <String, dynamic>{
        'id': 'task',
        'goal': 'Run check',
        'phase': 'running',
        'control_revision': 1,
        'goal_revision': 1,
      };
      store.receive({
        'type': 'personal.state',
        'revision': 1,
        'tasks': [task],
      });
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TaskDetails(store: store, task: task, onDiscuss: () async {}),
          ),
        ),
      );
      store.receive({
        'type': 'personal.result',
        'request_id': sent.last['request_id'],
        'ok': true,
        'data': {
          ...task,
          'events': {'items': [], 'next': 0},
        },
      });
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel task'));
      await tester.pump();
      expect(sent.last['method'], 'tasks.cancel');
      store.receive({
        'type': 'personal.result',
        'request_id': sent.last['request_id'],
        'ok': true,
        'data': {...task, 'phase': 'cancelled', 'control_revision': 2},
      });
      await tester.pumpAndSettle();
      expect(find.text('Cancel task'), findsNothing);
      expect(find.textContaining('cancelled'), findsOneWidget);
      store.receive({
        'type': 'personal.state',
        'revision': 2,
        'tasks': [
          {...task, 'phase': 'completed', 'control_revision': 3},
        ],
      });
      await tester.pump();
      expect(find.textContaining('completed'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      store.setConnected(false);
      await tester.pump();
    },
  );

  testWidgets('Life tabs show desktop suggestions and send context commands', (
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
    store.setConnected(true);
    store.receive({
      'type': 'personal.state',
      'revision': 1,
      'life': {'todos': [], 'ideas': [], 'goals': []},
      'workbench_context': {
        'status': 'ready',
        'recap': {
          'text': 'Busy with the workbench',
          'projects': [
            {'name': 'Nova', 'line': 'Polish mobile'},
          ],
        },
        'cards': [
          {
            'id': 't1',
            'tab': 'todos',
            'title': 'Verify a task',
            'why': 'Acceptance matters',
            'next': 'Open the workbench',
            'source_count': 2,
          },
          {
            'id': 'g1',
            'tab': 'goals',
            'title': 'Daily assistant',
            'body': 'Use Nova every day',
            'source_count': 1,
          },
        ],
      },
    });
    String? delegated;
    await tester.pumpWidget(
      MaterialApp(
        home: WorkbenchPage(
          store: store,
          page: 2,
          onSettings: () {},
          onDelegate: (text) => delegated = text,
        ),
      ),
    );
    expect(find.text('Busy with the workbench'), findsOneWidget);
    expect(find.text('Verify a task'), findsOneWidget);
    expect(find.text('Daily assistant'), findsNothing);
    expect(find.text('Based on 2 sources'), findsOneWidget);
    await tester.tap(find.text('Help me do it'));
    expect(delegated, contains('Open the workbench'));
    await tester.tap(find.text('Hide'));
    await tester.pump();
    expect(sent.last['method'], 'context.dismiss');
    expect(sent.last['params'], {'id': 't1'});
    await tester.pumpWidget(
      MaterialApp(
        home: WorkbenchPage(store: store, page: 4, onSettings: () {}),
      ),
    );
    expect(find.text('Daily assistant'), findsOneWidget);
    await tester.tap(find.text('Set as goal'));
    await tester.pump();
    expect(sent.last['method'], 'context.adopt');
    expect(sent.last['params'], {'id': 'g1'});
    await tester.pumpWidget(const SizedBox());
    store.setConnected(false);
    await tester.pump();
  });

  testWidgets('Profile shows the Nova draft and hides empty memories', (
    tester,
  ) async {
    final store = PersonalStore(send: (_) => false);
    addTearDown(store.dispose);
    store.receive({
      'type': 'personal.state',
      'revision': 1,
      'life': {
        'profile': {'about': '', 'version': 0},
      },
      'profile_preparation': {
        'status': 'ready',
        'draft': {
          'about': 'Builds a personal agent',
          'work': [
            {'title': 'Nova v0.3.0', 'text': 'Workbench acceptance'},
          ],
        },
      },
      'memory': {
        'entries': [
          {'id': 'blank', 'content': '', 'kind': 'profile', 'version': 1},
          {
            'id': 'm',
            'content': 'Prefers short replies',
            'kind': 'preference',
            'origin': 'stated',
            'version': 1,
          },
        ],
      },
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: WorkbenchPage(store: store, page: 5, onSettings: () {}),
        ),
      ),
    );
    expect(find.text('Builds a personal agent'), findsOneWidget);
    expect(find.text('Nova v0.3.0'), findsOneWidget);
    expect(find.textContaining('Drafted by Nova'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('Prefers short replies'), 100);
    expect(find.text('Nothing remembered yet'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('text editor sheet fits a short screen with the keyboard open', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(844, 390);
    tester.view.devicePixelRatio = 1;
    tester.view.viewInsets = const FakeViewPadding(bottom: 220);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => editTextSheet(
              context,
              language: 'en',
              title: 'Notes',
              value: List.filled(20, 'line').join('\n'),
              limit: 4000,
              lines: 4,
            ),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.text('Save'), findsOneWidget);
  });
}
