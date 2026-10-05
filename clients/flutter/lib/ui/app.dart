import 'dart:async';
import 'dart:ui' show ImageFilter;
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
import 'components.dart';
import 'theme.dart';

const ink = Nova.ink, mint = Nova.mint;

class NovaApp extends StatelessWidget {
  const NovaApp({super.key, this.session, this.store, this.preferences});
  final Session? session;
  final CredentialStore? store;
  final Preferences? preferences;
  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: novaTheme(),
    builder: (context, child) =>
        DecoratedBox(decoration: novaBackground, child: child),
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

              String t(String text) => tr(session.language, text);
              return SafeArea(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Center(
                        child: Container(
                          width: 36,
                          height: 5,
                          decoration: BoxDecoration(
                            color: Nova.tertiary,
                            borderRadius: BorderRadius.circular(3),
                          ),
                        ),
                      ),
                      const SizedBox(height: 18),
                      Row(
                        children: [
                          const Icon(
                            CupertinoIcons.hand_raised_fill,
                            color: Nova.amber,
                            size: 20,
                          ),
                          const SizedBox(width: 8),
                          Text(
                            t('Needs your confirmation'),
                            style: const TextStyle(
                              fontSize: 17,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 14),
                      Container(
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: Nova.sheetCell,
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: SelectableText(
                          '${row['summary'] ?? ''}',
                          style: const TextStyle(fontSize: 15, height: 1.5),
                        ),
                      ),
                      if (!enabled) ...[
                        const SizedBox(height: 10),
                        Text(
                          t('Waiting for host update'),
                          style: const TextStyle(
                            color: Nova.secondary,
                            fontSize: 13,
                          ),
                        ),
                      ],
                      const SizedBox(height: 18),
                      for (final decision in decisions.reversed)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 10),
                          child: decision == 'decline'
                              ? TextButton(
                                  style: TextButton.styleFrom(
                                    minimumSize: const Size.fromHeight(48),
                                    foregroundColor: Nova.red,
                                  ),
                                  onPressed: enabled
                                      ? () => decide(decision)
                                      : null,
                                  child: Text(t('Decline')),
                                )
                              : FilledButton(
                                  style: FilledButton.styleFrom(
                                    minimumSize: const Size.fromHeight(50),
                                  ),
                                  onPressed: enabled
                                      ? () => decide(decision)
                                      : null,
                                  child: Text(
                                    t(
                                      decision == 'acceptForSession'
                                          ? 'Approve for session'
                                          : 'Approve',
                                    ),
                                  ),
                                ),
                        ),
                    ],
                  ),
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

