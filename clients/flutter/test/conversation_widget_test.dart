import 'package:flutter/material.dart';
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
}
