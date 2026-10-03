import '../protocol/wire.dart';

final class PersonalSnapshot {
  PersonalSnapshot(Map<String, dynamic> value)
    : revision = Wire.integer(value['revision']),
      data = Map.unmodifiable(value) {
    for (final key in ['life', 'conversations', 'memory', 'capabilities']) {
      if (value[key] != null && value[key] is! Map) {
        throw FormatException('Invalid $key');
      }
    }
    for (final key in [
      'tasks',
      'feed',
      'pending_approvals',
      'pending_confirmations',
    ]) {
      if (value[key] != null && value[key] is! List) {
        throw FormatException('Invalid $key');
      }
    }
  }
  final int revision;
  final Map<String, dynamic> data;
  Map<String, dynamic> object(String key) =>
      Map<String, dynamic>.from(data[key] as Map? ?? {});
  List<Map<String, dynamic>> rows(String key) => (data[key] as List? ?? [])
      .map((v) => Map<String, dynamic>.from(v as Map))
      .toList();
  String? get selectedId => object('conversations')['selected_id'] as String?;
}
