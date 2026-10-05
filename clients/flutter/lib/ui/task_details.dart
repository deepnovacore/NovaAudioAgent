import 'package:flutter/material.dart';
import '../personal/personal_store.dart';

/// Reads task activity; extra instructions stay in the authorized conversation.
class TaskDetails extends StatefulWidget {
  const TaskDetails({
    super.key,
    required this.store,
    required this.task,
    required this.onDiscuss,
  });
  final PersonalStore store;
  final Map<String, dynamic> task;
  final Future<void> Function() onDiscuss;
  @override
  State<TaskDetails> createState() => _TaskDetailsState();
}

class _TaskDetailsState extends State<TaskDetails> {
  late Map<String, dynamic> task = widget.task;
  final events = <int, Map<String, dynamic>>{};
  int cursor = 0;
  late int snapshotRevision = widget.store.snapshot?.revision ?? -1;

  void _syncTask() {
    final snapshot = widget.store.snapshot;
    if (snapshot == null || snapshot.revision <= snapshotRevision) return;
    snapshotRevision = snapshot.revision;
    final latest = snapshot
        .rows('tasks')
        .where((row) => row['id'] == task['id'])
        .firstOrNull;
    if (latest != null) task = {...task, ...latest};
  }

  bool busy = false;
  String? error;
  bool incomplete = false;
  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    if (busy || !widget.store.connected) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final result = await widget.store.command('tasks.get', {
        'task_id': task['id'],
        'after': cursor,
      });
      if (!mounted || result is! Map) return;
      final activity = result['events'] as Map? ?? {};
      setState(() {
        task = Map<String, dynamic>.from(result);
        snapshotRevision = widget.store.snapshot?.revision ?? snapshotRevision;
        for (final event in activity['items'] as List? ?? []) {
          events[event['seq'] as int] = Map<String, dynamic>.from(event as Map);
        }
        cursor = activity['next'] as int? ?? cursor;
        incomplete =
            incomplete ||
            activity['truncated'] == true ||
            activity['incomplete'] == true;
      });
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _act(String method) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    _syncTask();
    try {
      final result = await widget.store.command(method, {
        'task_id': task['id'],
        'control_revision': task['control_revision'],
        'goal_revision': task['goal_revision'],
      });
      if (mounted && result is Map) {
        setState(() {
          task = Map<String, dynamic>.from(result);
          snapshotRevision =
              widget.store.snapshot?.revision ?? snapshotRevision;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.store,
    builder: (context, _) {
      _syncTask();
      final current = task;
      return SizedBox(
        height: MediaQuery.sizeOf(context).height * .8,
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Text(
              '${current['goal'] ?? 'Task'}',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            Text('${current['phase']} · ${current['waiting_reason'] ?? ''}'),
            if (!widget.store.connected) const Text('Offline · cached task'),
            if (error != null) Text(error!),
            if (busy) const LinearProgressIndicator(),
            Wrap(
              spacing: 8,
              children: [
                TextButton(
                  onPressed: !busy && widget.store.connected ? _refresh : null,
                  child: const Text('Load activity'),
                ),
                TextButton(
                  onPressed: !busy && widget.store.connected
                      ? () async {
                          try {
                            await widget.onDiscuss();
                          } catch (e) {
                            if (mounted) setState(() => error = e.toString());
                          }
                        }
                      : null,
                  child: const Text('Discuss / add input in Nova'),
                ),
                if (!['completed', 'cancelled'].contains(current['phase']))
                  TextButton(
                    onPressed: !busy && widget.store.connected
                        ? () => _act('tasks.cancel')
                        : null,
                    child: const Text('Cancel task'),
                  ),
              ],
            ),
            if (incomplete) const Text('Some earlier activity is unavailable.'),
            for (final event in events.values)
              ListTile(
                title: Text('${event['text'] ?? ''}'),
                subtitle: Text('${event['kind'] ?? ''}'),
              ),
            if (!busy && events.isEmpty) const Text('No task activity loaded'),
          ],
        ),
      );
    },
  );
}
