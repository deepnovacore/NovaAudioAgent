import 'dart:io';
import 'dart:convert';
import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connection/session.dart';
import 'package:nova_mobile/services/preferences.dart';
import 'package:nova_mobile/ui/app.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'conversation_widget_test.dart' show MemoryCredentials;
import 'support/fake_audio.dart';
import 'support/fake_transport.dart';

void main() {
  setUpAll(() async {
    final config = File('.dart_tool/package_config.json');
    final packages =
        jsonDecode(await config.readAsString())['packages'] as List;
    final flutter = packages.singleWhere((p) => p['name'] == 'flutter');
    final sdk = Directory.fromUri(
      config.absolute.uri.resolve(flutter['rootUri'] as String),
    ).parent.parent.path;
    for (final font in {
      'Roboto': 'Roboto-Regular.ttf',
      'MaterialIcons': 'MaterialIcons-Regular.otf',
    }.entries) {
      final loader = FontLoader(font.key)
        ..addFont(
          File(
            '$sdk/bin/cache/artifacts/material_fonts/${font.value}',
          ).readAsBytes().then((bytes) => ByteData.sublistView(bytes)),
        );
      await loader.load();
    }
  });
  testWidgets('five workbench tabs render cached state at phone size', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    SharedPreferences.setMockInitialValues({'language': 'en'});
    final session = Session(
      audio: FakeAudio(),
      requestMicrophone: () async => false,
      openTransport: (_) async => FakeTransport(),
    );
    addTearDown(session.dispose);
    await tester.pumpWidget(
      NovaApp(
        session: session,
        store: MemoryCredentials(),
        preferences: Preferences(await SharedPreferences.getInstance()),
      ),
    );
    await tester.pump();
    session.personal.receive({
      'type': 'personal.state',
      'revision': 1,
      'conversations': {
        'selected_id': 'main',
        'voice_id': null,
        'unread_count': 2,
        'items': [
          {
            'id': 'main',
            'kind': 'chat',
            'title': 'Mobile workbench',
            'unread_count': 0,
          },
          {
            'id': 'proactive',
            'kind': 'proactive',
            'title': 'Reminders',
            'unread_count': 2,
          },
        ],
        'messages': [
          {
            'id': 'm1',
            'conversation_id': 'main',
            'role': 'assistant',
            'text': 'Your plan is ready. Pick a task to continue.',
          },
        ],
      },
      'news': {
        'items': [
          {
            'id': 'news',
            'title': 'Designing a calmer workday',
            'summary': 'Small routines that keep important work visible.',
            'published_at': '2025-03-04',
            'url': 'https://example.com/article',
            'source_name': 'Example Daily',
          },
          {
            'id': 'news-2',
            'title': 'Notes on building a personal agent',
            'summary': 'Why proactive suggestions need traceable evidence.',
            'published_at': '2025-03-03',
            'source_name': 'Field Notes',
            'read': true,
          },
        ],
        'saved': [],
      },
      'life': {
        'todos': [
          {
            'id': 'todo',
            'kind': 'todo',
            'version': 2,
            'title': 'Prepare the demo',
            'note': 'Review the checklist',
            'status': 'open',
            'due': null,
            'goal_id': 'goal',
          },
          {
            'id': 'todo-2',
            'kind': 'todo',
            'version': 1,
            'title': 'Send the weekly update',
            'note': '',
            'status': 'doing',
            'due': '2000-01-01',
          },
          {
            'id': 'todo-3',
            'kind': 'todo',
            'version': 1,
            'title': 'Book the review room',
            'note': '',
            'status': 'done',
            'due': null,
          },
        ],
        'ideas': [
          {
            'id': 'idea',
            'kind': 'idea',
            'version': 1,
            'title': 'A weekly reflection',
            'note': '',
            'status': 'active',
          },
        ],
        'goals': [
          {
            'id': 'goal',
            'kind': 'goal',
            'version': 1,
            'title': 'Ship mobile workbench',
            'note': '',
            'status': 'active',
            'success_criteria': 'Daily use for two weeks',
            'progress': {'done': 2, 'total': 5},
          },
        ],
        'profile': {
          'about': 'I build useful tools and keep a weekly plan.',
          'version': 1,
        },
      },
      'tasks': [
        {
          'id': 'task',
          'goal': 'Review the mobile changes',
          'phase': 'running',
          'waiting_reason': null,
        },
      ],
      'feed': [
        {
          'id': 'feed',
          'title': 'Review your demo',
          'why_now': 'Your demo is coming up.',
          'lifecycle': 'active',
          'user_state': 'new',
          'delivery': {'presented_at': null},
        },
      ],
      'workbench_context': {
        'status': 'ready',
        'recap': {
          'text': 'Mostly polishing the mobile workbench this week.',
          'projects': [
            {'name': 'Mobile workbench', 'line': 'iOS-style layout pass'},
          ],
        },
        'cards': [
          {
            'id': 'card-todo',
            'tab': 'todos',
            'title': 'Run the acceptance checklist',
            'why': 'The demo is next week.',
            'next': 'Open the checklist and tick the first item',
            'source_count': 2,
          },
          {
            'id': 'card-idea',
            'tab': 'ideas',
            'title': 'Morning summary by voice',
            'body': 'Nova reads the day plan when you open the app.',
            'source_count': 1,
          },
          {
            'id': 'card-goal',
            'tab': 'goals',
            'title': 'Use Nova every day',
            'body': 'Make the assistant part of the daily routine.',
            'source_count': 3,
          },
        ],
      },
      'memory': {
        'entries': [
          {
            'id': 'memory',
            'version': 1,
            'kind': 'preference',
            'status': 'active',
            'content': 'Keep explanations concise.',
            'origin': 'stated',
            'observed_at': '2025-09-28T08:00:00Z',
            'evidence_refs': ['e1'],
            'editable': true,
          },
        ],
        'cursor': null,
      },
    });
    await tester.pump(const Duration(milliseconds: 100));
    for (final page in ['Nova', 'Feeds', 'Todos', 'Ideas', 'Goals']) {
      if (page != 'Nova') {
        await tester.tap(
          find.descendant(
            of: find.byType(BottomAppBarTabs),
            matching: find.text(page),
          ),
        );
        await tester.pumpAndSettle();
      }
      expect(tester.takeException(), isNull);
      await expectLater(
        find.byType(NovaApp),
        matchesGoldenFile(
          'goldens/workbench-${page.toLowerCase().replaceAll('·', '-')}.png',
        ),
      );
    }

    await tester.tap(find.byTooltip('Profile'));
    await tester.pumpAndSettle();
    await expectLater(
      find.byType(NovaApp),
      matchesGoldenFile('goldens/workbench-profile.png'),
    );
    await tester.pageBack();
    await tester.pumpAndSettle();
    tester.view.physicalSize = const Size(320, 740);
    tester.platformDispatcher.textScaleFactorTestValue = 1.3;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    for (final page in ['Nova', 'Feeds', 'Todos', 'Ideas', 'Goals']) {
      await tester.tap(
        find.descendant(
          of: find.byType(BottomAppBarTabs),
          matching: find.text(page),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    }
    await tester.pumpWidget(const SizedBox());
  });
}
