import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:nova_audio/channel_audio.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../connection/session.dart';
import '../conversation/controller.dart';
import '../services/credentials.dart';
import '../services/preferences.dart';
import 'settings_sheet.dart';
import 'strings.dart';
import 'voice_orb.dart';
import 'assistant_text.dart';
import 'workbench_page.dart';

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
    home: _WorkbenchShell(
      session: session,
      store: store,
      preferences: preferences,
    ),
  );
}

class _WorkbenchShell extends StatefulWidget {
  const _WorkbenchShell({this.session, this.store, this.preferences});
  final Session? session;
  final CredentialStore? store;
  final Preferences? preferences;
  @override
  State<_WorkbenchShell> createState() => _WorkbenchShellState();
}

class _WorkbenchShellState extends State<_WorkbenchShell> {
  late final Session session;
  final conversation = GlobalKey<_ConversationScreenState>();
  int tab = 0;
  bool _sheet = false;
  final _shown = <String>{};
  StreamSubscription<void>? _resets;
  @override
  void initState() {
    super.initState();
    final audio = ChannelAudio();
    session =
        widget.session ??
        Session(audio: audio, requestMicrophone: audio.requestMicrophone);
    session.addListener(_changed);
    _resets = session.resets.listen((_) {
      _shown.clear();
    });
  }

