import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connection/recovery.dart';

void main() {
  test('unstable ready does not refill retry budget', () {
    final r = Recovery();
    expect(r.nextDelay(0), const Duration(seconds: 1));
    r.markReady(1000);
    expect(r.nextDelay(1001), const Duration(seconds: 2));
    expect(r.nextDelay(1002), const Duration(seconds: 4));
    expect(r.nextDelay(1003), isNull);
  });
  test('stable ready refills exhausted retry budget', () {
    final r = Recovery();
    for (var i = 0; i < 3; i++) {
      r.nextDelay(i);
    }
    r.markReady(1000);
    expect(r.nextDelay(31000), const Duration(seconds: 1));
  });
}
