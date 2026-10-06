final class ApprovalCard {
  ApprovalCard({
    required this.id,
    required this.executor,
    required this.project,
    required this.title,
    required this.detail,
    required this.decisions,
    required this.deadline,
    required this.busy,
  });
  final String id, project, title, detail;
  final String? executor;
  final List<String> decisions;
  final DateTime? deadline;
  final bool busy;
  bool actionable(DateTime now) =>
      !busy && deadline != null && deadline!.isAfter(now);
}

final class Approvals {
  final cards = <ApprovalCard>[];
  final submitted = <String>{};
  String project = '';
  void clear() {
    cards.clear();
    submitted.clear();
  }

  DateTime? _deadline(dynamic value) =>
      value is num && value.isFinite && value >= 0 && value <= 3600
      ? DateTime.now().add(Duration(milliseconds: (value * 1000).round()))
      : null;
  void receive(Map<String, dynamic> v) {
    final executor = v['type'] == 'executor.approval' ? v['executor'] : null;
    if (v['type'] != 'project.state' && v['type'] != 'executor.approval') {
      return;
    }
    if (executor != null && executor is! String) return;
    final isProject = v['type'] == 'project.state';
    cards.removeWhere((card) => card.executor == executor);
    if (isProject) {
      project = [
        v['workspace_display_name'],
        v['session_title'],
      ].whereType<String>().join(' · ');
    }
    final id = v[isProject ? 'pending_confirmation_id' : 'pending_approval_id'];
    if (v[isProject ? 'pending_confirmation' : 'pending_approval'] != true ||
        id is! String ||
        id.isEmpty ||
        id.runes.length > 128) {
      return;
    }
    final work = v['work'] is Map ? v['work'] as Map : {};
    final detail = v['local_detail'] is Map ? v['local_detail'] as Map : {};
    if (!isProject && v['local_detail'] is! Map) return;
    final decisions = v['allowed_decisions'] is List
        ? (v['allowed_decisions'] as List)
              .whereType<String>()
              .where(
                (d) => ['accept', 'acceptForSession', 'decline'].contains(d),
              )
              .toList()
        : ['accept', 'decline'];
    cards.add(
      ApprovalCard(
        id: id,
        executor: executor as String?,
        project:
            (isProject ? v['pending_workspace_display_name'] : work['project'])
                as String? ??
            project,
        title:
            (isProject ? v['pending_session_title'] : work['title'])
                as String? ??
            (isProject ? 'Confirm project' : executor as String),
        detail: isProject
            ? v['pending_action'] as String? ?? 'Confirm this project'
            : [
                v['operation_summary'],
                detail['command'],
                detail['cwd'],
                detail['scope'],
                if (detail['changes'] is List)
                  ...(detail['changes'] as List).whereType<Map>().map(
                    (c) => [
                      c['change'],
                      c['path'],
                      c['move_path'],
                    ].whereType<String>().join(' → '),
                  ),
              ].whereType<String>().join('\n'),
        decisions: isProject ? ['accept', 'decline'] : decisions,
        deadline: _deadline(
          v[isProject ? 'pending_expires_in_seconds' : 'expires_in_seconds'],
        ),
        busy:
            v[isProject
                ? 'pending_confirmation_busy'
                : 'pending_approval_busy'] !=
            false,
      ),
    );
    if (cards.length > 16) throw const FormatException('Too many approvals');
  }

  Map<String, dynamic>? decide(ApprovalCard card, String decision) {
    if (!cards.contains(card) ||
        !card.actionable(DateTime.now()) ||
        submitted.contains(card.id) ||
        !card.decisions.contains(decision)) {
      return null;
    }
    submitted.add(card.id);
    return card.executor == null
        ? {
            'type': 'project.confirmation_decision',
            'proposal_id': card.id,
            'confirmed': decision == 'accept',
          }
        : {
            'type': 'executor.approval_decision',
            'executor': card.executor,
            'approval_id': card.id,
            'approved': decision != 'decline',
            if (decision == 'acceptForSession') 'scope': 'session',
          };
  }
}
