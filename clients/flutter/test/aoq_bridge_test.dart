import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/protocol/aoq_bridge.dart';

void main() {
  test('AOQ commands are connection bound and strictly sequenced', () {
    final b = AOQRuntimeBridge('c');
    Map<String, dynamic> cmd(int n, String c) => {
      'type': 'aoq.command',
      'connection_id': c,
      'sequence': n,
      'event': {'type': 'response.cancel'},
    };
    expect(() => b.command(cmd(1, 'wrong')), throwsFormatException);
    expect(b.command(cmd(1, 'c'))['type'], 'response.cancel');
    expect(() => b.command(cmd(1, 'c')), throwsFormatException);
    expect(() => b.command(cmd(3, 'c')), throwsFormatException);
    expect(b.command(cmd(2, 'c'))['type'], 'response.cancel');
  });
  test('media events never cross control envelopes', () {
    final b = AOQRuntimeBridge('c');
    expect(b.envelope({'type': 'response.audio.delta'}), isNull);
    expect(b.envelope({'type': 'session.updated'})?['sequence'], 1);
    expect(
      () => b.envelope({'type': 'event', 'data': 'x' * 65536}),
      throwsFormatException,
    );
    expect(b.envelope({'type': 'session.updated'})?['sequence'], 2);
  });
  test('pending commands reject byte overflow and drain releases budget', () {
    final p = AOQPendingCommands();
    p.append({'type': 'a', 'data': 'x' * 200000});
    expect(() => p.append({'data': 'x' * 100000}), throwsFormatException);
    expect(p.drain(), hasLength(1));
    expect(p.drain(), isEmpty);
    p.append({'data': 'x' * 100000});
    expect(p.drain(), hasLength(1));
  });
}
