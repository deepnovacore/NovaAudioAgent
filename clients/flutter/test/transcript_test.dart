import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/conversation/conversation_state.dart';

void main() {
  test('late partial cannot overwrite final or duplicate message', () {
    final s = ConversationState();
    s.receive(role: 'assistant', text: 'par', finalText: false, id: 'a');
    s.receive(role: 'assistant', text: 'final', finalText: true, id: 'a');
    s.receive(role: 'assistant', text: 'stale', finalText: false, id: 'a');
    expect(s.messages.single.text, 'final');
    expect(s.messages.single.finalText, true);
  });
  test('no-ID partials only update last unfinished same role', () {
    final s = ConversationState();
    s.receive(role: 'user', text: 'first', finalText: false);
    s.receive(role: 'user', text: 'first full', finalText: true);
    s.receive(role: 'user', text: 'second', finalText: false);
    s.receive(role: 'assistant', text: 'reply', finalText: true);
    s.receive(role: 'system', text: 'not visible', finalText: true);
    expect(s.messages.map((m) => m.text), ['first full', 'second', 'reply']);
    expect(() => s.messages.clear(), throwsUnsupportedError);
  });
}
