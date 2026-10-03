import 'package:flutter/material.dart';
import '../personal/personal_store.dart';
import '../personal/commands.dart';

class WorkbenchPage extends StatefulWidget {
  const WorkbenchPage({
    super.key,
    required this.store,
    required this.page,
    required this.onSettings,
    this.onOpenConversation,
  });
  final PersonalStore store;
  final int page;
  final VoidCallback onSettings;
  final VoidCallback? onOpenConversation;
  @override
  State<WorkbenchPage> createState() => _WorkbenchPageState();
}

class _WorkbenchPageState extends State<WorkbenchPage> {
  String _segment = 'todo';
  final _presented = <String>{};
  final _viewport = GlobalKey();
  final _feedKeys = <String, GlobalKey>{};
  bool _checking = false;
  PersonalStore get store => widget.store;
  List<Map<String, dynamic>> _rows(Object? value) => (value as List? ?? [])
      .map((v) => Map<String, dynamic>.from(v as Map))
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

  Future<String?> _edit(String label, String value, {int limit = 200}) async {
    final controller = TextEditingController(text: value);
    final result = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(label),
        content: TextField(
          controller: controller,
          autofocus: true,
          maxLength: limit,
          minLines: 1,
          maxLines: 5,
          decoration: InputDecoration(labelText: label),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, controller.text.trim()),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    // Dialog reverse animation may still read its controller this frame.
    WidgetsBinding.instance.addPostFrameCallback((_) => controller.dispose());
    return result;
  }

