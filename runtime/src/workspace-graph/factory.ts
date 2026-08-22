import {homedir} from 'node:os'
import {basename, dirname, isAbsolute, join} from 'node:path'

import {hostProjectRootFromConfig} from '../codex-project-store.js'
import type {Settings} from '../config.js'
import {
  WorkspaceGraphService,
  type WorkspaceGraphServiceDiagnostic,
} from './service.js'
import {MyContextProvider} from './provider.js'

export type WorkspaceGraphFactoryDiagnostic =
  | WorkspaceGraphServiceDiagnostic
  | 'workspace_graph_configuration_invalid'

export function workspaceGraphServiceFromSettings(
  settings: Settings,
  onDiagnostic: (code: WorkspaceGraphFactoryDiagnostic) => void = () => undefined,
): WorkspaceGraphService | undefined {
  if (!settings.workspace_graph_enabled) return undefined
  try {
    const path = graphDatabasePath(settings.workspace_graph_path)
    const personalContextProvider = settings.mycontext_provider_url === null
      ? undefined
      : new MyContextProvider({base_url: settings.mycontext_provider_url})
    return new WorkspaceGraphService({
      path,
      on_diagnostic: onDiagnostic,
      ...(personalContextProvider === undefined
        ? {}
        : {personal_context_provider: personalContextProvider}),
    })
  } catch {
    try { onDiagnostic('workspace_graph_configuration_invalid') } catch { /* advisory */ }
    return undefined
  }
}

function graphDatabasePath(configured: string): string {
  const expanded = configured.startsWith('~/')
    ? join(homedir(), configured.slice(2))
    : configured
  if (!isAbsolute(expanded) || expanded.includes('\0')) throw new TypeError()
  const file = basename(expanded)
  if (file === '' || file === '.' || file === '..') throw new TypeError()
  // Reuse the project store's canonical owner-only directory authority. The branded result is
  // intentionally not exposed; graph diagnostics never include the configured path.
  hostProjectRootFromConfig(dirname(expanded))
  return expanded
}
