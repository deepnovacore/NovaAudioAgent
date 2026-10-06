import 'dart:io';

abstract interface class TransportPort {
  Stream<Object> get incoming;
  int? get closeCode;
  Future<void> send(Object message);
  Future<void> close();
}

final class SocketTransport implements TransportPort {
  SocketTransport._(this._socket);
  final WebSocket _socket;
  static Future<TransportPort> open(Uri endpoint) async => SocketTransport._(
    await WebSocket.connect(
      endpoint.toString(),
    ).timeout(const Duration(seconds: 10)),
  );
  @override
  Stream<Object> get incoming => _socket.cast<Object>();
  @override
  int? get closeCode => _socket.closeCode;
  @override
  Future<void> send(Object message) => _socket.addStream(Stream.value(message));
  @override
  Future<void> close() async {
    await _socket.close(WebSocketStatus.goingAway);
  }

  void monitorHeartbeat() => _socket.pingInterval = const Duration(seconds: 3);
}
