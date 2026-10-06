import 'dart:io';
import 'package:integration_test/integration_test_driver_extended.dart';

Future<void> main() async {
  final output = Platform.environment['NOVA_EVIDENCE_DIR'];
  if (output == null) {
    throw StateError('Set NOVA_EVIDENCE_DIR to external evidence storage');
  }
  await integrationDriver(
    onScreenshot: (name, bytes, [args]) async {
      final file = File('$output/$name.png');
      await file.parent.create(recursive: true);
      await file.writeAsBytes(bytes);
      return true;
    },
  );
}
