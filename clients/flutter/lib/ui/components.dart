import 'dart:math' as math;
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'strings.dart';
import 'theme.dart';

/// iOS inset-grouped section in Nova colours.
class NovaSection extends StatelessWidget {
  const NovaSection({
    super.key,
    required this.children,
    this.header,
    this.footer,
    this.trailing,
    this.onHeaderTap,
  });
  final List<Widget> children;
  final String? header, footer;
  final Widget? trailing;
  final VoidCallback? onHeaderTap;
  @override
  Widget build(BuildContext context) => CupertinoListSection.insetGrouped(
    backgroundColor: Colors.transparent,
    decoration: BoxDecoration(
      color: Nova.cell,
      borderRadius: BorderRadius.circular(12),
    ),
    separatorColor: Nova.separator,
    margin: const EdgeInsets.fromLTRB(16, 0, 16, 10),
    header: header == null
        ? null
        : GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: onHeaderTap,
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    header!,
                    style: const TextStyle(
                      color: Nova.secondary,
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
                ?trailing,
              ],
            ),
          ),
    footer: footer == null
        ? null
        : Text(
            footer!,
            style: const TextStyle(color: Nova.secondary, fontSize: 13),
          ),
    children: children,
  );
}

class NovaTile extends StatelessWidget {
  const NovaTile({
    super.key,
    required this.title,
    this.subtitle,
    this.leading,
    this.trailing,
    this.onTap,
    this.titleLines = 3,
  });
  final String title;
  final Widget? subtitle, leading, trailing;
  final VoidCallback? onTap;
  final int titleLines;
  @override
  Widget build(BuildContext context) => CupertinoListTile(
    backgroundColor: Nova.cell,
    backgroundColorActivated: Nova.cellPressed,
    padding: const EdgeInsetsDirectional.fromSTEB(16, 11, 14, 11),
    leadingSize: 26,
    leadingToTitle: 12,
    leading: leading,
    title: Text(
      title,
      maxLines: titleLines,
      overflow: TextOverflow.ellipsis,
      style: const TextStyle(color: Nova.text, fontSize: 16, height: 1.3),
    ),
    subtitle: subtitle == null
        ? null
        : DefaultTextStyle.merge(
            style: const TextStyle(
              color: Nova.secondary,
              fontSize: 13,
              height: 1.35,
            ),
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
            child: Padding(
              padding: const EdgeInsets.only(top: 3),
              child: subtitle!,
            ),
          ),
    trailing: trailing,
    onTap: onTap,
  );
}

/// Secondary line made of short parts; urgent parts render in amber.
class MetaLine extends StatelessWidget {
  const MetaLine(this.parts, {super.key, this.urgent = const {}});
  final List<String?> parts;
  final Set<String> urgent;
  @override
  Widget build(BuildContext context) {
    final visible = parts.whereType<String>().where((p) => p.isNotEmpty);
    return Text.rich(
      TextSpan(
        children: [
          for (final (i, part) in visible.indexed) ...[
            if (i > 0) const TextSpan(text: ' · '),
            TextSpan(
              text: part,
              style: urgent.contains(part)
                  ? const TextStyle(color: Nova.amber)
                  : null,
            ),
          ],
        ],
      ),
    );
  }
}

class RoundCheck extends StatelessWidget {
  const RoundCheck({super.key, required this.value, this.onChanged});
  final bool value;
  final ValueChanged<bool>? onChanged;
  @override
  Widget build(BuildContext context) => Semantics(
    checked: value,
    button: true,
    enabled: onChanged != null,
    child: GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onChanged == null ? null : () => onChanged!(!value),
      child: SizedBox(
        width: 26,
        height: 26,
        child: Center(
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 160),
            width: 22,
            height: 22,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: value ? Nova.mint : Colors.transparent,
              border: Border.all(
                color: value
                    ? Nova.mint
                    : onChanged == null
                    ? Nova.tertiary
                    : Nova.secondary,
                width: 1.6,
              ),
            ),
            child: value
                ? const Icon(Icons.check_rounded, size: 15, color: Nova.ink)
                : null,
          ),
        ),
      ),
    ),
  );
}