  void _changed() {
    if (!mounted) return;
    setState(() {});
    final snapshot = session.personal.snapshot;
    final pending = [
      ...?(snapshot?.rows('pending_approvals')),
      ...?(snapshot?.rows('pending_confirmations')),
    ];
    _shown.retainAll(
      pending
          .map((r) => r['approval_id'] ?? r['proposal_id'])
          .whereType<String>(),
    );
    if (_sheet || !session.connected || !session.foreground) return;
    for (final row in pending) {
      final id = (row['approval_id'] ?? row['proposal_id']) as String?;
      if (id == null ||
          _shown.contains(id) ||
          row['queued'] == true ||
          row['busy'] == true) {
        continue;
      }
      _shown.add(id);
      _sheet = true;
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        if (!mounted) {
          _sheet = false;
          return;
        }
        final confirm = row['proposal_id'] != null;
        final conversationId = row['conversation_id'];
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || !session.foreground || !_sheet) return;
          unawaited(
            session.personal
                .command('presentation.seen', {
                  if (confirm) 'proposal_id': id else 'approval_id': id,
                  'conversation_id': ?conversationId,
                })
                .catchError((Object _) => null),
          );
        });
        final decisionPending = ValueNotifier(false);
        bool closing = false;
        await showModalBottomSheet<void>(
          context: context,
          isScrollControlled: true,
          useSafeArea: true,
          builder: (sheetContext) => ListenableBuilder(
            listenable: Listenable.merge([
              session,
              decisionPending,
              if (conversation.currentState != null)
                conversation.currentState!._model,
            ]),
            builder: (context, _) {
              final rows =
                  session.personal.snapshot?.rows(
                    confirm ? 'pending_confirmations' : 'pending_approvals',
                  ) ??
                  [];
              final current = rows
                  .where((r) => (r['approval_id'] ?? r['proposal_id']) == id)
                  .firstOrNull;
              if (current == null && !closing) {
                closing = true;
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  if (sheetContext.mounted) Navigator.pop(sheetContext);
                });
              }
              final model = conversation.currentState?._model;
              final card = model?.approvals.cards
                  .where((c) => c.id == id)
                  .firstOrNull;
              final decisions = conversationId != null
                  ? ['decline', 'accept']
                  : (card?.decisions ?? <String>[]);
              final enabled =
                  !decisionPending.value &&
                  session.connected &&
                  current != null &&
                  current['queued'] != true &&
                  current['busy'] != true &&
                  (conversationId != null ||
                      (card != null &&
                          card.actionable(DateTime.now()) &&
                          !model!.approvals.submitted.contains(id)));
              Future<void> decide(String decision) async {
                final allow = decision != 'decline';
                if (decisionPending.value) return;
                decisionPending.value = true;
                try {
                  if (conversationId != null) {
                    await session.personal.command(
                      confirm
                          ? 'conversations.confirm'
                          : 'conversations.approve',
                      {
                        'id': conversationId,
                        if (confirm) 'proposal_id': id else 'approval_id': id,
                        if (confirm) 'confirmed': allow else 'approved': allow,
                      },
                    );
                  } else {
                    if (card == null || model?.decide(card, decision) != true) {
                      throw StateError(
                        'Approval could not be sent. Check connection and retry.',
                      );
                    }
                  }
                  if (sheetContext.mounted && !closing) {
                    closing = true;
                    Navigator.pop(sheetContext);
                  }
                } catch (error) {
                  if (sheetContext.mounted) {
                    decisionPending.value = false;
                    ScaffoldMessenger.of(
                      sheetContext,
                    ).showSnackBar(SnackBar(content: Text(error.toString())));
                  }
                }
              }

              return Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Needs your confirmation',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 12),
                    SelectableText('${row['summary'] ?? ''}'),
                    if (conversationId != null)
                      Text('Conversation: $conversationId'),
                    if (!enabled) const Text('Waiting for host update'),
                    const SizedBox(height: 16),
                    Wrap(
                      spacing: 12,
                      children: [
                        for (final decision in decisions)
                          FilledButton(
                            onPressed: enabled ? () => decide(decision) : null,
                            child: Text(
                              decision == 'decline'
                                  ? 'Decline'
                                  : decision == 'acceptForSession'
                                  ? 'Approve for session'
                                  : 'Approve',
                            ),
                          ),
                      ],
                    ),
                  ],
                ),
              );
            },
          ),
        );
        decisionPending.dispose();
        _sheet = false;
        if (mounted) _changed();
      });
      break;
    }
  }

  @override
  void dispose() {
    session.removeListener(_changed);
    _resets?.cancel();
    if (widget.session == null) session.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final unread =
        session.personal.snapshot?.object('conversations')['unread_count']
            as int? ??
        0;
    return Scaffold(
      body: Column(
        children: [
          if ((session.personal.snapshot?.rows('pending_approvals').length ??
                      0) +
                  (session.personal.snapshot
                          ?.rows('pending_confirmations')
                          .length ??
                      0) >
              0)
            SafeArea(
              bottom: false,
              child: TextButton.icon(
                onPressed: () {
                  _shown.clear();
                  _changed();
                },
                icon: const Icon(Icons.pending_actions),
                label: const Text('Pending confirmations'),
              ),
            ),
          Expanded(
            child: IndexedStack(
              index: tab,
              children: [
                ConversationScreen(
                  key: conversation,
                  session: session,
                  store: widget.store,
                  preferences: widget.preferences,
                  active: tab == 0,
                ),
                for (final page in [1, 2, 3])
                  SafeArea(
                    child: tab == page
                        ? WorkbenchPage(
                            key: ValueKey(page),
                            store: session.personal,
                            page: page,
                            onOpenConversation: () => setState(() => tab = 0),
                            onSettings: () =>
                                conversation.currentState?._settings(),
                          )
                        : const SizedBox(),
                  ),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: tab,
        onDestinationSelected: (index) => setState(() => tab = index),
        destinations: [
          NavigationDestination(
            icon: Badge(
              isLabelVisible: unread > 0,
              label: Text('$unread'),
              child: const Icon(Icons.chat_bubble_outline),
            ),
            label: 'Nova',
          ),
          const NavigationDestination(
            icon: Icon(Icons.today_outlined),
            label: 'Today',
          ),
          const NavigationDestination(
            icon: Icon(Icons.checklist),
            label: 'Plan',
          ),
          const NavigationDestination(
            icon: Icon(Icons.person_outline),
            label: 'Me',
          ),
        ],
      ),
    );
  }
}

class ConversationScreen extends StatefulWidget {
  const ConversationScreen({
    super.key,
    this.session,
    this.store,
    this.preferences,
    this.active = true,
  });
  final bool active;
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
  final _latestUser = GlobalKey();
  int _messageCount = 0;
  bool _textMode = false, _dictationMode = false;
  String? _error;
  int _revision = 0;
  final _readMessages = <String>{};
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
    _scroll.addListener(_markVisibleRead);
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
      if (credential != null && !credential.expired && _session.foreground) {
        await _session.connect(credential.server, credential.token);
      }
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    }
  }

  @override
  void didUpdateWidget(covariant ConversationScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active && !oldWidget.active) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _markVisibleRead());
    }
  }

  void _markVisibleRead() {
    if (!mounted ||
        !widget.active ||
        !_session.foreground ||
        !_session.connected ||
        ModalRoute.of(context)?.isCurrent != true ||
        !_scroll.hasClients ||
        _scroll.position.extentAfter > 24) {
      return;
    }
    final snapshot = _session.personal.snapshot,
        data = snapshot?.object('conversations');
    final selected = snapshot?.selectedId;
    final items = data?['items'] as List? ?? [];
    final item = items
        .whereType<Map>()
        .where((r) => r['id'] == selected)
        .firstOrNull;
    if ((item?['unread_count'] as int? ?? 0) == 0) return;
    final rows = data?['messages'] as List? ?? [];
    final last = rows
        .whereType<Map>()
        .where((r) => r['conversation_id'] == selected)
        .lastOrNull;
    final id = last?['id'] as String?;
    if (id == null || !_readMessages.add(id)) return;
    _session.personal
        .command('conversations.read', {
          'id': selected,
          'through_message_id': id,
        })
        .catchError((Object _) {
          _readMessages.remove(id);
          return null;
        });
  }

  void _changed() {
    if (!mounted) return;
    WidgetsBinding.instance.addPostFrameCallback((_) => _markVisibleRead());
    if (_session.credentialRevoked && _credential != null) {
      _credential = null;
      unawaited(_store.clear());
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(_settings());
      });
    }
    if (_draft.text != _model.input.draft) {
      _draft.value = TextEditingValue(
        text: _model.input.draft,
        selection: TextSelection.collapsed(offset: _model.input.draft.length),
      );
    }
    if (!_session.editableInput) _textMode = false;
    final messages = _model.transcript.messages;
    final newUser =
        messages.length != _messageCount &&
        messages.isNotEmpty &&
        messages.last.role == 'user';
    _messageCount = messages.length;
    setState(() {});
    if (newUser) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final target = _latestUser.currentContext;
        if (mounted && target != null) {
          Scrollable.ensureVisible(
            target,
            duration: MediaQuery.disableAnimationsOf(context)
                ? Duration.zero
                : const Duration(milliseconds: 250),
          );
        }
      });
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _session.resumeForeground();
      if (_credential != null &&
          !_session.connected &&
          !_session.credentialRevoked) {
        unawaited(_connect());
      }
    } else if (state == AppLifecycleState.paused) {
      _revision++;
      unawaited(_session.background());
    } else if (state == AppLifecycleState.inactive) {
      unawaited(_model.input.cancelDictation());
      unawaited(_session.inactive());
    }
  }

  Future<void> _settings() async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      clipBehavior: Clip.antiAlias,
      backgroundColor: const Color(0xff1c1c1e),
      builder: (_) => FractionallySizedBox(
        heightFactor: .92,
        child: SettingsSheet(
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
            final previous = _credential;
            if (previous != null &&
                (previous.server != credential.server ||
                    previous.token != credential.token)) {
              await _session.forgetPersonal(
                cacheScope: '${previous.server}#${previous.token}',
              );
            }
            await _store.write(credential);
            if (!mounted || revision != _revision) return;
            _credential = credential;
            _model.transcript.clear();
            if (!_session.foreground) return;
            await _session.connect(credential.server, credential.token);
          },
          forget: () async {
            ++_revision;
            await _session.end();
            await _store.clear();
            await _session.forgetPersonal(
              cacheScope: _credential == null
                  ? null
                  : '${_credential!.server}#${_credential!.token}',
            );
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
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
              child: Row(
                children: [
                  const Expanded(
                    child: Text(
                      'Nova',
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w600,
                        letterSpacing: -.6,
                      ),
                    ),
                  ),
                  Tooltip(
                    message: t('Settings'),
                    child: TextButton(
                      onPressed: _settings,
                      style: TextButton.styleFrom(
                        backgroundColor: Colors.white.withValues(alpha: .055),
                        minimumSize: const Size(58, 44),
                        shape: StadiumBorder(
                          side: BorderSide(
                            color: Colors.white.withValues(alpha: .09),
                          ),
                        ),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.circle,
                            size: 6,
                            color: _session.connected ? mint : Colors.white38,
                          ),
                          const SizedBox(width: 7),
                          const Icon(
                            CupertinoIcons.slider_horizontal_3,
                            size: 16,
                            color: Colors.white70,
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 12),
              child: SizedBox(
                width: double.infinity,
                child: _session.editableInput
                    ? CupertinoSlidingSegmentedControl<bool>(
                        groupValue: _textMode,
                        backgroundColor: const Color(0xff292b30),
                        thumbColor: const Color(0xff62646b),
                        children: {
                          true: Text(t('Text chat')),
                          false: Text(t('Live conversation')),
                        },
                        onValueChanged: (text) async {
                          if (text == null) return;
                          if (text) {
                            await _model.switchToText();
                          } else {
                            await _model.switchToVoice();
                          }
                          if (mounted) setState(() => _textMode = text);
                        },
                      )
                    : Container(
                        padding: const EdgeInsets.symmetric(vertical: 5),
                        decoration: BoxDecoration(
                          color: const Color(0xff62646b),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(
                          t('Live conversation'),
                          textAlign: TextAlign.center,
                          style: const TextStyle(fontSize: 13),
                        ),
                      ),
              ),
            ),
            if (_session.personal.snapshot != null)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: Row(
                  children: [
                    Expanded(
                      child: DropdownButton<String>(
                        isExpanded: true,
                        value: _session.personal.snapshot!.selectedId,
                        items: [
                          for (final row
                              in _session.personal.snapshot!.object(
                                        'conversations',
                                      )['items']
                                      as List? ??
                                  [])
                            DropdownMenuItem(
                              value: row['id'] as String,
                              child: Text(
                                '${row['title']} (${row['unread_count'] ?? 0})',
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                        ],
                        onChanged:
                            _session.connected &&
                                !input.busy &&
                                !_session.voice &&
                                !_session.voiceStarting
                            ? (id) {
                                if (id != null) {
                                  unawaited(
                                    _session.personal
                                        .command('conversations.select', {
                                          'id': id,
                                        })
                                        .catchError((Object error) {
                                          if (mounted) {
                                            setState(
                                              () => _error = error.toString(),
                                            );
                                          }
                                          return null;
                                        }),
                                  );
                                }
                              }
                            : null,
                      ),
                    ),
                    IconButton(
                      tooltip: 'New conversation',
                      onPressed: _session.connected
                          ? () => _session.personal
                                .command('conversations.create')
                                .catchError((Object error) {
                                  if (mounted) {
                                    setState(() => _error = error.toString());
                                  }
                                  return null;
                                })
                          : null,
                      icon: const Icon(Icons.add),
                    ),
                    IconButton(
                      tooltip: 'Reminders',
                      onPressed: () => showModalBottomSheet<void>(
                        context: context,
                        isScrollControlled: true,
                        useSafeArea: true,
                        builder: (sheetContext) => FractionallySizedBox(
                          heightFactor: .85,
                          child: WorkbenchPage(
                            store: _session.personal,
                            page: 0,
                            onOpenConversation: () =>
                                Navigator.pop(sheetContext),
                            onSettings: () => _settings(),
                          ),
                        ),
                      ),
                      icon: const Icon(Icons.notifications_outlined),
                    ),
                  ],
                ),
              ),
            Expanded(
              child: Stack(
                children: [
                  ListView(
                    controller: _scroll,
                    keyboardDismissBehavior:
                        ScrollViewKeyboardDismissBehavior.onDrag,
                    padding: const EdgeInsets.fromLTRB(20, 6, 20, 18),
                    children: [
                      if (!_textMode && messages.isEmpty) ...[
                        Center(
                          child: ExcludeSemantics(
                            child: SizedBox(
                              height: 248,
                              child: VoiceOrb(
                                listening: _session.voice && !_session.muted,
                                level: _session.inputLevel,
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(height: 14),
                        Text(
                          t(_session.status),
                          key: const Key('connection-status'),
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color: _session.connected ? mint : Colors.white54,
                            fontSize: 14,
                          ),
                        ),
                      ],
                      if (messages.isEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 60, bottom: 18),
                          child: Text(
                            t('What would you like to talk about?'),
                            textAlign: TextAlign.center,
                            style: const TextStyle(color: Colors.white54),
                          ),
                        ),
                      for (final message in messages)
                        Container(
                          key:
                              message == messages.last && message.role == 'user'
                              ? _latestUser
                              : ValueKey(message.id),
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
                              if (message.role == 'assistant')
                                AssistantText(message.text)
                              else
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
                          color: Colors.white.withValues(alpha: .05),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(20),
                          ),
                          child: Padding(
                            padding: const EdgeInsets.all(20),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  card.project,
                                  style: const TextStyle(color: Colors.white54),
                                ),
                                Text(
                                  card.title,
                                  style: Theme.of(
                                    context,
                                  ).textTheme.titleMedium,
                                ),
                                SelectableText(card.detail),
                                Text(
                                  card.busy
                                      ? t('Waiting for host')
                                      : card.deadline == null
                                      ? t('Waiting for host update')
                                      : card.deadline!.isAfter(DateTime.now())
                                      ? t('Valid for {0} seconds').replaceFirst(
                                          '{0}',
                                          '${card.deadline!.difference(DateTime.now()).inSeconds.clamp(0, 3600)}',
                                        )
                                      : t('Expired / waiting for host'),
                                  style: const TextStyle(
                                    fontSize: 12,
                                    color: Colors.white54,
                                  ),
                                ),
                                if (_model.approvals.submitted.contains(
                                  card.id,
                                ))
                                  Text(
                                    t('Submitted / waiting for host'),
                                    style: const TextStyle(
                                      fontSize: 12,
                                      color: mint,
                                    ),
                                  ),
                                Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    for (final decision in card.decisions)
                                      OutlinedButton(
                                        style: OutlinedButton.styleFrom(
                                          shape: RoundedRectangleBorder(
                                            borderRadius: BorderRadius.circular(
                                              8,
                                            ),
                                          ),
                                          side: BorderSide.none,
                                          backgroundColor: mint.withValues(
                                            alpha: .14,
                                          ),
                                          disabledBackgroundColor: Colors.white
                                              .withValues(alpha: .04),
                                          disabledForegroundColor:
                                              Colors.white38,
                                        ),
                                        onPressed:
                                            _session.connected &&
                                                card.actionable(
                                                  DateTime.now(),
                                                ) &&
                                                !_model.approvals.submitted
                                                    .contains(card.id)
                                            ? () =>
                                                  _model.decide(card, decision)
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
                  Positioned(
                    right: 12,
                    bottom: 12,
                    child: IconButton.filledTonal(
                      tooltip: t('Latest messages'),
                      icon: const Icon(Icons.arrow_downward),
                      onPressed: () {
                        if (_scroll.hasClients) {
                          _scroll.animateTo(
                            _scroll.position.maxScrollExtent,
                            duration: MediaQuery.disableAnimationsOf(context)
                                ? Duration.zero
                                : const Duration(milliseconds: 250),
                            curve: Curves.easeOut,
                          );
                        }
                      },
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(28, 20, 28, 14),
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
                            maxLines: 5,
                            enabled: !input.recording && !input.transcribing,
                            decoration: InputDecoration(
                              hintText: t('Type a message…'),
                              filled: true,
                              fillColor: Colors.white.withValues(alpha: .06),
                              border: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(14),
                                borderSide: BorderSide.none,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    Align(
                      alignment: Alignment.centerRight,
                      child: IconButton.filled(
                        style: IconButton.styleFrom(
                          backgroundColor: mint,
                          foregroundColor: ink,
                          disabledBackgroundColor: mint.withValues(alpha: .2),
                          disabledForegroundColor: mint.withValues(alpha: .4),
                        ),
                        onPressed:
                            input.busy ||
                                _draft.text.trim().isEmpty ||
                                _draft.text.trim().length > 4000
                            ? null
                            : input.sendDraft,
                        tooltip: t('Send message'),
                        icon: const Icon(Icons.arrow_upward),
                      ),
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
                          onPressed:
                              _session.ready?.personal == true &&
                                  _session.ready?.aoqChat != true
                              ? _session.stopCapture
                              : _session.end,
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
                      child: FilledButton(
                        style: FilledButton.styleFrom(
                          minimumSize: const Size.fromHeight(58),
                        ),
                        key: Key(
                          _session.connected ? 'start-voice' : 'connect',
                        ),
                        onPressed: _session.connecting || input.busy
                            ? null
                            : _session.connected
                            ? _model.startVoice
                            : _connect,
                        child: Row(
                          children: [
                            Icon(_session.connected ? Icons.mic : Icons.link),
                            const SizedBox(width: 10),
                            Text(
                              t(
                                _session.connected
                                    ? 'Start conversation'
                                    : 'Connect',
                              ),
                            ),
                            const Spacer(),
                            const Icon(Icons.north_east),
                          ],
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
