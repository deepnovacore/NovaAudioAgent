import 'personal_store.dart';

extension PersonalCommands on PersonalStore {
  Future<dynamic> mutate(Map<String, dynamic> params) =>
      command('life.mutate', params);
  Future<dynamic> selectConversation(String id) =>
      command('conversations.select', {'id': id});
  Future<dynamic> createConversation() => command('conversations.create');
  Future<dynamic> updateItem(
    Map<String, dynamic> item,
    Map<String, dynamic> changes,
  ) => mutate({
    'op': 'update',
    'kind': item['kind'],
    'id': item['id'],
    'expected_version': item['version'],
    ...changes,
  });
}
