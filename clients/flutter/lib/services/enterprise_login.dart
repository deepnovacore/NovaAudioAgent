import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import '../protocol/wire.dart';
import 'credentials.dart';

abstract final class EnterpriseSSO {
  static Uri origin(String text) {
    final uri = Uri.parse(text);
    if (uri.scheme != 'https' ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        // Uri normalizes an explicit default port; inspect the authority as well.
        uri.authority != uri.host ||
        RegExp(r'^https://[^/]*:').hasMatch(text) ||
        uri.hasQuery ||
        uri.hasFragment ||
        (uri.path.isNotEmpty && uri.path != '/')) {
      throw const FormatException('Login service must be a bare HTTPS origin');
    }
    return Uri(scheme: 'https', host: uri.host);
  }

  static String random() => base64UrlEncode(
    List<int>.generate(32, (_) => Random.secure().nextInt(256)),
  ).replaceAll('=', '');
  static String challenge(String verifier) => base64UrlEncode(
    sha256.convert(utf8.encode(verifier)).bytes,
  ).replaceAll('=', '');
  static String callback(Uri uri, {required String state}) {
    final query = uri.queryParametersAll;
    if (utf8.encode(uri.toString()).length > 2048 ||
        uri.scheme != 'nova-sso' ||
        uri.authority != 'callback' ||
        uri.hasFragment ||
        (uri.path.isNotEmpty && uri.path != '/') ||
        query.length != 2 ||
        query['state']?.length != 1 ||
        query['state']!.single != state ||
        query['code']?.length != 1 ||
        !RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(query['code']!.single)) {
      throw const FormatException('Invalid login callback');
    }
    return query['code']!.single;
  }

  static Credential credential(Uint8List bytes, {required String origin}) {
    final data = Wire.json(bytes, limit: 4096);
    final result = Credential.fromJson(data);
    final expected = EnterpriseSSO.origin(
      origin,
    ).replace(scheme: 'wss', path: '/client/v1');
    if (result.server != expected ||
        result.expiresAt == null ||
        result.expired) {
      throw const FormatException('Invalid or expired login credential');
    }
    return result;
  }
}

/// No redirects or unbounded buffering, including for read-only health probes.
final class EnterpriseHTTP {
  static Future<Uint8List> request(
    Uri uri, {
    Map<String, Object>? body,
    int limit = 4096,
  }) async {
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 10);
    try {
      return await (() async {
        final request = await client.openUrl(
          body == null ? 'GET' : 'POST',
          uri,
        );
        request.followRedirects = false;
        if (body != null) {
          request.headers.contentType = ContentType.json;
          request.write(jsonEncode(body));
        }
        final response = await request.close();
        if (response.statusCode != 200 || response.contentLength > limit) {
          throw const FormatException('Invalid login service response');
        }
        final bytes = BytesBuilder(copy: false);
        await for (final chunk in response) {
          if (bytes.length + chunk.length > limit) {
            throw const FormatException('Login response too large');
          }
          bytes.add(chunk);
        }
        return bytes.takeBytes();
      })().timeout(Duration(seconds: body == null ? 10 : 60));
    } finally {
      client.close(force: true);
    }
  }
}

final class EnterpriseLogin {
  EnterpriseLogin({
    required this.origin,
    Future<String> Function(Uri)? browse,
    Future<Uint8List> Function(Uri, Map<String, Object>)? exchange,
  }) : _browse =
           browse ??
           ((uri) => FlutterWebAuth2.authenticate(
             url: uri.toString(),
             callbackUrlScheme: 'nova-sso',
           )),
       _exchange =
           exchange ?? ((uri, body) => EnterpriseHTTP.request(uri, body: body));
  final String origin;
  final Future<String> Function(Uri) _browse;
  final Future<Uint8List> Function(Uri, Map<String, Object>) _exchange;
  int _generation = 0;
  void cancel() {
    _generation++;
  }

  Future<bool> health() async {
    final uri = EnterpriseSSO.origin(origin).replace(path: '/nova/health');
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        return Wire.json(
              await EnterpriseHTTP.request(uri, limit: 1024),
              limit: 1024,
            )['available'] ==
            true;
      } catch (_) {
        if (attempt == 2) rethrow;
        await Future<void>.delayed(const Duration(seconds: 1));
      }
    }
    return false;
  }

  Future<Credential?> start() async {
    final generation = ++_generation;
    final base = EnterpriseSSO.origin(origin);
    final state = EnterpriseSSO.random();
    final verifier = EnterpriseSSO.random();
    try {
      return await (() async {
        final response = await _browse(
          base.replace(
            path: '/auth/nova/start',
            queryParameters: {
              'state': state,
              'code_challenge': EnterpriseSSO.challenge(verifier),
            },
          ),
        );
        if (generation != _generation) return null;
        final code = EnterpriseSSO.callback(Uri.parse(response), state: state);
        final bytes = await _exchange(base.replace(path: '/nova/exchange'), {
          'code': code,
          'code_verifier': verifier,
          'device_name': 'Nova mobile',
        });
        if (generation != _generation) return null;
        return EnterpriseSSO.credential(bytes, origin: origin);
      })().timeout(const Duration(minutes: 5));
    } finally {
      if (generation == _generation) _generation++;
    }
  }
}