  Widget _pendingBanner() => ListenableBuilder(
    listenable: session.personal,
    builder: (context, _) {
      final snapshot = session.personal.snapshot;
      final count =
          (snapshot?.rows('pending_approvals').length ?? 0) +
          (snapshot?.rows('pending_confirmations').length ?? 0);
      if (count == 0) return const SizedBox.shrink();
      return Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
        child: Material(
          color: Nova.amber.withValues(alpha: .14),
          borderRadius: BorderRadius.circular(12),
          child: InkWell(
            borderRadius: BorderRadius.circular(12),
            onTap: () {
              _shown.clear();
              _changed();
            },
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
              child: Row(
                children: [
                  const Icon(
                    CupertinoIcons.hand_raised_fill,
                    size: 17,
                    color: Nova.amber,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      tr(session.language, 'Pending confirmations'),
                      style: const TextStyle(
                        color: Nova.amber,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  Text(
                    '$count',
                    style: const TextStyle(
                      color: Nova.amber,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(width: 4),
                  const Icon(
                    CupertinoIcons.chevron_right,
                    size: 14,
                    color: Nova.amber,
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    },
  );

  void _delegate(String text) {
    setState(() => tab = 0);
    conversation.currentState?.prefill(text);
  }

  Future<void> _profile() async {
    await Navigator.of(context).push<void>(
      CupertinoPageRoute(
        builder: (_) => DecoratedBox(
          decoration: novaBackground,
          child: Scaffold(
            backgroundColor: Colors.transparent,
            appBar: AppBar(
              centerTitle: true,
              leading: CupertinoNavigationBarBackButton(
                color: Nova.mint,
                onPressed: () => Navigator.of(context).maybePop(),
              ),
              title: const Text(
                'Profile',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
              ),
              actions: [
                IconButton(
                  tooltip: tr(session.language, 'Settings'),
                  icon: const Icon(
                    CupertinoIcons.slider_horizontal_3,
                    size: 21,
                  ),
                  onPressed: () => conversation.currentState?._settings(),
                ),
              ],
            ),
            body: Column(
              children: [
                _pendingBanner(),
                Expanded(
                  child: WorkbenchPage(
                    store: session.personal,
                    page: 5,
                    language: session.language,
                    showHeading: false,
                    onSettings: () => conversation.currentState?._settings(),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _subtitle() {
    String t(String text) => tr(session.language, text);
    String count(String key, int n) => t(key).replaceFirst('{0}', '$n');
    final snapshot = session.personal.snapshot;
    List<Map<String, dynamic>> rows(Object? value) => (value as List? ?? [])
        .whereType<Map>()
        .map(Map<String, dynamic>.from)
        .toList();
    final life = snapshot?.object('life') ?? {};
    switch (tab) {
      case 0:
        final selected = rows(
          snapshot?.object('conversations')['items'],
        ).where((r) => r['id'] == snapshot?.selectedId).firstOrNull?['title'];
        return session.personal.connected && selected != null
            ? '$selected'
            : t('Your personal agent');
      case 1:
        final fresh = rows(
          snapshot?.object('news')['items'],
        ).where((a) => a['read'] != true).length;
        return fresh == 0
            ? t('Articles from your sources')
            : count('{0} unread articles', fresh);
      case 2:
        final today = DateTime.now().toIso8601String().substring(0, 10);
        final open = rows(
          life['todos'],
        ).where((r) => !['done', 'cancelled'].contains(r['status'])).toList();
        final due = open
            .where(
              (r) => r['due'] != null && '${r['due']}'.compareTo(today) <= 0,
            )
            .length;
        return [
          count('{0} open', open.length),
          if (due > 0) count('{0} due today', due),
        ].join(' · ');
      case 3:
        return count(
          '{0} ideas',
          rows(life['ideas']).where((r) => r['status'] != 'archived').length,
        );
      default:
        return count(
          '{0} active goals',
          rows(life['goals']).where((r) => r['status'] == 'active').length,
        );
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
    final snapshot = session.personal.snapshot;
    final decisions =
        (snapshot?.rows('pending_approvals').length ?? 0) +
        (snapshot?.rows('pending_confirmations').length ?? 0);
    final unread =
        decisions +
        (snapshot?.object('conversations')['unread_count'] as int? ?? 0);
    const names = ['Nova', 'Feeds', 'Todos', 'Ideas', 'Goals'];
    return Scaffold(
      backgroundColor: Colors.transparent,
      appBar: AppBar(
        toolbarHeight: 76,
        title: MediaQuery.withClampedTextScaling(
          maxScaleFactor: 1.3,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                names[tab],
                style: const TextStyle(
                  fontSize: 30,
                  fontWeight: FontWeight.w700,
                  letterSpacing: -.6,
                  height: 1.1,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                _subtitle(),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 13,
                  color: Nova.secondary,
                  fontWeight: FontWeight.w400,
                ),
              ),
            ],
          ),
        ),
        actions: [
          IconButton(
            tooltip: tr(session.language, 'Settings'),
            icon: const Icon(
              CupertinoIcons.slider_horizontal_3,
              size: 21,
              color: Nova.secondary,
            ),
            onPressed: () => conversation.currentState?._settings(),
          ),
          Tooltip(
            message: session.personal.connected
                ? 'Mac connected'
                : session.connecting
                ? 'Connecting'
                : 'Offline',
            child: IconButton(
              tooltip: 'Profile',
              onPressed: _profile,
              icon: Stack(
                clipBehavior: Clip.none,
                children: [
                  const CircleAvatar(
                    radius: 17,
                    backgroundColor: Color(0xff1e2a2c),
                    child: Icon(
                      CupertinoIcons.person_fill,
                      size: 19,
                      color: Nova.mint,
                    ),
                  ),
                  Positioned(
                    right: -1,
                    bottom: -1,
                    child: Container(
                      width: 11,
                      height: 11,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: session.personal.connected
                            ? Nova.mint
                            : const Color(0xff5b6670),
                        border: Border.all(color: Nova.ink, width: 2),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(width: 10),
        ],
      ),
      body: Column(
        children: [
          _pendingBanner(),
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
                  embedded: true,
                ),
                for (final page in [1, 2, 3, 4])
                  tab == page
                      ? WorkbenchPage(
                          key: ValueKey(page),
                          store: session.personal,
                          page: page,
                          language: session.language,
                          showHeading: false,
                          onOpenConversation: () => setState(() => tab = 0),
                          onDelegate: _delegate,
                          onSettings: () =>
                              conversation.currentState?._settings(),
                        )
                      : const SizedBox(),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: BottomAppBarTabs(
        index: tab,
        onTap: (index) => setState(() => tab = index),
        items: [
          (
            CupertinoIcons.chat_bubble_2,
            CupertinoIcons.chat_bubble_2_fill,
            names[0],
            unread,
          ),
          (CupertinoIcons.news, CupertinoIcons.news_solid, names[1], 0),
          (
            CupertinoIcons.checkmark_circle,
            CupertinoIcons.checkmark_circle_fill,
            names[2],
            0,
          ),
          (
            CupertinoIcons.lightbulb,
            CupertinoIcons.lightbulb_fill,
            names[3],
            0,
          ),
          (CupertinoIcons.flag, CupertinoIcons.flag_fill, names[4], 0),
        ],
      ),
    );
  }
}

/// iOS tab bar: hairline top border, filled mint icon when selected.
class BottomAppBarTabs extends StatelessWidget {
  const BottomAppBarTabs({
    super.key,
    required this.index,
    required this.onTap,
    required this.items,
  });
  final int index;
  final ValueChanged<int> onTap;
  final List<(IconData, IconData, String, int)> items;
  @override
  // iOS tab bar labels keep a fixed size; Dynamic Type applies to content.
  Widget build(BuildContext context) => MediaQuery.withNoTextScaling(
    child: ClipRect(
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 20, sigmaY: 20),
        child: DecoratedBox(
          decoration: const BoxDecoration(
            color: Color(0xd90b1016),
            border: Border(top: BorderSide(color: Nova.separator, width: .5)),
          ),
          child: SafeArea(
            top: false,
            child: SizedBox(
              height: 54,
              child: Row(
                children: [
                  for (final (i, item) in items.indexed)
                    Expanded(
                      child: Semantics(
                        selected: i == index,
                        button: true,
                        child: GestureDetector(
                          behavior: HitTestBehavior.opaque,
                          onTap: () => onTap(i),
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Badge(
                                isLabelVisible: item.$4 > 0,
                                backgroundColor: Nova.red,
                                label: Text(
                                  item.$4 > 99 ? '99+' : '${item.$4}',
                                ),
                                child: Icon(
                                  i == index ? item.$2 : item.$1,
                                  size: 25,
                                  color: i == index ? Nova.mint : Nova.tertiary,
                                ),
                              ),
                              const SizedBox(height: 3),
                              Text(
                                item.$3,
                                style: TextStyle(
                                  fontSize: 10.5,
                                  fontWeight: FontWeight.w500,
                                  color: i == index ? Nova.mint : Nova.tertiary,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

class ConversationScreen extends StatefulWidget {
  const ConversationScreen({
    super.key,
    this.session,
    this.store,
    this.preferences,
    this.active = true,
    this.embedded = false,
  });
  final bool active, embedded;
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
  bool _textMode = false, _dictationMode = false, _atBottom = true;
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
    _scroll.addListener(_updateAtBottom);
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

  bool _updateAtBottom() {
    final atBottom = !_scroll.hasClients || _scroll.position.extentAfter < 48;
    if (atBottom != _atBottom && mounted) {
      setState(() => _atBottom = atBottom);
    }
    return false;
  }

  /// Puts a prepared request into the composer; voice-only hosts get a hint.
  Future<void> prefill(String text) async {
    if (_session.connected && _session.editableInput && !_session.voice) {
      await _model.switchToText();
      if (!mounted) return;
      setState(() => _textMode = true);
      // An unsent draft is kept; the suggestion is appended below it.
      final current = _draft.text.trim();
      if (current.isEmpty) {
        _draft.text = text;
      } else if (!current.contains(text)) {
        _draft.text = '${_draft.text.trimRight()}\n\n$text';
      }
      _draft.selection = TextSelection.collapsed(offset: _draft.text.length);
    } else if (mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('${t('Say it to Nova')}：$text')));
    }
  }

  Future<void> _conversations() async {
    final snapshot = _session.personal.snapshot;
    final items = (snapshot?.object('conversations')['items'] as List? ?? [])
        .whereType<Map>()
        .toList();
    final canSwitch =
        _session.connected &&
        !_model.input.busy &&
        !_session.voice &&
        !_session.voiceStarting;
    final picked = await showModalBottomSheet<String>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      builder: (context) => ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * .7,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            SheetHeader(
              title: t('Conversations'),
              cancel: t('Cancel'),
              done: t('New'),
              onDone: _session.connected
                  ? () => Navigator.pop(context, '\u0000new')
                  : null,
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.only(top: 6, bottom: 20),
                children: [
                  NovaSection(
                    children: [
                      for (final row in items)
                        NovaTile(
                          title: '${row['title']}',
                          titleLines: 1,
                          leading: Icon(
                            row['kind'] == 'proactive'
                                ? CupertinoIcons.bell_fill
                                : row['kind'] == 'topic'
                                ? CupertinoIcons.number
                                : CupertinoIcons.chat_bubble_fill,
                            size: 20,
                            color: row['kind'] == 'proactive'
                                ? Nova.amber
                                : Nova.secondary,
                          ),
                          subtitle: row['kind'] == 'proactive'
                              ? Text(t('Proactive reminders'))
                              : null,
                          trailing: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              if ((row['unread_count'] as int? ?? 0) > 0)
                                Container(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 7,
                                    vertical: 2,
                                  ),
                                  decoration: BoxDecoration(
                                    color: Nova.red,
                                    borderRadius: BorderRadius.circular(10),
                                  ),
                                  child: Text(
                                    '${row['unread_count']}',
                                    style: const TextStyle(
                                      fontSize: 12,
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                ),
                              if (row['id'] == snapshot?.selectedId)
                                const Padding(
                                  padding: EdgeInsets.only(left: 8),
                                  child: Icon(
                                    CupertinoIcons.checkmark_alt,
                                    size: 18,
                                    color: Nova.mint,
                                  ),
                                ),
                            ],
                          ),
                          onTap: canSwitch
                              ? () =>
                                    Navigator.pop(context, row['id'] as String)
                              : null,
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
    if (picked == null || !mounted) return;
    final future = picked == '\u0000new'
        ? _session.personal.command('conversations.create')
        : picked == snapshot?.selectedId
        ? null
        : _session.personal.command('conversations.select', {'id': picked});
    await future?.catchError((Object error) {
      if (mounted) setState(() => _error = error.toString());
      return null;
    });
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

  Widget _modeSwitch() => Padding(
    padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
    child: SizedBox(
      width: double.infinity,
      child: CupertinoSlidingSegmentedControl<bool>(
        groupValue: _textMode,
        backgroundColor: const Color(0xff1f252c),
        thumbColor: const Color(0xff4a515a),
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
      ),
    ),
  );

  Widget _conversationBar() {
    final snapshot = _session.personal.snapshot!;
    final items = (snapshot.object('conversations')['items'] as List? ?? [])
        .whereType<Map>();
    final selected = items
        .where((r) => r['id'] == snapshot.selectedId)
        .firstOrNull;
    final otherUnread = items
        .where((r) => r['id'] != snapshot.selectedId)
        .fold<int>(0, (n, r) => n + (r['unread_count'] as int? ?? 0));
    final reminders = snapshot
        .rows('feed')
        .where(
          (f) =>
              f['lifecycle'] == 'active' &&
              !['dismissed', 'snoozed'].contains(f['user_state']),
        )
        .length;
    final tasks = snapshot
        .rows('tasks')
        .where((task) => activePhases.contains(task['phase']))
        .toList();
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 10, 8),
          child: Row(
            children: [
              Expanded(
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Material(
                    color: Nova.cell,
                    shape: const StadiumBorder(),
                    child: InkWell(
                      customBorder: const StadiumBorder(),
                      onTap: _conversations,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 8,
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              selected?['kind'] == 'proactive'
                                  ? CupertinoIcons.bell_fill
                                  : CupertinoIcons.chat_bubble_fill,
                              size: 14,
                              color: selected?['kind'] == 'proactive'
                                  ? Nova.amber
                                  : Nova.secondary,
                            ),
                            const SizedBox(width: 7),
                            Flexible(
                              child: Text(
                                '${selected?['title'] ?? t('Conversations')}',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w500,
                                ),
                              ),
                            ),
                            if (otherUnread > 0)
                              Container(
                                margin: const EdgeInsets.only(left: 6),
                                width: 7,
                                height: 7,
                                decoration: const BoxDecoration(
                                  color: Nova.red,
                                  shape: BoxShape.circle,
                                ),
                              ),
                            const SizedBox(width: 4),
                            const Icon(
                              CupertinoIcons.chevron_down,
                              size: 13,
                              color: Nova.secondary,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
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
                icon: const Icon(CupertinoIcons.square_pencil, size: 21),
              ),
              IconButton(
                tooltip: 'Reminders',
                onPressed: () => showModalBottomSheet<void>(
                  context: context,
                  isScrollControlled: true,
                  useSafeArea: true,
                  builder: (sheetContext) => FractionallySizedBox(
                    heightFactor: .88,
                    child: Column(
                      children: [
                        SheetHeader(
                          title: t('Reminders'),
                          cancel: t('Close'),
                          done: '',
                        ),
                        Expanded(
                          child: WorkbenchPage(
                            store: _session.personal,
                            page: 0,
                            language: _session.language,
                            showHeading: false,
                            onOpenConversation: () =>
                                Navigator.pop(sheetContext),
                            onSettings: () => _settings(),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                icon: Badge(
                  isLabelVisible: reminders + tasks.length > 0,
                  backgroundColor: Nova.red,
                  label: Text('${reminders + tasks.length}'),
                  child: const Icon(CupertinoIcons.bell, size: 22),
                ),
              ),
            ],
          ),
        ),
        if (tasks.isNotEmpty)
          SizedBox(
            height: 46,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              itemCount: tasks.length,
              separatorBuilder: (_, _) => const SizedBox(width: 8),
              itemBuilder: (context, i) {
                final task = tasks[i];
                final waiting = task['phase'] == 'waiting';
                return Material(
                  color: (waiting ? Nova.amber : Nova.mint).withValues(
                    alpha: .12,
                  ),
                  shape: const StadiumBorder(),
                  child: InkWell(
                    customBorder: const StadiumBorder(),
                    onTap: () =>
                        showTaskSheet(context, _session.personal, task),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 260),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              waiting
                                  ? CupertinoIcons.pause_circle_fill
                                  : CupertinoIcons.bolt_fill,
                              size: 14,
                              color: waiting ? Nova.amber : Nova.mint,
                            ),
                            const SizedBox(width: 6),
                            Flexible(
                              child: Text(
                                '${task['goal'] ?? task['title'] ?? t('Task')}',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(fontSize: 13),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
      ],
    );
  }

  Widget _message(dynamic message, bool last) {
    final user = message.role == 'user';
    return Padding(
      key: last && user ? _latestUser : ValueKey(message.id),
      padding: const EdgeInsets.only(bottom: 16),
      child: user
          ? Align(
              alignment: Alignment.centerRight,
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxWidth: MediaQuery.sizeOf(context).width * .78,
                ),
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 15,
                    vertical: 10,
                  ),
                  decoration: BoxDecoration(
                    color: const Color(0xff1f3a36),
                    borderRadius: BorderRadius.circular(19),
                  ),
                  child: SelectableText(
                    message.text,
                    style: const TextStyle(fontSize: 16, height: 1.4),
                  ),
                ),
              ),
            )
          : Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  margin: const EdgeInsets.only(top: 2, right: 10),
                  width: 24,
                  height: 24,
                  decoration: const BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: RadialGradient(
                      colors: [Color(0xffc9f6ec), Nova.mint, Color(0xff2d6f63)],
                    ),
                  ),
                ),
                Expanded(child: AssistantText(message.text)),
              ],
            ),
    );
  }

  Widget _approval(dynamic card) {
    final submitted = _model.approvals.submitted.contains(card.id);
    final enabled =
        _session.connected && card.actionable(DateTime.now()) && !submitted;
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Nova.cell,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Nova.amber.withValues(alpha: .35), width: .8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(
                CupertinoIcons.hand_raised_fill,
                size: 15,
                color: Nova.amber,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  '${t('Needs your confirmation')} · ${card.project}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Nova.amber, fontSize: 13),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            card.title,
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 6),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: Colors.black.withValues(alpha: .25),
              borderRadius: BorderRadius.circular(8),
            ),
            child: SelectableText(
              card.detail,
              style: const TextStyle(
                fontFamily: 'Menlo',
                fontFamilyFallback: ['Courier'],
                fontSize: 13,
                height: 1.4,
              ),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            submitted
                ? t('Submitted / waiting for host')
                : card.busy
                ? t('Waiting for host')
                : card.deadline == null
                ? t('Waiting for host update')
                : card.deadline!.isAfter(DateTime.now())
                ? t('Valid for {0} seconds').replaceFirst(
                    '{0}',
                    '${card.deadline!.difference(DateTime.now()).inSeconds.clamp(0, 3600)}',
                  )
                : t('Expired / waiting for host'),
            style: TextStyle(
              fontSize: 12,
              color: submitted ? Nova.mint : Nova.secondary,
            ),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final decision in card.decisions as List<String>)
                decision == 'decline'
                    ? OutlinedButton(
                        style: OutlinedButton.styleFrom(
                          foregroundColor: Nova.red,
                          side: BorderSide(
                            color: enabled
                                ? Nova.red.withValues(alpha: .5)
                                : Nova.separator,
                          ),
                          shape: const StadiumBorder(),
                        ),
                        onPressed: enabled
                            ? () => _model.decide(card, decision)
                            : null,
                        child: Text(t('Decline')),
                      )
                    : FilledButton(
                        onPressed: enabled
                            ? () => _model.decide(card, decision)
                            : null,
                        child: Text(
                          t(
                            decision == 'acceptForSession'
                                ? 'Approve for session'
                                : 'Approve',
                          ),
                        ),
                      ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _composer() {
    final input = _model.input;
    final canSend =
        !input.busy &&
        _draft.text.trim().isNotEmpty &&
        _draft.text.trim().length <= 4000;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            IconButton(
              onPressed: input.busy
                  ? null
                  : () => setState(() => _dictationMode = !_dictationMode),
              tooltip: t('Voice recognition'),
              icon: Icon(
                _dictationMode ? CupertinoIcons.keyboard : CupertinoIcons.mic,
                color: Nova.mint,
              ),
            ),
            Expanded(
              child: TextField(
                controller: _draft,
                minLines: 1,
                maxLines: 5,
                enabled: !input.recording && !input.transcribing,
                style: const TextStyle(fontSize: 16),
                decoration: InputDecoration(
                  hintText: t('Type a message…'),
                  fillColor: Nova.cell,
                  isDense: true,
                  contentPadding: const EdgeInsets.fromLTRB(16, 11, 6, 11),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(22),
                    borderSide: const BorderSide(color: Nova.separator),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(22),
                    borderSide: const BorderSide(color: Nova.separator),
                  ),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(22),
                    borderSide: BorderSide(
                      color: Nova.mint.withValues(alpha: .5),
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 8),
            Padding(
              padding: const EdgeInsets.only(bottom: 2),
              child: IconButton.filled(
                style: IconButton.styleFrom(
                  backgroundColor: Nova.mint,
                  foregroundColor: Nova.ink,
                  disabledBackgroundColor: Nova.mint.withValues(alpha: .18),
                  disabledForegroundColor: Nova.ink.withValues(alpha: .6),
                  fixedSize: const Size(38, 38),
                  minimumSize: const Size(38, 38),
                ),
                onPressed: canSend ? input.sendDraft : null,
                tooltip: t('Send message'),
                icon: const Icon(CupertinoIcons.arrow_up, size: 20),
              ),
            ),
          ],
        ),
        if (_dictationMode)
          Semantics(
            button: true,
            label: t(
              input.recording ? 'Release to transcribe' : 'Hold to speak',
            ),
            onTap: input.recording
                ? input.finishDictation
                : input.beginDictation,
            child: GestureDetector(
              onLongPressStart: (_) => input.beginDictation(),
              onLongPressEnd: (_) => input.finishDictation(),
              onLongPressCancel: () => input.cancelDictation(),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 150),
                width: double.infinity,
                padding: const EdgeInsets.all(14),
                margin: const EdgeInsets.only(top: 10),
                decoration: BoxDecoration(
                  color: Nova.mint.withValues(
                    alpha: input.recording ? .3 : .12,
                  ),
                  borderRadius: BorderRadius.circular(24),
                ),
                child: Text(
                  t(
                    input.recording ? 'Release to transcribe' : 'Hold to speak',
                  ),
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    color: Nova.mint,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
            ),
          ),
        if (input.transcribing)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              t('Transcribing…'),
              style: const TextStyle(color: Nova.secondary, fontSize: 13),
            ),
          ),
        if (input.recording || input.transcribing)
          TextButton(
            onPressed: input.cancelDictation,
            child: Text(t('Cancel')),
          ),
        if (input.notice.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              t(input.notice),
              style: const TextStyle(color: Nova.amber, fontSize: 13),
            ),
          ),
        if (_draft.text.length > 4000)
          Text(
            t('Message too long'),
            style: const TextStyle(color: Nova.red, fontSize: 13),
          ),
      ],
    );
  }

  Widget _voiceControls() => Row(
    mainAxisAlignment: MainAxisAlignment.center,
    children: [
      _roundControl(
        icon: _session.muted
            ? CupertinoIcons.mic_slash_fill
            : CupertinoIcons.mic_fill,
        tooltip: t(_session.muted ? 'Unmute' : 'Mute'),
        selected: _session.muted,
        onPressed: _session.voiceStarting ? null : _session.toggleMute,
      ),
      const SizedBox(width: 28),
      Tooltip(
        message: t('End call'),
        child: SizedBox(
          width: 68,
          height: 68,
          child: FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: Nova.red,
              foregroundColor: Colors.white,
              shape: const CircleBorder(),
              padding: EdgeInsets.zero,
            ),
            onPressed:
                _session.ready?.personal == true &&
                    _session.ready?.aoqChat != true
                ? _session.stopCapture
                : _session.end,
            child: const Icon(CupertinoIcons.phone_down_fill, size: 28),
          ),
        ),
      ),
      const SizedBox(width: 28),
      _roundControl(
        icon: CupertinoIcons.speaker_2_fill,
        tooltip: t('Speaker'),
        selected: _session.speaker,
        onPressed: _session.voiceStarting ? null : _session.toggleSpeaker,
      ),
    ],
  );

  Widget _roundControl({
    required IconData icon,
    required String tooltip,
    required bool selected,
    VoidCallback? onPressed,
  }) => IconButton(
    tooltip: tooltip,
    isSelected: selected,
    onPressed: onPressed,
    style: IconButton.styleFrom(
      fixedSize: const Size(52, 52),
      backgroundColor: selected ? Nova.text : Nova.cellPressed,
      foregroundColor: selected ? Nova.ink : Nova.text,
    ),
    icon: Icon(icon, size: 22),
  );

  Widget _startButton() {
    final connected = _session.connected;
    final enabled = !(_session.connecting || _model.input.busy);
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          width: connected ? 68 : double.infinity,
          height: connected ? 68 : 52,
          child: FilledButton(
            key: Key(connected ? 'start-voice' : 'connect'),
            style: FilledButton.styleFrom(
              shape: connected ? const CircleBorder() : const StadiumBorder(),
              padding: EdgeInsets.zero,
            ),
            onPressed: enabled
                ? connected
                      ? _model.startVoice
                      : _connect
                : null,
            child: connected
                ? const Icon(CupertinoIcons.mic_fill, size: 28)
                : Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Icon(CupertinoIcons.link, size: 19),
                      const SizedBox(width: 8),
                      Flexible(
                        child: Text(
                          t('Connect'),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
          ),
        ),
        if (connected) ...[
          const SizedBox(height: 8),
          Text(
            t('Start conversation'),
            style: const TextStyle(color: Nova.secondary, fontSize: 13),
          ),
        ],
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final messages = _model.transcript.messages;
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: SafeArea(
        top: !widget.embedded,
        bottom: !widget.embedded,
        child: Column(
          children: [
            if (!widget.embedded)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 10, 12, 10),
                child: Row(
                  children: [
                    const Expanded(
                      child: Text(
                        'Nova',
                        style: TextStyle(
                          fontSize: 30,
                          fontWeight: FontWeight.w700,
                          letterSpacing: -.6,
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: t('Settings'),
                      onPressed: _settings,
                      icon: const Icon(
                        CupertinoIcons.slider_horizontal_3,
                        color: Nova.secondary,
                      ),
                    ),
                  ],
                ),
              ),
            if (_session.editableInput) _modeSwitch(),
            if (_session.personal.snapshot != null) _conversationBar(),
            Expanded(
              child: Stack(
                children: [
                  // Content growth changes metrics without a scroll event.
                  NotificationListener<ScrollMetricsNotification>(
                    onNotification: (_) => _updateAtBottom(),
                    child: ListView(
                      controller: _scroll,
                      keyboardDismissBehavior:
                          ScrollViewKeyboardDismissBehavior.onDrag,
                      padding: const EdgeInsets.fromLTRB(16, 8, 16, 18),
                      children: [
                        if (!_textMode && messages.isEmpty) ...[
                          const SizedBox(height: 12),
                          Center(
                            child: ExcludeSemantics(
                              child: SizedBox(
                                height: 236,
                                child: VoiceOrb(
                                  listening: _session.voice && !_session.muted,
                                  level: _session.inputLevel,
                                ),
                              ),
                            ),
                          ),
                          const SizedBox(height: 18),
                          Text(
                            t(_session.status),
                            key: const Key('connection-status'),
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              color: _session.connected
                                  ? Nova.mint
                                  : Nova.secondary,
                              fontSize: 15,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ],
                        if (messages.isEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 8, bottom: 18),
                            child: Text(
                              t('What would you like to talk about?'),
                              textAlign: TextAlign.center,
                              style: const TextStyle(color: Nova.tertiary),
                            ),
                          ),
                        for (final (i, message) in messages.indexed)
                          _message(message, i == messages.length - 1),
                        for (final card in _model.approvals.cards)
                          _approval(card),
                        if (_model.tasks.isNotEmpty)
                          NovaSection(
                            header: t('Tasks'),
                            children: [
                              for (final entry in _model.tasks.entries)
                                NovaTile(
                                  title: entry.key,
                                  titleLines: 1,
                                  leading: const Icon(
                                    CupertinoIcons.bolt_fill,
                                    size: 18,
                                    color: Nova.mint,
                                  ),
                                  subtitle: Text(entry.value),
                                ),
                            ],
                          ),
                        if (_model.results.isNotEmpty)
                          NovaSection(
                            header: t('Results'),
                            children: [
                              for (final result in _model.results.values)
                                Padding(
                                  padding: const EdgeInsets.all(14),
                                  child: SelectableText(
                                    result,
                                    style: const TextStyle(height: 1.45),
                                  ),
                                ),
                            ],
                          ),
                        if (_error != null)
                          Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: Text(
                              _error!,
                              style: const TextStyle(
                                color: Nova.amber,
                                fontSize: 13,
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                  if (messages.isNotEmpty || _model.approvals.cards.isNotEmpty)
                    Positioned(
                      right: 14,
                      bottom: 10,
                      child: AnimatedOpacity(
                        opacity: _atBottom ? 0 : 1,
                        duration: const Duration(milliseconds: 180),
                        child: IconButton(
                          tooltip: t('Latest messages'),
                          style: IconButton.styleFrom(
                            backgroundColor: Nova.cellPressed,
                            foregroundColor: Nova.mint,
                            fixedSize: const Size(40, 40),
                          ),
                          icon: const Icon(CupertinoIcons.arrow_down, size: 18),
                          onPressed: () {
                            if (_scroll.hasClients) {
                              _scroll.animateTo(
                                _scroll.position.maxScrollExtent,
                                duration:
                                    MediaQuery.disableAnimationsOf(context)
                                    ? Duration.zero
                                    : const Duration(milliseconds: 250),
                                curve: Curves.easeOut,
                              );
                            }
                          },
                        ),
                      ),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 16, 12),
              child: _textMode && _session.editableInput && !_session.voice
                  ? _composer()
                  : _session.voice || _session.voiceStarting
                  ? _voiceControls()
                  : !_textMode || !_session.connected
                  ? Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      child: _startButton(),
                    )
                  : const SizedBox.shrink(),
            ),
          ],
        ),
      ),
    );
  }
}
