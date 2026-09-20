import 'dart:async';
import 'package:flutter/material.dart';
import 'package:nova_audio/channel_audio.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../connection/session.dart';
import '../conversation/controller.dart';
import '../services/credentials.dart';
import '../services/preferences.dart';
import 'settings_sheet.dart';
import 'strings.dart';
import 'voice_orb.dart';

const ink = Color.fromRGBO(9, 14, 20, 1),
    mint = Color.fromRGBO(148, 235, 217, 1);

class NovaApp extends StatelessWidget {
  const NovaApp({super.key, this.session, this.store, this.preferences});
  final Session? session;
  final CredentialStore? store;
  final Preferences? preferences;
  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      brightness: Brightness.dark,
      scaffoldBackgroundColor: ink,
      colorScheme: ColorScheme.fromSeed(
        seedColor: mint,
        brightness: Brightness.dark,
        primary: mint,
        surface: ink,
      ),
      useMaterial3: true,
    ),
    home: ConversationScreen(
      session: session,
      store: store,
      preferences: preferences,
    ),
  );
}

class ConversationScreen extends StatefulWidget {
  const ConversationScreen({
    super.key,
    this.session,
    this.store,
    this.preferences,
  });
  final Session? session;
  final CredentialStore? store;
  final Preferences? preferences;
  @override
  State<ConversationScreen> createState() => _ConversationScreenState();
}

