import 'package:flutter/material.dart';
import 'ui/app.dart';
export 'ui/app.dart' show NovaApp;

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const NovaApp());
}
