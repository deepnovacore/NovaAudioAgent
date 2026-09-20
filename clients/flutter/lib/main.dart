import 'package:flutter/material.dart';

void main() => runApp(const NovaApp());

class NovaApp extends StatelessWidget {
  const NovaApp({super.key});
  @override
  Widget build(BuildContext context) => const MaterialApp(
    home: Scaffold(
      body: SafeArea(
        child: Column(children: [Text('NOVA'), Text('Not connected')]),
      ),
    ),
  );
}
