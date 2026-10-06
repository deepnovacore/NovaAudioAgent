import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/conversation/approvals.dart';

void main() {
  test('missing deadline and busy approvals fail closed', () {
    final state = Approvals();
    state.receive({
      'type': 'project.state',
      'pending_confirmation': true,
      'pending_confirmation_id': 'id',
      'pending_confirmation_busy': false,
    });
    expect(state.decide(state.cards.single, 'accept'), isNull);
  });
  test(
    'session approval maps scope, rejects repeated or unknown decisions',
    () {
      final state = Approvals();
      state.receive({
        'type': 'executor.approval',
        'executor': 'codex',
        'pending_approval': true,
        'pending_approval_id': 'id',
        'local_detail': {'command': 'test'},
        'allowed_decisions': ['acceptForSession', 'decline'],
        'expires_in_seconds': 20,
        'pending_approval_busy': false,
      });
      final card = state.cards.single;
      expect(state.decide(card, 'unknown'), isNull);
      expect(state.decide(card, 'acceptForSession')?['scope'], 'session');
      expect(state.decide(card, 'decline'), isNull);
    },
  );
}
