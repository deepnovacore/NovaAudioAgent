import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/services/enterprise_login.dart';

void main() {
  test('callback rejects duplicate state and foreign authority', () {
    final code = 'a' * 43;
    for (final url in [
      'nova-sso://callback?state=s&state=s&code=$code',
      'nova-sso://other?state=s&code=$code',
      'https://callback?state=s&code=$code',
    ]) {
      expect(
        () => EnterpriseSSO.callback(Uri.parse(url), state: 's'),
        throwsFormatException,
      );
    }
    expect(
      EnterpriseSSO.callback(
        Uri.parse('nova-sso://callback?state=s&code=$code'),
        state: 's',
      ),
      code,
    );
  });
  test('PKCE matches RFC 7636 vector', () {
    expect(
      EnterpriseSSO.challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
  test('origin rejects ports credentials paths and queries', () {
    for (final s in [
      'http://example.com',
      'https://example.com:443',
      'https://user@example.com',
      'https://example.com/path',
      'https://example.com?q=a',
    ]) {
      expect(() => EnterpriseSSO.origin(s), throwsFormatException);
    }
  });
  test('exchange binds server and expiry', () {
    Uint8List data(String server, int expires) => Uint8List.fromList(
      utf8.encode(
        jsonEncode({
          'server': server,
          'token': 'a' * 32,
          'expires_at': expires,
        }),
      ),
    );
    expect(
      () => EnterpriseSSO.credential(
        data('wss://other.example/client/v1', 9999999999999),
        origin: 'https://example.com',
      ),
      throwsFormatException,
    );
    expect(
      () => EnterpriseSSO.credential(
        data('wss://example.com/client/v1', 1),
        origin: 'https://example.com',
      ),
      throwsFormatException,
    );
  });
  test('cancelled browser callback cannot exchange credentials', () async {
    final callback = Completer<String>();
    var exchanged = false;
    final login = EnterpriseLogin(
      origin: 'https://example.com',
      browse: (url) => callback.future,
      exchange: (url, body) async {
        exchanged = true;
        return Uint8List(0);
      },
    );
    final pending = login.start();
    login.cancel();
    callback.complete('nova-sso://callback?state=bad&code=${'a' * 43}');
    expect(await pending, isNull);
    expect(exchanged, isFalse);
  });
}
