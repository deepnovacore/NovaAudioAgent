import 'dart:async';
import 'package:nova_mobile/connection/transport.dart';

class FakeTransport implements TransportPort {
  final input = StreamController<Object>();
  final sent = <Object>[];
  Completer<void>? gate;
  bool closed = false;
  @override
  int? closeCode;
  @override
  Stream<Object> get incoming => input.stream;
  @override
  Future<void> send(Object message) async {
    sent.add(message);
    if (gate != null) await gate!.future;
  }

  @override
  Future<void> close() async {
    closed = true;
  }
}