class ProgressRing extends StatelessWidget {
  const ProgressRing({super.key, required this.done, required this.total});
  final num done, total;
  @override
  Widget build(BuildContext context) => SizedBox(
    width: 26,
    height: 26,
    child: CustomPaint(
      painter: _Ring(total > 0 ? (done / total).clamp(0, 1).toDouble() : 0),
    ),
  );
}

class _Ring extends CustomPainter {
  _Ring(this.value);
  final double value;
  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.6
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(
      rect.deflate(2),
      0,
      math.pi * 2,
      false,
      paint..color = Nova.separator,
    );
    if (value > 0) {
      canvas.drawArc(
        rect.deflate(2),
        -math.pi / 2,
        math.pi * 2 * value,
        false,
        paint..color = Nova.mint,
      );
    }
  }

  @override
  bool shouldRepaint(_Ring old) => old.value != value;
}

/// Quiet empty state inside a grouped list.
class EmptyNote extends StatelessWidget {
  const EmptyNote(this.text, {super.key, this.icon});
  final String text;
  final IconData? icon;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(32, 28, 32, 24),
    child: Column(
      children: [
        if (icon != null) Icon(icon, size: 30, color: Nova.tertiary),
        if (icon != null) const SizedBox(height: 10),
        Text(
          text,
          textAlign: TextAlign.center,
          style: const TextStyle(
            color: Nova.secondary,
            fontSize: 14,
            height: 1.45,
          ),
        ),
      ],
    ),
  );
}

/// One rounded block for longer content (reminders, suggestions, summaries).
class NovaCard extends StatelessWidget {
  const NovaCard({super.key, required this.child, this.onTap});
  final Widget child;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
    child: Material(
      color: Nova.cell,
      borderRadius: BorderRadius.circular(12),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(padding: const EdgeInsets.all(16), child: child),
      ),
    ),
  );
}

/// Plain mint text action, iOS style.
class LinkAction extends StatelessWidget {
  const LinkAction(this.label, {super.key, this.onPressed, this.muted = false});
  final String label;
  final VoidCallback? onPressed;
  final bool muted;
  @override
  Widget build(BuildContext context) => CupertinoButton(
    padding: const EdgeInsets.only(right: 18, top: 6, bottom: 2),
    minimumSize: const Size(0, 30),
    onPressed: onPressed,
    child: Text(
      label,
      style: TextStyle(
        fontSize: 15,
        fontWeight: FontWeight.w500,
        color: onPressed == null
            ? Nova.tertiary
            : muted
            ? Nova.secondary
            : Nova.mint,
      ),
    ),
  );
}

String relativeTime(String? iso, String language, {DateTime? now}) {
  final time = iso == null ? null : DateTime.tryParse(iso)?.toLocal();
  if (time == null) return '';
  final current = now ?? DateTime.now(), zh = language == 'zh';
  final age = current.difference(time);
  if (age.inMinutes < 1) return zh ? '刚刚' : 'Just now';
  if (age.inHours < 1) {
    return zh ? '${age.inMinutes} 分钟前' : '${age.inMinutes}m ago';
  }
  if (age.inHours < 24 && time.day == current.day) {
    return zh ? '${age.inHours} 小时前' : '${age.inHours}h ago';
  }
  final days = DateUtils.dateOnly(
    current,
  ).difference(DateUtils.dateOnly(time)).inDays;
  if (days == 1) return zh ? '昨天' : 'Yesterday';
  if (days < 7 && days > 1) return zh ? '$days 天前' : '${days}d ago';
  final sameYear = time.year == current.year;
  if (zh) return '${sameYear ? '' : '${time.year}年'}${time.month}月${time.day}日';
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return '${months[time.month - 1]} ${time.day}${sameYear ? '' : ', ${time.year}'}';
}

