import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'components.dart';
import 'strings.dart';
import 'theme.dart';

class TodoEditor extends StatefulWidget {
  const TodoEditor({
    super.key,
    required this.row,
    required this.goals,
    required this.tasks,
    this.language = 'en',
  });
  final Map<String, dynamic> row;
  final List<Map<String, dynamic>> goals, tasks;
  final String language;
  @override
  State<TodoEditor> createState() => _TodoEditorState();
}

class _TodoEditorState extends State<TodoEditor> {
  late final title = TextEditingController(
    text: widget.row['title'] as String? ?? '',
  );
  late final note = TextEditingController(
    text: widget.row['note'] as String? ?? '',
  );
  late String? due = widget.row['due'] as String?,
      goal = widget.goals.any((g) => g['id'] == widget.row['goal_id'])
          ? widget.row['goal_id'] as String?
          : null;
  String t(String text) => tr(widget.language, text);
  @override
  void initState() {
    super.initState();
    title.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    title.dispose();
    note.dispose();
    super.dispose();
  }

  Future<void> _pickDue() async {
    var picked = DateTime.tryParse(due ?? '') ?? DateTime.now();
    final ok = await showCupertinoModalPopup<bool>(
      context: context,
      builder: (context) => Container(
        height: 300,
        color: Nova.sheet,
        child: SafeArea(
          top: false,
          child: Column(
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  CupertinoButton(
                    onPressed: () => Navigator.pop(context, true),
                    child: Text(
                      t('Done'),
                      style: const TextStyle(
                        color: Nova.mint,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
              Expanded(
                child: CupertinoTheme(
                  data: const CupertinoThemeData(brightness: Brightness.dark),
                  child: CupertinoDatePicker(
                    mode: CupertinoDatePickerMode.date,
                    initialDateTime: picked,
                    minimumYear: 2020,
                    maximumYear: 2100,
                    onDateTimeChanged: (value) => picked = value,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    if (ok == true && mounted) {
      setState(() => due = picked.toIso8601String().substring(0, 10));
    }
  }

  Future<void> _pickGoal() async {
    final value = await showNovaActions(
      context,
      language: widget.language,
      title: t('Goal'),
      actions: [
        (value: '', label: t('No goal'), destructive: false),
        for (final g in widget.goals)
          if (g['status'] != 'archived' || g['id'] == goal)
            (
              value: g['id'] as String,
              label: '${g['title']}',
              destructive: false,
            ),
      ],
    );
    if (value != null && mounted) {
      setState(() => goal = value.isEmpty ? null : value);
    }
  }

  @override
  Widget build(BuildContext context) {
    final goalTitle = widget.goals
        .where((g) => g['id'] == goal)
        .firstOrNull?['title'];
    final label = dueLabel(due, widget.language);
    final tasks = widget.tasks
        .where((task) => (task['todo_ref'] as Map?)?['id'] == widget.row['id'])
        .toList();
    const plain = InputDecoration(
      filled: false,
      border: InputBorder.none,
      isDense: true,
      counterText: '',
      contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 13),
    );
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            SheetHeader(
              title: t('Todo details'),
              cancel: t('Cancel'),
              done: t('Save'),
              onDone: title.text.trim().isEmpty
                  ? null
                  : () => Navigator.pop(context, {
                      'title': title.text.trim(),
                      'note': note.text.trim(),
                      'due': due,
                      'goal_id': goal,
                    }),
            ),
            const SizedBox(height: 8),
            _group([
              TextField(
                controller: title,
                maxLength: 200,
                style: const TextStyle(fontSize: 17),
                decoration: plain.copyWith(hintText: t('Title')),
              ),
              TextField(
                controller: note,
                maxLength: 4000,
                minLines: 3,
                maxLines: 6,
                style: const TextStyle(fontSize: 15, height: 1.4),
                decoration: plain.copyWith(hintText: t('Notes')),
              ),
            ]),
            _group([
              _row(
                CupertinoIcons.calendar,
                t('Due date'),
                label?.text ?? t('None'),
                urgent: label?.urgent == true,
                onTap: _pickDue,
                clear: due == null ? null : () => setState(() => due = null),
              ),
              _row(
                CupertinoIcons.flag,
                t('Goal'),
                goalTitle == null ? t('None') : '$goalTitle',
                onTap: _pickGoal,
              ),
            ]),
            if (tasks.isNotEmpty)
              _group([
                for (final task in tasks)
                  _row(
                    CupertinoIcons.bolt,
                    '${task['goal']}',
                    tr(widget.language, 'phase:${task['phase']}'),
                  ),
              ]),
            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }

  Widget _group(List<Widget> children) => Container(
    margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
    decoration: BoxDecoration(
      color: Nova.sheetCell,
      borderRadius: BorderRadius.circular(12),
    ),
    child: Column(
      children: [
        for (final (i, child) in children.indexed) ...[
          if (i > 0)
            const Divider(
              height: 1,
              thickness: .5,
              indent: 16,
              color: Nova.separator,
            ),
          child,
        ],
      ],
    ),
  );

  Widget _row(
    IconData icon,
    String label,
    String value, {
    bool urgent = false,
    VoidCallback? onTap,
    VoidCallback? clear,
  }) => InkWell(
    onTap: onTap,
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
      child: Row(
        children: [
          Icon(icon, size: 20, color: Nova.secondary),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 16),
            ),
          ),
          Flexible(
            child: Text(
              value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 16,
                color: urgent ? Nova.amber : Nova.secondary,
              ),
            ),
          ),
          if (clear != null)
            GestureDetector(
              onTap: clear,
              child: const Padding(
                padding: EdgeInsets.only(left: 8),
                child: Icon(
                  CupertinoIcons.xmark_circle_fill,
                  size: 18,
                  color: Nova.tertiary,
                ),
              ),
            )
          else if (onTap != null)
            const Padding(
              padding: EdgeInsets.only(left: 6),
              child: Icon(
                CupertinoIcons.chevron_right,
                size: 14,
                color: Nova.tertiary,
              ),
            ),
        ],
      ),
    ),
  );
}
