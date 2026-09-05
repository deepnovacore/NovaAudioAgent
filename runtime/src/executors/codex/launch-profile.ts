export type CodexApprovalMode = 'ask' | 'yolo'
export type CodexLaunchProfileId = 'ask' | 'ask_headless' | 'yolo'

type CodexThreadLaunch =
  | {readonly approvalPolicy: 'on-request' | 'never'; readonly approvalsReviewer: 'user'; readonly permissions: 'nova_audio_agent'}
  | {readonly approvalPolicy: 'never'; readonly approvalsReviewer: 'user'; readonly sandbox: 'danger-full-access'}

export interface CodexLaunchProfile {
  readonly id: CodexLaunchProfileId
  readonly controller: 'present' | 'absent'
  readonly thread: CodexThreadLaunch
}

const ASK = Object.freeze({
  id: 'ask' as const,
  controller: 'present' as const,
  thread: Object.freeze({approvalPolicy: 'on-request' as const, approvalsReviewer: 'user' as const, permissions: 'nova_audio_agent' as const}),
})
const ASK_HEADLESS = Object.freeze({
  id: 'ask_headless' as const,
  controller: 'absent' as const,
  thread: Object.freeze({approvalPolicy: 'never' as const, approvalsReviewer: 'user' as const, permissions: 'nova_audio_agent' as const}),
})
const YOLO = Object.freeze({
  id: 'yolo' as const,
  controller: 'absent' as const,
  thread: Object.freeze({approvalPolicy: 'never' as const, approvalsReviewer: 'user' as const, sandbox: 'danger-full-access' as const}),
})

export function resolveCodexLaunchProfile(input: {
  readonly approvalMode: CodexApprovalMode
  readonly project: boolean
  readonly foregroundBroker: boolean
}): CodexLaunchProfile {
  if (input.approvalMode === 'yolo') return YOLO
  return input.project && input.foregroundBroker ? ASK : ASK_HEADLESS
}

export function codexAppServerArgv(profile: CodexLaunchProfile, managedMcp = false): readonly string[] {
  const sandbox = 'permissions' in profile.thread
    ? ['-c', 'default_permissions="nova_audio_agent"', '-c', 'permissions.nova_audio_agent={ filesystem = { ":root" = "read", ":workspace_roots" = { "." = "write", ".git" = "read", ".agents" = "read", ".codex" = "read" } }, network = { enabled = false } }']
    : ['-c', 'sandbox_mode="danger-full-access"']
  return Object.freeze([
    '-a', profile.thread.approvalPolicy,
    '-c', `approval_policy="${profile.thread.approvalPolicy}"`,
    '-c', 'approvals_reviewer="user"',
    '--disable', 'hooks', '--disable', 'multi_agent', '--disable', 'apps', '--disable', 'plugins',
    '--disable', 'remote_plugin', '--disable', 'plugin_sharing', '--disable', 'tool_suggest',
    '-c', 'web_search="disabled"', ...sandbox,
    '-c', 'shell_environment_policy.inherit="core"',
    '-c', 'shell_environment_policy.include_only=["PATH","LANG","LC_ALL","TERM"]',
    ...(managedMcp ? [] : ['-c', 'mcp_servers={}']), 'app-server', '--strict-config', '--stdio',
  ])
}
