// Synthetic screen states on a real Flutter engine. No live service or recording.
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:nova_audio/channel_audio.dart';
import 'package:nova_mobile/connection/session.dart';
import 'package:nova_mobile/services/preferences.dart';
import 'package:nova_mobile/ui/app.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../test/conversation_widget_test.dart' show MemoryCredentials;
import '../test/support/fake_audio.dart';
import '../test/support/fake_transport.dart';
import '../test/session_test.dart' show handshake;

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('public pages and native playback lifecycle', (tester) async {
    final audio = ChannelAudio();
    final capabilities = await audio.capabilities();
    expect(capabilities['relay'], true);
    for (var generation = 1; generation <= 3; generation++) {
      await audio.startRelay(
        generation: generation,
        capture: false,
        threshold: .045,
      );
      await audio.stop();
    }
    await audio.disconnect();
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
    await tester.pump(const Duration(seconds: 1));
    await binding.convertFlutterSurfaceToImage();
    Future<void> shot(String name) async {
      await tester.pump(const Duration(milliseconds: 400));
      expect(tester.takeException(), isNull);
      await binding.takeScreenshot(name);
    }

    await shot('public-01-disconnected');
    await tester.tap(find.byTooltip('Settings'));
    await tester.pump(const Duration(milliseconds: 400));
    await shot('public-02-settings');
    await tester.drag(find.byType(ListView).last, const Offset(0, -400));
    await shot('public-03-settings-bottom');
    await tester.tap(find.text('Done'));
    await tester.pump(const Duration(milliseconds: 400));
    await session.connect(Uri.parse('wss://example.com/client/v1'), 'a' * 32);
    final ready = jsonDecode(handshake()) as Map<String, dynamic>;
    ready['capabilities'] = [
      'audio',
      'captions',
      'projects',
      'executor',
      'text_input',
      'dictation',
    ];
    ready['media'] = {
      'transport': 'host_pcm_v1',
      'path': 'relay',
      'audio_owner': 'client',
      'pipeline': 'cascaded',
    };
    await session.receive(jsonEncode(ready), session.generation);
    Future<void> event(Map<String, Object?> value) =>
        session.receive(jsonEncode(value), session.generation);
    await shot('public-04-connected-empty');
    await event({
      'type': 'caption',
      'sequence': 1,
      'role': 'user',
      'text': '帮我整理一下今天的计划',
      'final': true,
    });
    await event({
      'type': 'caption',
      'sequence': 2,
      'role': 'assistant',
      'text': '## 今日计划\n先核对 **目标**，再处理 `待办`。\n这是合成验收数据。',
      'final': true,
    });
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('Text chat'));
    await shot('public-05-chat');
    await tester.enterText(find.byType(TextField), '保留中的草稿');
    await shot('public-06-draft-keyboard');
    FocusManager.instance.primaryFocus?.unfocus();
    await event({
      'type': 'executor.approval',
      'executor': 'synthetic',
      'pending_approval': true,
      'pending_approval_id': 'screen-check',
      'pending_approval_busy': false,
      'expires_in_seconds': 300,
      'work': {'project': 'Synthetic project', 'title': 'Review change'},
      'operation_summary': 'Confirm synthetic action',
      'local_detail': {'command': 'echo synthetic', 'cwd': '/synthetic'},
      'allowed_decisions': ['accept', 'acceptForSession', 'decline'],
    });
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.byTooltip('Latest messages'));
    await shot('public-07-approval');
    await event({
      'type': 'executor.approval',
      'executor': 'synthetic',
      'pending_approval': true,
      'pending_approval_id': 'screen-check',
      'pending_approval_busy': false,
      'expires_in_seconds': 0,
      'work': {'project': 'Synthetic project', 'title': 'Expired change'},
      'local_detail': {'command': 'echo synthetic'},
      'allowed_decisions': ['accept', 'decline'],
    });
    await shot('public-08-expired-approval');
    await session.end();
    await shot('public-09-disconnected-history');
    await tester.pumpWidget(const SizedBox());
  });
}