  Future<void> _create() async {
    final title = await _edit('New $_segment', '');
    if (title == null || title.isEmpty) return;
    final result = await _run(
      () => store.mutate({'op': 'create', 'kind': _segment, 'title': title}),
    );
    if (!mounted || result is! Map || _segment != 'todo') return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: const Text('Todo created'),
        action: SnackBarAction(
          label: 'Undo',
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
        content: Text('${row['title']} · $status'),
        action: SnackBarAction(
          label: 'Undo',
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

  Widget _heading(String text) => Padding(
    padding: const EdgeInsets.only(top: 20, bottom: 8),
    child: Text(text, style: Theme.of(context).textTheme.titleLarge),
  );
  Widget _item(Map<String, dynamic> row) {
    final kind = row['kind'] as String? ?? _segment;
    final item = {...row, 'kind': kind};
    final progress = row['progress'] as Map?;
    return Dismissible(
      key: ValueKey('life:${row['id']}'),
      confirmDismiss: (direction) async {
        if (store.connected) {
          await _status(
            item,
            kind == 'todo'
                ? (direction == DismissDirection.startToEnd
                      ? 'done'
                      : 'cancelled')
                : 'archived',
          );
        }
        return false;
      },
      background: const ColoredBox(
        color: Colors.teal,
        child: Align(
          alignment: Alignment.centerLeft,
          child: Padding(padding: EdgeInsets.all(16), child: Icon(Icons.check)),
        ),
      ),
      secondaryBackground: const ColoredBox(
        color: Colors.blueGrey,
        child: Align(
          alignment: Alignment.centerRight,
          child: Padding(
            padding: EdgeInsets.all(16),
            child: Icon(Icons.archive_outlined),
          ),
        ),
      ),
      child: Card(
        child: ListTile(
          leading: kind == 'todo'
              ? Checkbox(
                  value: row['status'] == 'done',
                  onChanged: store.connected
                      ? (value) =>
                            _status(item, value == true ? 'done' : 'open')
                      : null,
                )
              : Icon(
                  kind == 'goal'
                      ? Icons.flag_outlined
                      : Icons.lightbulb_outline,
                ),
          title: Text('${row['title']}'),
          subtitle: Text(
            [
              row['status'],
              if (row['due'] != null) 'Due ${row['due']}',
              if (progress != null) '${progress['done']}/${progress['total']}',
              if (row['goal_id'] != null) 'Goal: ${row['goal_id']}',
              if (row['idea_id'] != null) 'Idea: ${row['idea_id']}',
              row['note'],
            ].where((s) => s != null && s != '').join(' · '),
          ),
          onTap: store.connected
              ? () async {
                  final title = await _edit('Title', '${row['title']}');
                  if (title != null && title.isNotEmpty) {
                    await _run(() => store.updateItem(item, {'title': title}));
                  }
                }
              : null,
          trailing: PopupMenuButton<String>(
            enabled: store.connected,
            onSelected: (action) async {
              if (action == 'note') {
                final note = await _edit(
                  'Notes',
                  row['note'] as String? ?? '',
                  limit: 4000,
                );
                if (note != null) {
                  await _run(() => store.updateItem(item, {'note': note}));
                }
              } else if (action == 'due') {
                final day = await showDatePicker(
                  context: context,
                  initialDate:
                      DateTime.tryParse(row['due'] as String? ?? '') ??
                      DateTime.now(),
                  firstDate: DateTime(2020),
                  lastDate: DateTime(2100),
                );
                if (day != null) {
                  await _run(
                    () => store.updateItem(item, {
                      'due': day.toIso8601String().substring(0, 10),
                    }),
                  );
                }
              } else if (action == 'goal' || action == 'todo') {
                await _run(
                  () => store.mutate({
                    'op': 'convert',
                    'id': row['id'],
                    'expected_version': row['version'],
                    'target': action,
                  }),
                );
              } else {
                await _status(item, action);
              }
            },
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'note', child: Text('Edit notes')),
              if (kind == 'todo')
                const PopupMenuItem(value: 'due', child: Text('Due date')),
              if (kind == 'idea') ...const [
                PopupMenuItem(value: 'goal', child: Text('Convert to goal')),
                PopupMenuItem(value: 'todo', child: Text('Convert to todo')),
              ],
              if (kind == 'goal') ...const [
                PopupMenuItem(value: 'completed', child: Text('Complete')),
                PopupMenuItem(value: 'paused', child: Text('Pause')),
              ],
              PopupMenuItem(
                value: kind == 'todo' ? 'cancelled' : 'archived',
                child: const Text('Archive'),
              ),
            ],
          ),
        ),
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

  Widget _feed(Map<String, dynamic> row) => Card(
    key: _feedKeys.putIfAbsent(row['id'] as String, () => GlobalKey()),
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${row['title']}',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          if ((row['prepared'] as Map?)?['text'] != null)
            Text('${(row['prepared'] as Map)['text']}'),
          Text(row['why_now'] as String? ?? ''),
          Wrap(
            spacing: 8,
            children: [
              TextButton(
                onPressed: store.connected
                    ? () => _run(() async {
                        await store.command('conversations.open_feed', {
                          'feed_id': row['id'],
                          'label': row['action_label'] ?? 'Execute',
                        });
                        if (mounted) widget.onOpenConversation?.call();
                      })
                    : null,
                child: const Text('Execute'),
              ),
              TextButton(
                onPressed: store.connected
                    ? () => _run(
                        () => store.command('feed.action', {
                          'id': row['id'],
                          'action': 'snooze',
                          'snooze_until': DateTime.now()
                              .toUtc()
                              .add(const Duration(hours: 1))
                              .toIso8601String(),
                        }),
                      )
                    : null,
                child: const Text('Later'),
              ),
              TextButton(
                onPressed: store.connected
                    ? () => _run(
                        () => store.command('feed.action', {
                          'id': row['id'],
                          'action': 'dismiss',
                        }),
                      )
                    : null,
                child: const Text('Ignore'),
              ),
            ],
          ),
        ],
      ),
    ),
  );
  Widget _task(Map<String, dynamic> task) => Card(
    child: ListTile(
      title: Text('${task['goal'] ?? task['title'] ?? 'Task'}'),
      subtitle: Text('${task['phase']} · ${task['waiting_reason'] ?? ''}'),
      onTap: store.connected
          ? () => _run(() async {
              await store.command('conversations.select', {
                'id': task['conversation_id'],
              });
              if (mounted) widget.onOpenConversation?.call();
            })
          : null,
      trailing: PopupMenuButton<String>(
        enabled: store.connected,
        itemBuilder: (_) => const [
          PopupMenuItem(value: 'cancel', child: Text('Cancel task')),
          PopupMenuItem(value: 'continue', child: Text('Continue task')),
        ],
        onSelected: (action) => _run(
          () => store.command('tasks.$action', {
            'task_id': task['id'],
            'goal_revision': task['goal_revision'],
            'control_revision': task['control_revision'],
          }),
        ),
      ),
    ),
  );
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: store,
    builder: (context, _) {
      final snapshot = store.snapshot, life = snapshot?.object('life') ?? {};
      final todos = _rows(life['todos']), goals = _rows(life['goals']);
      final feeds = (snapshot?.rows('feed') ?? [])
          .where(
            (f) =>
                f['lifecycle'] == 'active' &&
                !['dismissed', 'snoozed'].contains(f['user_state']),
          )
          .toList();
      _checkPresented();
      return NotificationListener<ScrollNotification>(
        onNotification: (_) {
          _checkPresented();
          return false;
        },
        child: ListView(
          key: _viewport,
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
          children: [
            Text(
              widget.page == 0
                  ? 'Reminders'
                  : widget.page == 1
                  ? 'Today'
                  : widget.page == 2
                  ? 'Plan'
                  : 'Me',
              style: Theme.of(context).textTheme.headlineMedium,
            ),
            if (!store.connected)
              const Text('Offline · cached data. Reconnect to make changes.'),
            if (store.error != null) Text(store.error!),
            if (store.connected)
              Align(
                alignment: Alignment.centerRight,
                child: TextButton.icon(
                  onPressed: () => store.refresh(force: true),
                  icon: const Icon(Icons.refresh),
                  label: const Text('Refresh'),
                ),
              ),
            if (widget.page <= 1) ...[
              _heading('Reminders'),
              if (feeds.isEmpty) const Text('No active reminders'),
              ...feeds.map(_feed),
              if (widget.page == 1) ...[
                _heading('Today’s todos'),
                ...todos
                    .where(
                      (t) =>
                          !['done', 'cancelled'].contains(t['status']) &&
                          (t['due'] == null ||
                              '${t['due']}'.compareTo(
                                    DateTime.now().toIso8601String().substring(
                                      0,
                                      10,
                                    ),
                                  ) <=
                                  0),
                    )
                    .map(_item),
                _heading('Active tasks'),
                ...(snapshot?.rows('tasks') ?? [])
                    .where(
                      (t) => !['completed', 'cancelled'].contains(t['phase']),
                    )
                    .map(_task),
                _heading('Goal progress'),
                ...goals.where((g) => g['status'] == 'active').map(_item),
              ],
            ],
            if (widget.page == 2) ...[
              const SizedBox(height: 16),
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'todo', label: Text('Todos')),
                  ButtonSegment(value: 'goal', label: Text('Goals')),
                  ButtonSegment(value: 'idea', label: Text('Ideas')),
                ],
                selected: {_segment},
                onSelectionChanged: (v) => setState(() => _segment = v.first),
              ),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton.icon(
                  onPressed: store.connected ? _create : null,
                  icon: const Icon(Icons.add),
                  label: const Text('Add'),
                ),
              ),
              ..._rows(
                life[_segment == 'todo'
                    ? 'todos'
                    : _segment == 'goal'
                    ? 'goals'
                    : 'ideas'],
              ).map(_item),
            ],
            if (widget.page == 3) ...[
              _heading('Profile'),
              Text(
                (life['profile'] as Map?)?['about'] as String? ??
                    'Tell Nova about yourself',
              ),
              TextButton(
                onPressed: store.connected
                    ? () async {
                        final profile = life['profile'] as Map? ?? {};
                        final about = await _edit(
                          'About you',
                          profile['about'] as String? ?? '',
                          limit: 5000,
                        );
                        if (about != null) {
                          await _run(
                            () => store.mutate({
                              'op': 'profile',
                              'about': about,
                              'expected_version': profile['version'] ?? 0,
                            }),
                          );
                        }
                      }
                    : null,
                child: const Text('Edit profile'),
              ),
              _heading('Memory'),
              ..._rows(snapshot?.object('memory')['entries']).map(
                (entry) => Card(
                  child: ListTile(
                    title: Text(entry['content'] as String? ?? ''),
                    subtitle: Text('${entry['kind']} · ${entry['status']}'),
                    trailing: PopupMenuButton<String>(
                      enabled:
                          store.connected &&
                          entry['version'] != null &&
                          entry['editable'] != false,
                      itemBuilder: (_) => const [
                        PopupMenuItem(value: 'correct', child: Text('Correct')),
                        PopupMenuItem(value: 'forget', child: Text('Forget')),
                      ],
                      onSelected: (action) async {
                        final content = action == 'correct'
                            ? await _edit(
                                'Memory',
                                entry['content'] as String? ?? '',
                                limit: 500,
                              )
                            : null;
                        if (action == 'correct' && content == null) return;
                        await _run(
                          () => store.command('memory.$action', {
                            'id': entry['id'],
                            'expected_version': entry['version'],
                            'content': ?content,
                          }),
                        );
                      },
                    ),
                  ),
                ),
              ),
              if (snapshot?.object('memory')['cursor'] != null)
                TextButton(
                  onPressed: store.connected
                      ? () => _run(
                          () => store.command('memory.list', {
                            'cursor': snapshot!.object('memory')['cursor'],
                          }),
                        )
                      : null,
                  child: const Text('More memories'),
                ),
              _heading('Device & connection'),
              ListTile(
                leading: Icon(store.connected ? Icons.link : Icons.link_off),
                title: Text(store.connected ? 'Mac connected' : 'Offline'),
                subtitle: const Text('Tailscale · one phone at a time'),
                trailing: const Icon(Icons.chevron_right),
                onTap: widget.onSettings,
              ),
            ],
          ],
        ),
      );
    },
  );
}
