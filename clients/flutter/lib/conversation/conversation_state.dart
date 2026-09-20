final class ChatMessage {
  const ChatMessage(this.id, this.role, this.text, this.finalText);
  final String id, role, text;
  final bool finalText;
}

final class ConversationState {
  final _messages = <ChatMessage>[];
  int _serial = 0;
  List<ChatMessage> get messages => List.unmodifiable(_messages);
  void clear() => _messages.clear();
  void receive({
    required String role,
    required String text,
    required bool finalText,
    String? id,
  }) {
    if (text.isEmpty || !['user', 'assistant'].contains(role)) return;
    final index = id == null ? -1 : _messages.indexWhere((m) => m.id == id);
    if (index >= 0) {
      final previous = _messages[index];
      if (previous.finalText && !finalText) return;
      _messages[index] = ChatMessage(
        previous.id,
        previous.role,
        text,
        finalText,
      );
    } else if (id == null &&
        _messages.isNotEmpty &&
        _messages.last.role == role &&
        !_messages.last.finalText) {
      _messages[_messages.length - 1] = ChatMessage(
        _messages.last.id,
        role,
        text,
        finalText,
      );
    } else {
      _messages.add(
        ChatMessage(id ?? 'local-${_serial++}', role, text, finalText),
      );
    }
  }
}
