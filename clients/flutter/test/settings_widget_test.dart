import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/settings_sheet.dart';
import 'package:nova_mobile/connection/session.dart';
import 'package:nova_mobile/services/credentials.dart';
import 'support/fake_audio.dart';

void main() {
  testWidgets('editing server erases credential from previous host', (
    tester,
  ) async {
    final session = Session(
      audio: FakeAudio(),
      requestMicrophone: () async => false,
    );
    addTearDown(session.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: SettingsSheet(
          session: session,
          credential: Credential(
            Uri.parse('wss://a.example/client/v1'),
            'a' * 32,
          ),
          language: 'en',
          media: 'auto',
          save: (_) async {},
          forget: () async {},
          configure: (_, _) async {},
        ),
      ),
    );
    await tester.scrollUntilVisible(
      find.byType(TextField).first,
      250,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.enterText(
      find.byType(TextField).first,
      'wss://b.example/client/v1',
    );
    await tester.pump();
    expect(
      tester.widget<TextField>(find.byType(TextField).at(1)).controller!.text,
      isEmpty,
    );
  });
}
