import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:url_launcher/url_launcher.dart';

/// The Swift client strips heading markers and renders each line separately.
class AssistantText extends StatelessWidget {
  const AssistantText(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      for (final line in text.split('\n'))
        MarkdownBody(
          data: line.replaceFirst(RegExp(r'^#{1,6} +'), ''),
          selectable: true,
          imageBuilder: (_, title, alt) => Text(alt ?? title ?? ''),
          onTapLink: (_, href, _) async {
            final uri = Uri.tryParse(href ?? '');
            if (uri != null &&
                ['https', 'http', 'mailto'].contains(uri.scheme)) {
              await launchUrl(uri, mode: LaunchMode.externalApplication);
            }
          },
        ),
    ],
  );
}
