import 'dart:convert';
import 'dart:typed_data';
import '../connection/transport.dart';
import '../protocol/pairing.dart';
import '../protocol/wire.dart';
import 'credentials.dart';

final class PairingFlow {
  PairingFlow({this.open = SocketTransport.open});
  final Future<TransportPort> Function(Uri) open;
  int _generation = 0;
  TransportPort? _socket;
  void cancel() {
    _generation++;
    _socket?.close();
    _socket = null;
  }

  Future<Credential?> redeem(PairingCode invitation) async {
    cancel();
    final generation = _generation;
    if (invitation.expiresAt != null &&
        !invitation.expiresAt!.isAfter(DateTime.now())) {
      throw const FormatException('Pairing code expired');
    }
    TransportPort? socket;
    try {
      return await (() async {
        socket = await open(invitation.endpoint);
        if (generation != _generation) {
          await socket!.close();
          return null;
        }
        _socket = socket;
        final response = socket!.incoming.first;
        await socket!.send(
          jsonEncode({
            'type': 'pair.redeem',
            'code': invitation.code,
            'device_name': 'Nova mobile',
          }),
        );
        final message = await response;
        if (generation != _generation) return null;
        final bytes = message is String
            ? Uint8List.fromList(utf8.encode(message))
            : message is List<int>
            ? Uint8List.fromList(message)
            : throw const FormatException('Invalid pairing response');
        final reply = Wire.json(bytes, limit: 4096);
        if (reply['type'] != 'pair.ready' ||
            reply['device_id'] is! String ||
            !RegExp(
              r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
            ).hasMatch(reply['device_id'])) {
          throw const FormatException(
            'Pairing failed; generate a new code on the host',
          );
        }
        return Credential(invitation.server, reply['token'] as String);
      })().timeout(const Duration(seconds: 10));
    } finally {
      await socket?.close();
      if (generation == _generation) {
        _socket = null;
        _generation++;
      }
    }
  }
}
