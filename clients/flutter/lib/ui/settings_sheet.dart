import 'package:flutter/material.dart';
import '../services/credentials.dart';
import '../services/enterprise_login.dart';
import '../services/pairing_flow.dart';
import '../protocol/pairing.dart';
import 'pairing_scanner.dart';
import 'strings.dart';
import '../connection/session.dart';

class SettingsSheet extends StatefulWidget {
  const SettingsSheet({
    super.key,
    required this.credential,
    required this.language,
    required this.media,
    required this.save,
    required this.forget,
    required this.configure,
    required this.session,
  });
  final Credential? credential;
  final Session session;
  final String language, media;
  final Future<void> Function(Credential) save;
  final Future<void> Function() forget;
  final Future<void> Function(String, String) configure;
  @override
  State<SettingsSheet> createState() => _SettingsSheetState();
}

class _SettingsSheetState extends State<SettingsSheet>
    with WidgetsBindingObserver {
  late final _server = TextEditingController(
    text: widget.credential?.server.toString(),
  );
  late final _token = TextEditingController(text: widget.credential?.token);
  late String _language = widget.language, _media = widget.media;
  bool _busy = false;
  int _attempt = 0;
  bool _browserLogin = false;
  bool get _locked =>
      _busy || widget.session.connected || widget.session.connecting;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    var previous = _server.text;
    _server.addListener(() {
      if (_server.text != previous) {
        previous = _server.text;
        _token.clear();
        _login?.cancel();
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused && !_browserLogin) {
      _attempt++;
      _pairing.cancel();
      if (mounted) setState(() => _busy = false);
    }
  }

  String _error = '';
  final _pairing = PairingFlow();
  static const _origin = String.fromEnvironment('NOVA_FEISHU_LOGIN_ORIGIN');
  late final _login = _origin.isEmpty ? null : EnterpriseLogin(origin: _origin);
  String t(String s) => tr(_language, s);
  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _attempt++;
    _pairing.cancel();
    _login?.cancel();
    _server.dispose();
    _token.dispose();
    super.dispose();
  }

  Future<void> _run(Future<Credential?> Function() obtain) async {
    if (_locked) return;
    final attempt = ++_attempt;
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final credential = await obtain();
      if (!mounted || attempt != _attempt || credential == null) return;
      await widget.configure(_language, _media);
      if (!mounted || attempt != _attempt) return;
      await widget.save(credential);
      if (mounted) Navigator.pop(context);
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<Credential?> _scan() async {
    final invitation = await Navigator.of(context).push<PairingCode>(
      MaterialPageRoute(builder: (_) => PairingScanner(language: _language)),
    );
    if (invitation == null || !mounted) return null;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(t('Pair with this host?')),
        content: Text(invitation.server.toString()),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(t('Cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(t('Pair')),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return null;
    return _pairing.redeem(invitation);
  }

  Widget group(List<Widget> children, {String? title, String? footer}) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 26),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (title != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: Text(
                  t(title),
                  style: const TextStyle(color: Colors.white54, fontSize: 13),
                ),
              ),
            Container(
              decoration: BoxDecoration(
                color: const Color(0xff2c2c2e),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: children,
              ),
            ),
            if (footer != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
                child: Text(
                  t(footer),
                  style: const TextStyle(color: Colors.white54, fontSize: 12),
                ),
              ),
          ],
        ),
      );

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: const Color(0xff1c1c1e),
    appBar: AppBar(
      automaticallyImplyLeading: false,
      backgroundColor: const Color(0xff1c1c1e),
      centerTitle: true,
      title: Text(
        t('Connection settings'),
        style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(t('Done')),
        ),
      ],
    ),
    body: SafeArea(
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 28, 20, 24),
        children: [
          group(
            [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: DropdownButtonFormField<String>(
                  initialValue: _language,
                  decoration: const InputDecoration(
                    labelText: '语言 / Language',
                    border: InputBorder.none,
                  ),
                  items: const [
                    DropdownMenuItem(value: 'en', child: Text('English')),
                    DropdownMenuItem(value: 'zh', child: Text('简体中文')),
                  ],
                  onChanged: _locked
                      ? null
                      : (value) async {
                          if (value == null) return;
                          setState(() => _language = value);
                          await widget.configure(_language, _media);
                        },
                ),
              ),
            ],
            footer:
                'The first launch follows your system language. Disconnect before changing it.\n\nThe AI prompt language applies on the next supported host connection; it does not change the voice model or guarantee the reply language.',
          ),
          group([
            TextButton(
              onPressed: _locked || _login == null
                  ? null
                  : () => _run(() async {
                      if (!await _login.health()) {
                        throw const FormatException(
                          'Login service unavailable',
                        );
                      }
                      try {
                        _browserLogin = true;
                        return await _login.start();
                      } finally {
                        _browserLogin = false;
                      }
                    }),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(t('Feishu login')),
              ),
            ),
            if (_login == null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                child: Text(
                  t('This build has no login service configured'),
                  style: const TextStyle(fontSize: 12),
                ),
              ),
          ], footer: 'Enabled when a deployment configures a login service.'),
          group(
            [
              TextButton.icon(
                onPressed: _locked ? null : () => _run(_scan),
                icon: const Icon(Icons.qr_code_scanner),
                label: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(t('Scan pairing code')),
                ),
              ),
            ],
            footer:
                'Scan the Nova QR code on your host to fill the address and securely save the connection.',
          ),
          group(
            [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: TextField(
                  controller: _server,
                  enabled: !_locked,
                  autocorrect: false,
                  decoration: InputDecoration(
                    labelText: t('Server'),
                    hintText: 'wss://host/client/v1',
                    border: InputBorder.none,
                  ),
                ),
              ),
              const Divider(height: 1, indent: 16),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: TextField(
                  controller: _token,
                  enabled: !_locked,
                  obscureText: true,
                  autocorrect: false,
                  enableSuggestions: false,
                  decoration: InputDecoration(
                    labelText: t('Token'),
                    border: InputBorder.none,
                  ),
                ),
              ),
              const Divider(height: 1, indent: 16),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: DropdownButtonFormField<String>(
                  initialValue: _media,
                  decoration: InputDecoration(
                    labelText: t('Media transport'),
                    border: InputBorder.none,
                  ),
                  items: [
                    for (final v in ['auto', 'relay', 'aoq'])
                      DropdownMenuItem(
                        value: v,
                        child: Text(
                          v == 'auto'
                              ? t('Auto')
                              : v == 'relay'
                              ? t('Relay')
                              : 'AOQ',
                        ),
                      ),
                  ],
                  onChanged: _locked
                      ? null
                      : (v) async {
                          if (v == null) return;
                          setState(() => _media = v);
                          await widget.configure(_language, _media);
                        },
                ),
              ),
            ],
            title: 'Manual connection',
            footer: 'The connection token is stored securely on this device.',
          ),
          group([
            Slider(
              value: widget.session.speechThreshold,
              min: .01,
              max: .15,
              label: widget.session.speechThreshold.toStringAsFixed(3),
              onChanged: (v) =>
                  setState(() => widget.session.speechThreshold = v),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              child: Text(
                '${t('Raise in noisy environments; lower for quiet speech.')} ${widget.session.speechThreshold.toStringAsFixed(3)}',
                style: const TextStyle(color: Colors.white54, fontSize: 12),
              ),
            ),
          ], title: 'Speech detection threshold'),
          if (widget.session.connected || widget.session.connecting)
            TextButton(
              onPressed: () async {
                await widget.session.end();
                if (mounted) setState(() {});
              },
              child: Text(t('Disconnect')),
            ),
          FilledButton(
            onPressed: _locked
                ? null
                : () => _run(
                    () async => Credential(
                      Uri.parse(_server.text.trim()),
                      _token.text.trim(),
                    ),
                  ),
            child: Text(t('Save and connect')),
          ),
          TextButton(
            onPressed: _locked
                ? null
                : () async {
                    await widget.forget();
                    if (context.mounted) Navigator.pop(context);
                  },
            child: Text(t('Forget connection')),
          ),
          if (_busy) const LinearProgressIndicator(),
          if (_error.isNotEmpty)
            Text(_error, style: const TextStyle(color: Colors.orangeAccent)),
        ],
      ),
    ),
  );
}
