import 'dart:convert';
import 'dart:async';
import 'package:nova_mobile/ui/settings_sheet.dart';
import 'package:nova_mobile/services/credentials.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connection/session.dart';
import 'package:nova_mobile/services/preferences.dart';
import 'package:nova_mobile/ui/app.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'conversation_widget_test.dart' show MemoryCredentials;
import 'session_test.dart' show handshake;
import 'support/fake_audio.dart';
import 'support/fake_transport.dart';

class DelayedCredentials extends MemoryCredentials {
  final entered = Completer<void>(), release = Completer<void>();
  @override
  Future<void> write(Credential value) async {
    entered.complete();
    await release.future;
  }
}

void main() {
  testWidgets('saving credentials in background resumes with the saved host', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({'language': 'en'});
    final saved = DelayedCredentials(), opened = <Uri>[];
    final session = Session(
      audio: FakeAudio(),
      requestMicrophone: () async => false,
      openTransport: (uri) async {
        opened.add(uri);
        return FakeTransport();
      },
    );
    addTearDown(session.dispose);
    await tester.pumpWidget(
      NovaApp(
        session: session,
        store: saved,
        preferences: Preferences(await SharedPreferences.getInstance()),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.byTooltip('Settings'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    final sheet = tester.widget<SettingsSheet>(find.byType(SettingsSheet));
    final credential = Credential(
      Uri.parse('wss://new.example/client/v1'),
      'b' * 32,
    );
    final saving = sheet.save(credential);
    await tester.pump();
    await saved.entered.future;
    tester.binding.handleAppLifecycleStateChanged(
      AppLifecycleState.inactive,
    );
    saved.release.complete();
    await saving;
    expect(opened, isEmpty);
    tester.binding.handleAppLifecycleStateChanged(
      AppLifecycleState.resumed,
    );
    await tester.pump();
    expect(opened, [credential.server]);
    await tester.pumpWidget(const SizedBox());
    await session.end();
    await tester.pump();
  });

  testWidgets('global approval can reopen and advances to next pending item', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    final transport = FakeTransport();
    final session = Session(
      audio: FakeAudio(),
      requestMicrophone: () async => false,
      openTransport: (_) async => transport,
    );
    addTearDown(session.dispose);
    await tester.pumpWidget(
      NovaApp(
        session: session,
        store: MemoryCredentials(),
        preferences: Preferences(await SharedPreferences.getInstance()),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
    await session.connect(Uri.parse('wss://example.com/client/v1'), 'a' * 32);
    final ready = jsonDecode(handshake()) as Map<String, dynamic>;
    (ready['capabilities'] as List).add('personal');
    await session.receive(jsonEncode(ready), session.generation);
    void state(int revision, List<String> ids) => session.personal.receive({
      'type': 'personal.state',
      'revision': revision,
      'pending_approvals': [
        for (final id in ids)
          {
            'approval_id': id,
            'conversation_id': 'chat',
            'summary': 'Review $id',
          },
      ],
    });
    state(1, ['a', 'b']);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Review a'), findsOneWidget);
    // Dismissing one item must allow the next queued sheet.
    Navigator.of(tester.element(find.text('Review a'))).pop();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Review b'), findsOneWidget);
    Navigator.of(tester.element(find.text('Review b'))).pop();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('Pending confirmations'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Review a'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('Approve'));
    await tester.pump();
    await tester.tap(find.text('Approve'));
    await tester.pump();
    final commands = transport.sent
        .whereType<String>()
        .map(jsonDecode)
        .where((v) => v['payload']?['method'] == 'conversations.approve')
        .toList();
    expect(commands.length, 1);
    // Host resolution dismisses the sheet even when another device acted.
    state(2, []);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Needs your confirmation'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    await session.end();
    await tester.pump();
  });
}
