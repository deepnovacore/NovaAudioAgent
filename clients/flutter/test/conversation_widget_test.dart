import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:nova_mobile/ui/voice_orb.dart';
import 'support/fake_transport.dart';
import 'session_test.dart' show handshake;
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connection/session.dart';
import 'package:nova_mobile/services/credentials.dart';
import 'package:nova_mobile/services/preferences.dart';
import 'package:nova_mobile/ui/app.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'support/fake_audio.dart';

class MemoryCredentials implements CredentialStore {
  @override
  Future<Credential?> read() async => null;
  @override
  Future<void> write(Credential value) async {}
  @override
  Future<void> clear() async {}
}

void main() {
  testWidgets(
    'conversation replaces hero and exposes latest-message navigation',
    (tester) async {
      SharedPreferences.setMockInitialValues({});
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
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byType(VoiceOrb), findsOneWidget);
      await session.connect(Uri.parse('wss://example.com/client/v1'), 'a' * 32);
      await session.receive(handshake(), session.generation);
      await session.receive(
        jsonEncode({
          'type': 'caption',
          'connection_id': session.connection,
          'sequence': 1,
          'role': 'assistant',
          'text': '## **Hello**',
          'final': true,
        }),
        session.generation,
      );
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byType(VoiceOrb), findsNothing);
      expect(find.byTooltip('Latest messages'), findsOneWidget);
      expect(find.textContaining('## **Hello**'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );
  for (final size in [const Size(390, 844), const Size(844, 390)]) {
    testWidgets('disconnected controls fit $size at 2x text', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      SharedPreferences.setMockInitialValues({});
      final preferences = Preferences(await SharedPreferences.getInstance());
      final session = Session(
        audio: FakeAudio(),
        requestMicrophone: () async => false,
      );
      addTearDown(session.dispose);
      await tester.pumpWidget(
        NovaApp(
          session: session,
          store: MemoryCredentials(),
          preferences: preferences,
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byKey(const Key('connect')), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets('latest-message control follows content growth and keeps drafts', (
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
    await tester.pump(const Duration(milliseconds: 100));
    await session.connect(Uri.parse('wss://example.com/client/v1'), 'a' * 32);
    final ready = jsonDecode(handshake()) as Map<String, dynamic>;
    ready['media'] = {
      'pipeline': 'cascaded',
      'transport': 'host_pcm_v1',
      'path': 'relay',
      'audio_owner': 'client',
    };
    ready['capabilities'] = [...ready['capabilities'] as List, 'text_input', 'dictation'];
    await session.receive(jsonEncode(ready), session.generation);
    Future<void> caption(int sequence, String text) => session.receive(
      jsonEncode({
        'type': 'caption',
        'connection_id': session.connection,
        'sequence': sequence,
        'role': 'assistant',
        'message_id': 'reply',
        'text': text,
        'final': false,
      }),
      session.generation,
    );
    await caption(1, 'Short');
    await tester.pump(const Duration(milliseconds: 300));
    final button = find.ancestor(
      of: find.byTooltip('Latest messages'),
      matching: find.byType(AnimatedOpacity),
    );
    expect(tester.widget<AnimatedOpacity>(button).opacity, 0);
    await caption(2, List.filled(400, 'long reply').join(' '));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.widget<AnimatedOpacity>(button).opacity, 1);

    final state = tester.state(find.byType(ConversationScreen)) as dynamic;
    await tester.tap(find.text('Text chat'));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.enterText(find.byType(TextField), 'My own draft');
    await state.prefill('Suggested request');
    await tester.pump();
    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.controller!.text, 'My own draft\n\nSuggested request');
    await tester.pumpWidget(const SizedBox());
  });
}