/// Due date label and whether it is today or overdue.
({String text, bool urgent})? dueLabel(
  Object? due,
  String language, {
  DateTime? now,
}) {
  final day = due is String ? DateTime.tryParse(due) : null;
  if (day == null) return null;
  final today = DateUtils.dateOnly(now ?? DateTime.now());
  final diff = DateUtils.dateOnly(day).difference(today).inDays;
  final zh = language == 'zh';
  final text = diff < 0
      ? (zh
            ? '已逾期 · ${day.month}月${day.day}日'
            : 'Overdue · ${day.month}/${day.day}')
      : diff == 0
      ? (zh ? '今天' : 'Today')
      : diff == 1
      ? (zh ? '明天' : 'Tomorrow')
      : (zh ? '${day.month}月${day.day}日' : '${day.month}/${day.day}');
  return (text: text, urgent: diff <= 0);
}

typedef SheetAction = ({String value, String label, bool destructive});

Future<String?> showNovaActions(
  BuildContext context, {
  required String language,
  String? title,
  required List<SheetAction> actions,
}) => showCupertinoModalPopup<String>(
  context: context,
  builder: (context) => CupertinoTheme(
    data: const CupertinoThemeData(
      brightness: Brightness.dark,
      primaryColor: Nova.mint,
    ),
    child: CupertinoActionSheet(
      title: title == null
          ? null
          : Text(title, maxLines: 2, overflow: TextOverflow.ellipsis),
      actions: [
        for (final action in actions)
          CupertinoActionSheetAction(
            isDestructiveAction: action.destructive,
            onPressed: () => Navigator.pop(context, action.value),
            child: Text(action.label),
          ),
      ],
      cancelButton: CupertinoActionSheetAction(
        isDefaultAction: true,
        onPressed: () => Navigator.pop(context),
        child: Text(tr(language, 'Cancel')),
      ),
    ),
  ),
);

/// iOS-style sheet with Cancel · title · Save for one text field.
Future<String?> editTextSheet(
  BuildContext context, {
  required String language,
  required String title,
  String value = '',
  String? hint,
  int limit = 200,
  int lines = 1,
}) async {
  final controller = TextEditingController(text: value);
  final result = await showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SheetHeader(
            title: title,
            cancel: tr(language, 'Cancel'),
            done: tr(language, 'Save'),
            onDone: () => Navigator.pop(context, controller.text.trim()),
          ),
          // Header stays pinned; the field scrolls when the keyboard leaves little room.
          Flexible(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 20),
              child: TextField(
                controller: controller,
                autofocus: true,
                maxLength: limit,
                minLines: lines,
                maxLines: math.max(lines, 6),
                style: const TextStyle(fontSize: 16, height: 1.4),
                decoration: InputDecoration(
                  hintText: hint,
                  counterStyle: const TextStyle(
                    color: Nova.tertiary,
                    fontSize: 12,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    ),
  );
  // The sheet's reverse animation may still read the controller this frame.
  WidgetsBinding.instance.addPostFrameCallback((_) => controller.dispose());
  return result;
}

class SheetHeader extends StatelessWidget {
  const SheetHeader({
    super.key,
    required this.title,
    required this.cancel,
    required this.done,
    this.onDone,
  });
  final String title, cancel, done;
  final VoidCallback? onDone;
  @override
  Widget build(BuildContext context) => Column(
    children: [
      Container(
        margin: const EdgeInsets.only(top: 6),
        width: 36,
        height: 5,
        decoration: BoxDecoration(
          color: Nova.tertiary,
          borderRadius: BorderRadius.circular(3),
        ),
      ),
      SizedBox(
        height: 48,
        child: Row(
          children: [
            CupertinoButton(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              onPressed: () => Navigator.pop(context),
              child: Text(
                cancel,
                style: const TextStyle(color: Nova.mint, fontSize: 17),
              ),
            ),
            Expanded(
              child: Text(
                title,
                textAlign: TextAlign.center,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            CupertinoButton(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              onPressed: onDone,
              child: Text(
                done,
                style: TextStyle(
                  color: onDone == null ? Nova.tertiary : Nova.mint,
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    ],
  );
}
