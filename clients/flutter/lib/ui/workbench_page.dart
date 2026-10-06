import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../personal/personal_store.dart';
import '../personal/commands.dart';
import 'components.dart';
import 'strings.dart';
import 'task_details.dart';
import 'theme.dart';
import 'todo_editor.dart';

const activePhases = ['running', 'waiting', 'verifying'];

/// Opens a task's activity sheet; Discuss selects its conversation first.
Future<void> showTaskSheet(
  BuildContext context,
  PersonalStore store,
  Map<String, dynamic> task, {
  VoidCallback? onOpenConversation,
}) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  builder: (sheetContext) => TaskDetails(
    store: store,
    task: task,
    onDiscuss: () async {
      await store.command('conversations.select', {
        'id': task['conversation_id'],
      });
      if (sheetContext.mounted &&
          ModalRoute.of(sheetContext)?.isCurrent == true) {
        Navigator.pop(sheetContext);
        onOpenConversation?.call();
      }
    },
  ),
);

class WorkbenchPage extends StatefulWidget {
  const WorkbenchPage({
    super.key,
    required this.store,
    required this.page,
    required this.onSettings,
    this.onOpenConversation,
    this.onDelegate,
    this.showHeading = true,
    this.language = 'en',
  });
  final PersonalStore store;

  /// 0 reminders, 1 feeds, 2 todos, 3 ideas, 4 goals, 5 profile.
  final int page;
  final bool showHeading;
  final String language;
  final VoidCallback onSettings;
  final VoidCallback? onOpenConversation;

  /// Hands a prepared request to the Nova conversation.
  final ValueChanged<String>? onDelegate;
  @override
  State<WorkbenchPage> createState() => _WorkbenchPageState();
}

class _WorkbenchPageState extends State<WorkbenchPage> {
  String get _kind => widget.page == 2
      ? 'todo'
      : widget.page == 4
      ? 'goal'
      : 'idea';
  final _presented = <String>{};
  final _viewport = GlobalKey();
  final _feedKeys = <String, GlobalKey>{};
  final _evidenceOpen = <String>{};
  bool _checking = false, _saved = false, _completedOpen = false;
  PersonalStore get store => widget.store;
  String t(String text) => tr(widget.language, text);
  List<Map<String, dynamic>> _rows(Object? value) => (value as List? ?? [])
      .whereType<Map>()
      .map((v) => Map<String, dynamic>.from(v))
      .toList();
  Future<dynamic> _run(Future<dynamic> Function() action) async {
    try {
      return await action();
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
      return null;
    }
  }

  Future<String?> _edit(String label, String value, {int limit = 200}) =>
      editTextSheet(
        context,
        language: widget.language,
        title: t(label),
        value: value,
        limit: limit,
        lines: limit > 200 ? 4 : 1,
      );