class _ConversationScreenState extends State<ConversationScreen>
    with WidgetsBindingObserver {
  late final Session _session;
  late final ConversationController _model;
  late final CredentialStore _store;
  Preferences? _preferences;
  Credential? _credential;
  final _draft = TextEditingController(), _scroll = ScrollController();
  Timer? _clock;
  bool _textMode = false, _dictationMode = false;
  String? _error;
  int _revision = 0;
  String t(String text) => tr(_session.language, text);
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (widget.session != null) {
      _session = widget.session!;
    } else {
      final audio = ChannelAudio();
      _session = Session(
        audio: audio,
        requestMicrophone: audio.requestMicrophone,
      );
    }
    _store = widget.store ?? SecureCredentialStore();
    _model = ConversationController(_session)..addListener(_changed);
    _draft.addListener(() {
      _model.input.draft = _draft.text;
      if (mounted) setState(() {});
    });
    _clock = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && _model.approvals.cards.isNotEmpty) setState(() {});
    });
    unawaited(_restore());
  }

  Future<void> _restore() async {
    try {
      final preferences =
          widget.preferences ??
          Preferences(await SharedPreferences.getInstance());
      final credential = await _store.read();
      if (!mounted) return;
      _preferences = preferences;
      _credential = credential;
      _session.language = preferences.language(
        WidgetsBinding.instance.platformDispatcher.locale.languageCode,
      );
      _session.mediaPreference = preferences.media;
      setState(() {});
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    }
  }

  void _changed() {
    if (!mounted) return;
    if (_draft.text != _model.input.draft) {
      _draft.value = TextEditingValue(
        text: _model.input.draft,
        selection: TextSelection.collapsed(offset: _model.input.draft.length),
      );
    }
    if (!_session.editableInput) _textMode = false;
    setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _session.resumeForeground();
    } else if (state == AppLifecycleState.paused) {
      _revision++;
      unawaited(_session.background());
    } else if (state == AppLifecycleState.inactive) {
      unawaited(_model.input.cancelDictation());
      if (_session.voice || _session.voiceStarting) {
        unawaited(_session.stopCapture());
      }
    }
  }

  Future<void> _settings() async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => SettingsSheet(
          session: _session,
          credential: _credential,
          language: _session.language,
          media: _session.mediaPreference,
          configure: (language, media) async {
            _session.language = language;
            _session.mediaPreference = media;
            await _preferences?.save(
              server: _credential?.server.toString() ?? '',
              media: media,
              language: language,
            );
          },
          save: (credential) async {
            final revision = ++_revision;
            await _session.end();
            await _store.write(credential);
            if (!mounted || revision != _revision || !_session.foreground) {
              return;
            }
            _credential = credential;
            _model.transcript.clear();
            await _session.connect(credential.server, credential.token);
          },
          forget: () async {
            ++_revision;
            await _session.end();
            await _store.clear();
            _credential = null;
            _model.transcript.clear();
          },
        ),
      ),
    );
    if (mounted) setState(() {});
  }

  Future<void> _connect() async {
    if (_credential == null || _credential!.expired) {
      await _settings();
      return;
    }
    await _session.connect(_credential!.server, _credential!.token);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _clock?.cancel();
    _model.removeListener(_changed);
    _model.dispose();
    if (widget.session == null) _session.dispose();
    _draft.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final input = _model.input;
    final messages = _model.transcript.messages;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 12, 16, 8),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'NOVA',
                          style: TextStyle(
                            fontSize: 22,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 5,
                          ),
                        ),
                        Text(
                          t(_session.status),
                          key: const Key('connection-status'),
                          style: TextStyle(
                            color: _session.connected ? mint : Colors.white54,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    onPressed: _settings,
                    tooltip: t('Settings'),
                    icon: const Icon(Icons.tune),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
              child: SegmentedButton<bool>(
                segments: [
                  if (_session.editableInput)
                    ButtonSegment(value: true, label: Text(t('Text chat'))),
                  ButtonSegment(
                    value: false,
                    label: Text(t('Live conversation')),
                  ),
                ],
                selected: {_textMode},
                onSelectionChanged: (selected) async {
                  final text = selected.single;
                  if (text) {
                    await _model.switchToText();
                  } else {
                    await _model.switchToVoice();
                  }
                  if (mounted) setState(() => _textMode = text);
                },
              ),
            ),
            Expanded(
              child: ListView(
                controller: _scroll,
                padding: const EdgeInsets.all(24),
                children: [
                  if (!_textMode)
                    Center(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 32),
                        child: Semantics(
                          label: t(
                            _session.voice ? 'Listening' : 'Live conversation',
                          ),
                          child: VoiceOrb(
                            listening: _session.voice,
                            level: _session.inputLevel,
                          ),
                        ),
                      ),
                    ),
                  if (messages.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 24),
                      child: Text(
                        t(
                          _session.connected
                              ? 'Your conversation appears here'
                              : 'Connect to your Nova host to begin',
                        ),
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Colors.white54),
                      ),
                    ),
                  for (final message in messages)
                    Container(
                      margin: const EdgeInsets.only(bottom: 18),
                      padding: const EdgeInsets.all(18),
                      decoration: BoxDecoration(
                        color: message.role == 'user'
                            ? mint.withValues(alpha: 0.10)
                            : Colors.white.withValues(alpha: 0.035),
                        borderRadius: BorderRadius.circular(18),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            message.role == 'user' ? t('You') : 'Nova',
                            style: const TextStyle(
                              color: Colors.white54,
                              fontSize: 12,
                            ),
                          ),
                          const SizedBox(height: 8),
                          SelectableText(message.text),
                        ],
                      ),
                    ),
                  if (_model.approvals.cards.isNotEmpty)
                    Text(
                      t('Needs your confirmation'),
                      style: const TextStyle(
                        color: mint,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  for (final card in _model.approvals.cards)
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              card.project,
                              style: const TextStyle(color: Colors.white54),
                            ),
                            Text(
                              card.title,
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                            SelectableText(card.detail),
                            if (!card.actionable(DateTime.now()))
                              Text(t('Expired / waiting for host')),
                            Wrap(
                              spacing: 8,
                              children: [
                                for (final decision in card.decisions)
                                  OutlinedButton(
                                    onPressed:
                                        _session.connected &&
                                            card.actionable(DateTime.now()) &&
                                            !_model.approvals.submitted
                                                .contains(card.id)
                                        ? () => _model.decide(card, decision)
                                        : null,
                                    child: Text(
                                      t(
                                        decision == 'decline'
                                            ? 'Decline'
                                            : decision == 'acceptForSession'
                                            ? 'Approve for session'
                                            : 'Approve',
                                      ),
                                    ),
                                  ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ),
                  if (_model.tasks.isNotEmpty) Text(t('Tasks')),
                  for (final entry in _model.tasks.entries)
                    ListTile(
                      title: Text(entry.key),
                      subtitle: Text(entry.value),
                    ),
                  if (_model.results.isNotEmpty) Text(t('Results')),
                  for (final result in _model.results.values)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: SelectableText(result),
                    ),
                  if (_error != null)
                    Text(
                      _error!,
                      style: const TextStyle(color: Colors.orangeAccent),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 8, 24, 16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (_textMode &&
                      _session.editableInput &&
                      !_session.voice) ...[
                    Row(
                      children: [
                        IconButton(
                          onPressed: input.busy
                              ? null
                              : () => setState(
                                  () => _dictationMode = !_dictationMode,
                                ),
                          tooltip: t('Voice recognition'),
                          icon: Icon(
                            _dictationMode ? Icons.keyboard : Icons.mic,
                          ),
                        ),
                        Expanded(
                          child: TextField(
                            controller: _draft,
                            minLines: 1,
                            maxLines: 3,
                            enabled: !input.recording && !input.transcribing,
                            decoration: InputDecoration(
                              hintText: t('Type a message…'),
                              filled: true,
                              border: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(14),
                              ),
                            ),
                          ),
                        ),
                        IconButton(
                          onPressed:
                              input.busy ||
                                  _draft.text.trim().isEmpty ||
                                  _draft.text.trim().length > 4000
                              ? null
                              : input.sendDraft,
                          tooltip: t('Send message'),
                          icon: const Icon(Icons.arrow_upward, color: mint),
                        ),
                      ],
                    ),
                    if (_dictationMode)
                      Semantics(
                        button: true,
                        label: t(
                          input.recording
                              ? 'Release to transcribe'
                              : 'Hold to speak',
                        ),
                        onTap: input.recording
                            ? input.finishDictation
                            : input.beginDictation,
                        child: GestureDetector(
                          onLongPressStart: (_) => input.beginDictation(),
                          onLongPressEnd: (_) => input.finishDictation(),
                          onLongPressCancel: () => input.cancelDictation(),
                          child: Container(
                            width: double.infinity,
                            padding: const EdgeInsets.all(14),
                            margin: const EdgeInsets.only(top: 8),
                            decoration: BoxDecoration(
                              color: mint.withValues(alpha: 0.12),
                              borderRadius: BorderRadius.circular(24),
                            ),
                            child: Text(
                              t(
                                input.recording
                                    ? 'Release to transcribe'
                                    : 'Hold to speak',
                              ),
                              textAlign: TextAlign.center,
                            ),
                          ),
                        ),
                      ),
                    if (input.transcribing) Text(t('Transcribing…')),
                    if (input.recording || input.transcribing)
                      TextButton(
                        onPressed: input.cancelDictation,
                        child: Text(t('Cancel')),
                      ),
                    if (input.notice.isNotEmpty) Text(t(input.notice)),
                    if (_draft.text.length > 4000) Text(t('Message too long')),
                  ],
                  if (_session.voice || _session.voiceStarting)
                    Wrap(
                      alignment: WrapAlignment.center,
                      spacing: 20,
                      children: [
                        IconButton(
                          onPressed: _session.voiceStarting
                              ? null
                              : _session.toggleMute,
                          tooltip: t(_session.muted ? 'Unmute' : 'Mute'),
                          icon: Icon(
                            _session.muted ? Icons.mic_off : Icons.mic,
                          ),
                        ),
                        FilledButton(
                          onPressed: _session.end,
                          style: FilledButton.styleFrom(
                            backgroundColor: const Color(0xffc2474c),
                          ),
                          child: Text(t('End call')),
                        ),
                        IconButton(
                          onPressed: _session.voiceStarting
                              ? null
                              : _session.toggleSpeaker,
                          tooltip: t('Speaker'),
                          isSelected: _session.speaker,
                          icon: const Icon(Icons.volume_up),
                        ),
                      ],
                    )
                  else if (!_textMode || !_session.connected)
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton.icon(
                        key: Key(
                          _session.connected ? 'start-voice' : 'connect',
                        ),
                        onPressed: _session.connecting || input.busy
                            ? null
                            : _session.connected
                            ? _model.startVoice
                            : _connect,
                        icon: Icon(_session.connected ? Icons.mic : Icons.link),
                        label: Padding(
                          padding: const EdgeInsets.all(14),
                          child: Text(
                            t(
                              _session.connected
                                  ? 'Start conversation'
                                  : 'Connect',
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
