import 'package:shared_preferences/shared_preferences.dart';

final class Preferences {
  Preferences(this.storage);
  final SharedPreferences storage;
  String get server => storage.getString('server') ?? '';
  String get media => storage.getString('media') ?? 'auto';
  String language(String system) =>
      storage.getString('language') ?? (system.startsWith('zh') ? 'zh' : 'en');
  Future<void> save({
    required String server,
    required String media,
    required String language,
  }) async {
    await storage.setString('server', server);
    await storage.setString('media', media);
    await storage.setString('language', language);
  }
}