  Future<void> _create() async {
    final kind = _kind;
    final title = await _edit('New $kind', '');
    if (title == null || title.isEmpty) return;
    final result = await _run(
      () => store.mutate({'op': 'create', 'kind': kind, 'title': title}),
    );
    if (!mounted || result is! Map || kind != 'todo') return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(t('Todo created')),
        action: SnackBarAction(
          label: t('Undo'),
          onPressed: () => _run(
            () => store.mutate({
              'op': 'undo_create',
              'id': result['id'],
              'expected_version': 1,
            }),
          ),
        ),
      ),
    );
  }

  Future<void> _status(Map<String, dynamic> row, String status) async {
    final result = await _run(() => store.updateItem(row, {'status': status}));
    if (!mounted || result is! Map) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('${row['title']} · ${t(status)}'),
        action: SnackBarAction(
          label: t('Undo'),
          onPressed: () => _run(
            () => store.updateItem(
              {...row, 'version': result['version']},
              {'status': row['status']},
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _editTodo(Map<String, dynamic> row) async {
    final changes = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => TodoEditor(
        row: row,
        language: widget.language,
        goals: _rows(store.snapshot?.object('life')['goals']),
        tasks: store.snapshot?.rows('tasks') ?? [],
      ),
    );
    if (changes != null) await _run(() => store.updateItem(row, changes));
  }

  Future<void> _leftSwipe(Map<String, dynamic> row) async {
    final action = await showNovaActions(
      context,
      language: widget.language,
      title: '${row['title']}',
      actions: [
        (value: 'due', label: t('Reschedule'), destructive: false),
        (value: 'cancel', label: t('Cancel todo'), destructive: true),
      ],
    );
    if (!mounted) return;
    if (action == 'due') await _editTodo(row);
    if (action == 'cancel') await _status(row, 'cancelled');
  }

  Future<void> _rowActions(Map<String, dynamic> row) async {
    final kind = row['kind'] as String;
    final action = await showNovaActions(
      context,
      language: widget.language,
      title: '${row['title']}',
      actions: [
        (value: 'title', label: t('Edit title'), destructive: false),
        (value: 'note', label: t('Edit notes'), destructive: false),
        if (kind == 'idea') ...[
          (value: 'todo', label: t('Convert to todo'), destructive: false),
          (value: 'goal', label: t('Convert to goal'), destructive: false),
        ],
        if (kind == 'goal') ...[
          if (row['status'] != 'completed')
            (value: 'completed', label: t('Complete'), destructive: false),
          if (row['status'] == 'paused')
            (value: 'active', label: t('Resume'), destructive: false)
          else
            (value: 'paused', label: t('Pause'), destructive: false),
        ],
        (value: 'archived', label: t('Archive'), destructive: true),
      ],
    );
    if (!mounted || action == null) return;
    if (action == 'title' || action == 'note') {
      final note = action == 'note';
      final value = await _edit(
        note ? 'Notes' : 'Title',
        '${row[note ? 'note' : 'title'] ?? ''}',
        limit: note ? 4000 : 200,
      );
      if (value == null || (!note && value.isEmpty)) return;
      await _run(() => store.updateItem(row, {note ? 'note' : 'title': value}));
    } else if (action == 'todo' || action == 'goal') {
      await _run(
        () => store.mutate({
          'op': 'convert',
          'id': row['id'],
          'expected_version': row['version'],
          'target': action,
        }),
      );
    } else {
      await _status(row, action);
    }
  }

  /// Translated enum label; unknown values stay hidden instead of leaking keys.
  String? _label(String prefix, Object? value) {
    if (value == null) return null;
    final key = '$prefix:$value', label = t(key);
    return label == key ? null : label;
  }

  String _firstLine(Object? value) =>
      '${value ?? ''}'.trim().split('\n').first.trim();

  Widget _item(Map<String, dynamic> row, {bool nested = false}) {
    final kind = row['kind'] as String? ?? _kind;
    final item = {...row, 'kind': kind};
    final progress = row['progress'] as Map?;
    final life = store.snapshot?.object('life') ?? {};
    String? titleOf(String key, Object? id) => id == null
        ? null
        : _rows(life[key]).where((r) => r['id'] == id).firstOrNull?['title']
              as String?;
    final due = kind == 'todo' ? dueLabel(row['due'], widget.language) : null;
    final converted = kind == 'idea'
        ? [
            for (final target in ['todos', 'goals'])
              for (final r in _rows(life[target]))
                if (r['idea_id'] == row['id'])
                  '${t(target == 'todos' ? 'Now a todo' : 'Now a goal')}：${r['title']}',
          ]
        : const <String>[];
    final goalTitle = kind == 'todo' && !nested
        ? titleOf('goals', row['goal_id'])
        : null;
    final meta = <String?>[
      if (kind == 'todo' && row['status'] == 'waiting') t('waiting'),
      due?.text,
      if (goalTitle != null) '◎ $goalTitle',
      if (kind == 'goal') ...[
        if (row['status'] != 'active') t('${row['status']}'),
        if (progress != null && (progress['total'] as num? ?? 0) > 0)
          t('{0}/{1} todos')
              .replaceFirst('{0}', '${progress['done']}')
              .replaceFirst('{1}', '${progress['total']}'),
        _firstLine(row['success_criteria']),
      ],
      ...converted,
      _firstLine(row['note']),
    ];
    final hasMeta = meta.whereType<String>().any((m) => m.isNotEmpty);
    final done = row['status'] == 'done';
    final tile = NovaTile(
      title: '${row['title']}',
      leading: kind == 'todo'
          ? RoundCheck(
              value: done,
              onChanged: store.connected
                  ? (value) => _status(item, value ? 'done' : 'open')
                  : null,
            )
          : kind == 'goal'
          ? ProgressRing(
              done: progress?['done'] as num? ?? 0,
              total: progress?['total'] as num? ?? 0,
            )
          : const Icon(CupertinoIcons.lightbulb, size: 22, color: Nova.amber),
      subtitle: hasMeta
          ? MetaLine(meta, urgent: {if (due?.urgent == true) due!.text})
          : null,
      trailing: kind == 'todo'
          ? null
          : const Icon(CupertinoIcons.ellipsis, size: 18, color: Nova.tertiary),
      onTap: store.connected
          ? () => kind == 'todo' ? _editTodo(item) : _rowActions(item)
          : null,
    );
    return Dismissible(
      key: ValueKey('life:${row['id']}'),
      confirmDismiss: (direction) async {
        if (store.connected) {
          if (kind == 'todo' && direction == DismissDirection.endToStart) {
            await _leftSwipe(item);
          } else {
            await _status(item, kind == 'todo' ? 'done' : 'archived');
          }
        }
        return false;
      },
      background: _swipe(
        Alignment.centerLeft,
        Nova.mint,
        kind == 'todo' ? Icons.check_rounded : Icons.archive_outlined,
      ),
      secondaryBackground: _swipe(
        Alignment.centerRight,
        kind == 'todo' ? Nova.amber : const Color(0xff5b6670),
        kind == 'todo' ? CupertinoIcons.calendar : Icons.archive_outlined,
      ),
      child: nested
          ? Padding(padding: const EdgeInsets.only(left: 38), child: tile)
          : tile,
    );
  }

  Widget _swipe(Alignment alignment, Color color, IconData icon) => ColoredBox(
    color: color,
    child: Align(
      alignment: alignment,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 22),
        child: Icon(icon, color: Nova.ink),
      ),
    ),
  );

  List<Widget> _todoGroups(List<Map<String, dynamic>> todos) {
    final today = DateTime.now().toIso8601String().substring(0, 10);
    final groups = <String, List<Map<String, dynamic>>>{
      'Today / overdue': [],
      'Doing': [],
      'Waiting': [],
      'Other todos': [],
      'Completed': [],
    };
    for (final todo in todos) {
      final status = todo['status'];
      if (status == 'cancelled') continue;
      final group = status == 'done'
          ? 'Completed'
          : status == 'doing'
          ? 'Doing'
          : status == 'waiting'
          ? 'Waiting'
          : todo['due'] != null && '${todo['due']}'.compareTo(today) <= 0
          ? 'Today / overdue'
          : 'Other todos';
      groups[group]!.add(todo);
    }
    final completed = groups.remove('Completed')!;
    return [
      for (final group in groups.entries)
        if (group.value.isNotEmpty)
          NovaSection(
            header: t(group.key),
            children: [
              for (final todo in group.value) _item({...todo, 'kind': 'todo'}),
            ],
          ),
      if (completed.isNotEmpty)
        NovaSection(
          header: '${t('Completed')} (${completed.length})',
          onHeaderTap: () => setState(() => _completedOpen = !_completedOpen),
          trailing: CupertinoButton(
            padding: EdgeInsets.zero,
            minimumSize: const Size(28, 22),
            onPressed: () => setState(() => _completedOpen = !_completedOpen),
            child: Icon(
              _completedOpen
                  ? CupertinoIcons.chevron_up
                  : CupertinoIcons.chevron_down,
              size: 15,
              color: Nova.secondary,
            ),
          ),
          children: [
            if (_completedOpen)
              for (final todo in completed) _item({...todo, 'kind': 'todo'})
            else
              NovaTile(
                title: t('Show completed'),
                trailing: const CupertinoListTileChevron(),
                onTap: () => setState(() => _completedOpen = true),
              ),
          ],
        ),
    ];
  }

  /// Mirrors the desktop workbench suggestion cards for one life tab.
  List<Widget> _suggestions(String tab, bool hasRows) {
    final context = store.snapshot?.object('workbench_context') ?? {};
    final cards = _rows(
      context['cards'],
    ).where((card) => card['tab'] == tab).take(3).toList();
    final recap = context['recap'] as Map? ?? {};
    final projects = _rows(recap['projects']).take(4).toList();
    final hasRecap =
        tab == 'todos' &&
        ((recap['text'] as String? ?? '').isNotEmpty || projects.isNotEmpty);
    final emptyHint = {
      'todos':
          'Todos you add yourself live here; the suggestions below are not added automatically.',
      'ideas':
          'Ideas you note yourself live here; the suggestions below are not added automatically.',
      'goals':
          'Goals you set yourself live here; the directions below are not added automatically.',
    }[tab]!;
    final emptyText = {
      'todos': 'No open todos',
      'ideas': 'No ideas yet',
      'goals': 'No goals yet',
    }[tab]!;
    return [
      if (!hasRows)
        EmptyNote(
          t(cards.isEmpty && !hasRecap ? emptyText : emptyHint),
          icon: cards.isEmpty && !hasRecap
              ? const {
                  'todos': CupertinoIcons.check_mark_circled,
                  'ideas': CupertinoIcons.lightbulb,
                  'goals': CupertinoIcons.flag,
                }[tab]
              : null,
        ),
      if (hasRecap)
        NovaSection(
          header: t('Recently busy'),
          children: [
            if ((recap['text'] as String? ?? '').isNotEmpty)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                child: Text(
                  recap['text'] as String,
                  style: const TextStyle(
                    color: Nova.text,
                    fontSize: 15,
                    height: 1.45,
                  ),
                ),
              ),
            for (final project in projects)
              NovaTile(
                title: '${project['name'] ?? ''}',
                titleLines: 1,
                subtitle: Text('${project['line'] ?? ''}'),
              ),
          ],
        ),
      if (cards.isNotEmpty) ...[
        Padding(
          padding: const EdgeInsets.fromLTRB(32, 8, 32, 6),
          child: Row(
            children: [
              const Icon(CupertinoIcons.sparkles, size: 14, color: Nova.mint),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  t(
                    tab == 'todos'
                        ? 'Pick up next'
                        : tab == 'goals'
                        ? 'Directions to set'
                        : 'Nova\'s ideas',
                  ),
                  style: const TextStyle(
                    color: Nova.secondary,
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
            ],
          ),
        ),
        for (final card in cards) _suggestion(tab, card),
      ],
    ];
  }

  Widget _suggestion(String tab, Map<String, dynamic> card) {
    final id = card['id'] as String?;
    final body = tab == 'todos'
        ? (card['why'] as String?) ?? (card['body'] as String?)
        : card['body'] as String?;
    final next = card['next'] as String?;
    final sources = card['source_count'] as int? ?? 0;
    Future<void> hide() =>
        _run(() => store.command('context.dismiss', {'id': id}));
    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${card['title'] ?? ''}',
            style: const TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w600,
              height: 1.3,
            ),
          ),
          if (body != null && body.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              body,
              style: const TextStyle(
                color: Nova.secondary,
                fontSize: 14,
                height: 1.45,
              ),
            ),
          ],
          if (next != null && next.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              '${t(tab == 'goals' ? 'Start with' : 'Next')}：$next',
              style: const TextStyle(fontSize: 14, height: 1.45),
            ),
          ],
          if (sources > 0) ...[
            const SizedBox(height: 8),
            Text(
              t('Based on {0} sources').replaceFirst('{0}', '$sources'),
              style: const TextStyle(color: Nova.tertiary, fontSize: 12),
            ),
          ],
          const SizedBox(height: 4),
          Wrap(
            children: [
              if (tab == 'goals')
                LinkAction(
                  t('Set as goal'),
                  onPressed: store.connected && id != null
                      ? () => _run(
                          () => store.command('context.adopt', {'id': id}),
                        )
                      : null,
                )
              else if (tab == 'todos' && next != null && next.isNotEmpty)
                LinkAction(
                  t('Help me do it'),
                  onPressed: widget.onDelegate == null
                      ? null
                      : () =>
                            widget.onDelegate!('请帮我推进「${card['title']}」：$next'),
                )
              else
                LinkAction(
                  t('Talk about this'),
                  onPressed: widget.onDelegate == null
                      ? null
                      : () => widget.onDelegate!(
                          '${card['title']}：${card['body'] ?? ''}',
                        ),
                ),
              LinkAction(
                t('Hide'),
                muted: true,
                onPressed: store.connected && id != null ? hide : null,
              ),
            ],
          ),
        ],
      ),
    );
  }

  void _checkPresented() {
    if (_checking) return;
    _checking = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _checking = false;
      if (!mounted ||
          !store.connected ||
          ModalRoute.of(context)?.isCurrent != true ||
          (WidgetsBinding.instance.lifecycleState != null &&
              WidgetsBinding.instance.lifecycleState !=
                  AppLifecycleState.resumed)) {
        return;
      }
      final viewport = _viewport.currentContext?.findRenderObject();
      if (viewport is! RenderBox || !viewport.attached) return;
      final bounds = viewport.localToGlobal(Offset.zero) & viewport.size;
      final feeds = store.snapshot?.rows('feed') ?? [];
      for (final item in feeds) {
        final id = item['id'] as String;
        if (_presented.contains(id) ||
            (item['delivery'] as Map?)?['presented_at'] != null) {
          continue;
        }
        final box = _feedKeys[id]?.currentContext?.findRenderObject();
        if (box is! RenderBox || !box.attached) continue;
        final y = box.localToGlobal(Offset.zero).dy;
        if (y < bounds.top || y + box.size.height > bounds.bottom) continue;
        _presented.add(id);
        store
            .command('feed.action', {'id': id, 'action': 'presented'})
            .catchError((Object _) {
              _presented.remove(id);
              return null;
            });
      }
    });
  }

  Widget _feed(Map<String, dynamic> row) {
    final id = row['id'] as String;
    final evidence = row['evidence_refs'] as List? ?? [];
    final prepared = (row['prepared'] as Map?)?['text'];
    Future<void> open([String? label]) => _run(() async {
      await store.command('conversations.open_feed', {
        'feed_id': id,
        'label': ?label,
      });
      if (mounted) widget.onOpenConversation?.call();
    });
    return KeyedSubtree(
      key: _feedKeys.putIfAbsent(id, () => GlobalKey()),
      child: NovaCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            MetaLine([
              _label('feed', row['kind'] ?? 'notify'),
              relativeTime(row['created_at'] as String?, widget.language),
            ]),
            const SizedBox(height: 4),
            Text(
              '${row['title']}',
              style: const TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w600,
                height: 1.3,
              ),
            ),
            if (prepared != null) ...[
              const SizedBox(height: 6),
              Text('$prepared', style: const TextStyle(height: 1.45)),
            ],
            if ((row['why_now'] as String? ?? '').isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                row['why_now'] as String,
                style: const TextStyle(
                  color: Nova.secondary,
                  fontSize: 14,
                  height: 1.45,
                ),
              ),
            ],
            if (evidence.isNotEmpty) ...[
              const SizedBox(height: 6),
              GestureDetector(
                onTap: () => setState(
                  () => _evidenceOpen.contains(id)
                      ? _evidenceOpen.remove(id)
                      : _evidenceOpen.add(id),
                ),
                child: Text(
                  '${t('Based on {0} sources').replaceFirst('{0}', '${evidence.length}')} ${_evidenceOpen.contains(id) ? '▴' : '▾'}',
                  style: const TextStyle(color: Nova.tertiary, fontSize: 12),
                ),
              ),
              if (_evidenceOpen.contains(id))
                for (final ref in evidence)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      '$ref',
                      style: const TextStyle(
                        color: Nova.tertiary,
                        fontSize: 12,
                      ),
                    ),
                  ),
            ],
            const SizedBox(height: 4),
            Wrap(
              children: [
                LinkAction(
                  t('Discuss'),
                  onPressed: store.connected ? open : null,
                ),
                LinkAction(
                  t('Execute'),
                  onPressed: store.connected
                      ? () => open(row['action_label'] as String? ?? 'Execute')
                      : null,
                ),
                LinkAction(
                  t('Later'),
                  muted: true,
                  onPressed: store.connected
                      ? () => _run(
                          () => store.command('feed.action', {
                            'id': id,
                            'action': 'snooze',
                            'snooze_until': DateTime.now()
                                .toUtc()
                                .add(const Duration(hours: 1))
                                .toIso8601String(),
                          }),
                        )
                      : null,
                ),
                LinkAction(
                  t('Ignore'),
                  muted: true,
                  onPressed: store.connected
                      ? () => _run(
                          () => store.command('feed.action', {
                            'id': id,
                            'action': 'dismiss',
                          }),
                        )
                      : null,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _task(Map<String, dynamic> task) => NovaTile(
    title: '${task['goal'] ?? task['title'] ?? t('Task')}',
    titleLines: 2,
    leading: Icon(
      task['phase'] == 'waiting'
          ? CupertinoIcons.pause_circle
          : CupertinoIcons.play_circle,
      size: 24,
      color: task['phase'] == 'waiting' ? Nova.amber : Nova.mint,
    ),
    subtitle: MetaLine([
      _label('phase', task['phase']),
      task['waiting_reason'] as String?,
    ]),
    trailing: const CupertinoListTileChevron(),
    onTap: () => showTaskSheet(
      context,
      store,
      task,
      onOpenConversation: widget.onOpenConversation,
    ),
  );

  Widget _article(Map<String, dynamic> article) => NovaTile(
    title: article['title'] as String? ?? 'Article',
    titleLines: 2,
    subtitle: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        MetaLine([
          article['source_name'] as String? ?? article['source_id'] as String?,
          relativeTime(article['published_at'] as String?, widget.language),
          if (article['saved'] == true) t('Saved'),
        ]),
        if ((article['summary'] as String? ?? '').isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Text(
              article['summary'] as String,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
      ],
    ),
    onTap: () => _openArticle(article),
  );

  Future<void> _openArticle(Map<String, dynamic> article) =>
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        useSafeArea: true,
        builder: (context) => DraggableScrollableSheet(
          expand: false,
          initialChildSize: .6,
          maxChildSize: .92,
          builder: (context, controller) => ListView(
            controller: controller,
            padding: const EdgeInsets.fromLTRB(20, 10, 20, 32),
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
              DefaultTextStyle.merge(
                style: const TextStyle(color: Nova.secondary, fontSize: 13),
                child: MetaLine([
                  article['source_name'] as String? ??
                      article['source_id'] as String?,
                  relativeTime(
                    article['published_at'] as String?,
                    widget.language,
                  ),
                ]),
              ),
              const SizedBox(height: 8),
              Text(
                article['title'] as String? ?? '',
                style: const TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.w700,
                  height: 1.3,
                ),
              ),
              const SizedBox(height: 14),
              Text(
                article['summary'] as String? ?? '',
                style: const TextStyle(fontSize: 16, height: 1.6),
              ),
              if (Uri.tryParse(article['url'] as String? ?? '') case final url?
                  when url.scheme == 'http' || url.scheme == 'https') ...[
                const SizedBox(height: 24),
                FilledButton.icon(
                  style: FilledButton.styleFrom(
                    minimumSize: const Size.fromHeight(48),
                  ),
                  onPressed: () =>
                      launchUrl(url, mode: LaunchMode.externalApplication),
                  icon: const Icon(CupertinoIcons.arrow_up_right_square),
                  label: Text(t('Open original')),
                ),
              ],
            ],
          ),
        ),
      );

  List<Widget> _profile(Map<String, dynamic> life) {
    final snapshot = store.snapshot;
    final profile = life['profile'] as Map? ?? {};
    final confirmed = profile['about'] as String? ?? '';
    final version = profile['version'] as int? ?? 0;
    final draft =
        snapshot?.object('profile_preparation')['draft'] as Map? ?? {};
    final suggested = version > 0 ? '' : draft['about'] as String? ?? '';
    final work = version > 0 ? const [] : _rows(draft['work']);
    final about = confirmed.isNotEmpty ? confirmed : suggested;
    final memory = snapshot?.object('memory') ?? {};
    final overview = memory['overview'] as Map?;
    final entries = _rows(
      memory['entries'],
    ).where((e) => '${e['content'] ?? ''}'.trim().isNotEmpty).toList();
    Future<void> editAbout() async {
      final text = await _edit(
        'About you',
        confirmed.isNotEmpty
            ? confirmed
            : [
                suggested,
                for (final item in work) '${item['title']}：${item['text']}',
              ].where((s) => s.isNotEmpty).join('\n\n'),
        limit: 5000,
      );
      if (text == null) return;
      await _run(
        () => store.mutate({
          'op': 'profile',
          'about': text,
          'expected_version': version,
        }),
      );
    }

    return [
      NovaSection(
        header: t('About me'),
        footer: t(
          confirmed.isNotEmpty
              ? 'Written by you'
              : version > 0
              ? 'You cleared your introduction. Write a new one any time.'
              : suggested.isNotEmpty || work.isNotEmpty
              ? 'Drafted by Nova from your recent work. Edit any time.'
              : 'Nova will draft one after reading your sources, or write your own.',
        ),
        trailing: CupertinoButton(
          padding: EdgeInsets.zero,
          minimumSize: const Size(0, 22),
          onPressed: store.connected ? editAbout : null,
          child: Text(
            t(about.isEmpty ? 'Write' : 'Edit'),
            style: TextStyle(
              fontSize: 15,
              color: store.connected ? Nova.mint : Nova.tertiary,
            ),
          ),
        ),
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.fromLTRB(16, 13, 16, 13),
            child: Text(
              about.isEmpty ? t('Tell Nova about yourself') : about,
              style: TextStyle(
                fontSize: 15,
                height: 1.5,
                color: about.isEmpty ? Nova.tertiary : Nova.text,
              ),
            ),
          ),
        ],
      ),
      if (work.isNotEmpty)
        NovaSection(
          header: t('Recently working on'),
          children: [
            for (final item in work)
              NovaTile(
                title: '${item['title'] ?? ''}',
                titleLines: 1,
                subtitle: Text('${item['text'] ?? ''}'),
              ),
          ],
        ),
      if (overview != null && '${overview['summary'] ?? ''}'.isNotEmpty)
        NovaSection(
          header: t('Memory'),
          children: [
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(16, 13, 16, 13),
              child: Text(
                '${overview['summary']}',
                style: const TextStyle(fontSize: 15, height: 1.5),
              ),
            ),
          ],
        ),
      NovaSection(
        header: overview == null ? t('Memory') : null,
        children: [
          if (entries.isEmpty)
            NovaTile(title: t('Nothing remembered yet'))
          else
            for (final entry in entries)
              NovaTile(
                title: entry['content'] as String,
                subtitle: MetaLine([
                  _label('kind', entry['kind']),
                  _label('origin', entry['origin']),
                  relativeTime(
                    entry['observed_at'] as String?,
                    widget.language,
                  ),
                  if ((entry['evidence_refs'] as List? ?? []).isNotEmpty)
                    t('{0} evidence').replaceFirst(
                      '{0}',
                      '${(entry['evidence_refs'] as List).length}',
                    ),
                ]),
                onTap:
                    store.connected &&
                        entry['version'] != null &&
                        entry['editable'] != false
                    ? () => _memoryActions(entry)
                    : null,
              ),
          if (memory['cursor'] != null)
            NovaTile(
              title: t('More memories'),
              trailing: const CupertinoListTileChevron(),
              onTap: store.connected
                  ? () => _run(
                      () => store.command('memory.list', {
                        'cursor': memory['cursor'],
                      }),
                    )
                  : null,
            ),
        ],
      ),
      NovaSection(
        header: t('Device & connection'),
        children: [
          NovaTile(
            title: t(store.connected ? 'Mac connected' : 'Offline'),
            leading: Icon(
              store.connected
                  ? CupertinoIcons.desktopcomputer
                  : CupertinoIcons.wifi_slash,
              size: 22,
              color: store.connected ? Nova.mint : Nova.tertiary,
            ),
            subtitle: Text(t('Tailscale · one phone at a time')),
            trailing: const CupertinoListTileChevron(),
            onTap: widget.onSettings,
          ),
        ],
      ),
    ];
  }

  Future<void> _memoryActions(Map<String, dynamic> entry) async {
    final action = await showNovaActions(
      context,
      language: widget.language,
      title: entry['content'] as String?,
      actions: [
        (value: 'correct', label: t('Correct'), destructive: false),
        (value: 'forget', label: t('Forget'), destructive: true),
      ],
    );
    if (!mounted || action == null) return;
    final content = action == 'correct'
        ? await _edit('Memory', entry['content'] as String? ?? '', limit: 500)
        : null;
    if (action == 'correct' && content == null) return;
    await _run(
      () => store.command('memory.$action', {
        'id': entry['id'],
        'expected_version': entry['version'],
        'content': ?content,
      }),
    );
  }

  Widget _notice(String text, {IconData icon = CupertinoIcons.wifi_slash}) =>
      Padding(
        padding: const EdgeInsets.fromLTRB(32, 0, 32, 12),
        child: Row(
          children: [
            Icon(icon, size: 14, color: Nova.amber),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                text,
                style: const TextStyle(color: Nova.amber, fontSize: 13),
              ),
            ),
          ],
        ),
      );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: store,
    builder: (context, _) {
      final snapshot = store.snapshot, life = snapshot?.object('life') ?? {};
      final todos = _rows(life['todos']);
      final feeds =
          (snapshot?.rows('feed') ?? [])
              .where(
                (f) =>
                    f['lifecycle'] == 'active' &&
                    !['dismissed', 'snoozed'].contains(f['user_state']),
              )
              .toList()
            ..sort((a, b) {
              final priority = (b['priority'] as num? ?? 0).compareTo(
                a['priority'] as num? ?? 0,
              );
              return priority != 0
                  ? priority
                  : '${b['created_at'] ?? ''}'.compareTo(
                      '${a['created_at'] ?? ''}',
                    );
            });
      final tasks = (snapshot?.rows('tasks') ?? [])
          .where((t) => activePhases.contains(t['phase']))
          .toList();
      final news = snapshot?.object('news') ?? {};
      final articles = _rows(news[_saved ? 'saved' : 'items']);
      final rows = widget.page == 3 || widget.page == 4
          ? _rows(
              life[_kind == 'goal' ? 'goals' : 'ideas'],
            ).where((r) => r['status'] != 'archived').toList()
          : const <Map<String, dynamic>>[];
      _checkPresented();
      return Scaffold(
        backgroundColor: Colors.transparent,
        floatingActionButton: widget.page >= 2 && widget.page <= 4
            ? FloatingActionButton(
                tooltip: 'New $_kind',
                onPressed: store.connected ? _create : null,
                backgroundColor: store.connected
                    ? Nova.mint
                    : Nova.mint.withValues(alpha: .25),
                child: const Icon(CupertinoIcons.add, size: 26),
              )
            : null,
        body: NotificationListener<ScrollNotification>(
          onNotification: (_) {
            _checkPresented();
            return false;
          },
          child: RefreshIndicator(
            color: Nova.mint,
            backgroundColor: Nova.cell,
            onRefresh: () async => store.refresh(force: true),
            child: ListView(
              key: _viewport,
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.only(top: 4, bottom: 104),
              children: [
                if (widget.showHeading)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
                    child: Text(
                      t(
                        const [
                          'Reminders',
                          'Feeds',
                          'Todos',
                          'Ideas',
                          'Goals',
                          'Profile',
                        ][widget.page],
                      ),
                      style: const TextStyle(
                        fontSize: 28,
                        fontWeight: FontWeight.w700,
                        letterSpacing: -.5,
                      ),
                    ),
                  ),
                if (!store.connected)
                  _notice(
                    t('Offline · cached data. Reconnect to make changes.'),
                  ),
                if (store.error != null)
                  _notice(
                    store.error!,
                    icon: CupertinoIcons.exclamationmark_circle,
                  ),
                if (widget.page == 0) ...[
                  if (tasks.isNotEmpty)
                    NovaSection(
                      header: t('In progress'),
                      children: tasks.map(_task).toList(),
                    ),
                  if (feeds.isEmpty)
                    EmptyNote(
                      t('No active reminders'),
                      icon: CupertinoIcons.bell,
                    ),
                  ...feeds.map(_feed),
                ],
                if (widget.page == 1) ...[
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
                    child: CupertinoSlidingSegmentedControl<bool>(
                      groupValue: _saved,
                      backgroundColor: const Color(0xff1f252c),
                      thumbColor: const Color(0xff4a515a),
                      children: {
                        false: Text(t('For you')),
                        true: Text(t('Saved')),
                      },
                      onValueChanged: (value) =>
                          setState(() => _saved = value ?? false),
                    ),
                  ),
                  if (articles.isEmpty)
                    EmptyNote(
                      t(
                        _saved
                            ? 'No saved articles yet'
                            : news['enabled'] == false
                            ? 'News updates are off. Turn them on in the Mac workbench.'
                            : 'No news recommendations yet',
                      ),
                      icon: CupertinoIcons.news,
                    )
                  else
                    NovaSection(children: articles.map(_article).toList()),
                ],
                if (widget.page == 2) ...[
                  ..._todoGroups(todos),
                  ..._suggestions(
                    'todos',
                    todos.any((t) => t['status'] != 'cancelled'),
                  ),
                ],
                if (widget.page == 3) ...[
                  if (rows.isNotEmpty)
                    NovaSection(children: rows.map(_item).toList()),
                  ..._suggestions('ideas', rows.isNotEmpty),
                ],
                if (widget.page == 4) ...[
                  if (rows.isNotEmpty)
                    NovaSection(
                      children: [
                        for (final row in rows) ...[
                          _item({...row, 'kind': 'goal'}),
                          for (final todo in todos.where(
                            (t) =>
                                t['goal_id'] == row['id'] &&
                                t['status'] != 'cancelled',
                          ))
                            _item({...todo, 'kind': 'todo'}, nested: true),
                        ],
                      ],
                    ),
                  ..._suggestions('goals', rows.isNotEmpty),
                ],
                if (widget.page == 5) ..._profile(life),
              ],
            ),
          ),
        ),
      );
    },
  );
}
