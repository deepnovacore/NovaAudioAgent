import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/main.dart' as app;

void main() {
  testWidgets('starts disconnected with no conversation activity', (
    tester,
  ) async {
    app.main();
    await tester.pump();
    expect(find.text('Nova'), findsNWidgets(2));
    expect(find.text('Not connected'), findsOneWidget);
  });
}
