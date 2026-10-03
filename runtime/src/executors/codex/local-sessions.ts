import {readFile, readdir, realpath, stat} from 'node:fs/promises'
import {basename, join, isAbsolute} from 'node:path'
import {DatabaseSync} from 'node:sqlite'

export interface LocalCodexSession {
  readonly threadId: string
  readonly title: string
  readonly cwd: string
  readonly updatedAt: number
}

/** Read-only discovery. Resume always goes through app-server, never through copied rollout files. */
export async function readLocalCodexSessions(home: string, threadId?: string): Promise<readonly LocalCodexSession[]> {
  const files = (await readdir(home)).filter(name => /^state_\d+\.sqlite$/u.test(name))
    .sort((a, b) => Number(b.slice(6, -7)) - Number(a.slice(6, -7)))
  if (!files[0]) return []
  const db = new DatabaseSync(join(home, files[0]), {readOnly: true})
  let rows: Record<string, unknown>[]
  try {
    const columns = db.prepare('PRAGMA table_info(threads)').all().map(row => row.name)
    const name = columns.includes('name') ? "COALESCE(NULLIF(name, ''), title)" : 'title'
    rows = db.prepare(`SELECT id, ${name} AS title, cwd, updated_at, ${columns.includes('rollout_path') ? 'rollout_path' : 'NULL AS rollout_path'} FROM threads
      WHERE archived = 0 AND source IN ('cli', 'vscode', 'exec', 'app-server')${threadId === undefined ? '' : ' AND id = ?'}
      ORDER BY updated_at DESC, id LIMIT 200`).all(...(threadId === undefined ? [] : [threadId]))
  } finally { db.close() }
  const sessions: LocalCodexSession[] = []
  for (const row of rows) {
    if (typeof row.id !== 'string' || !row.id || row.id.length > 256
      || typeof row.title !== 'string' || !row.title.trim()
      || typeof row.cwd !== 'string' || !isAbsolute(row.cwd)
      || typeof row.updated_at !== 'number' || !Number.isFinite(row.updated_at)) continue
    try {
      if (typeof row.rollout_path === 'string' && !(await stat(row.rollout_path)).isFile()) continue
      const cwd = await realpath(row.cwd)
      if (!(await stat(cwd)).isDirectory()) continue
      sessions.push({threadId: row.id, title: [...row.title.replace(/\s+/gu, ' ').trim()].slice(0, 80).join(''), cwd, updatedAt: row.updated_at})
    } catch { /* A remote or deleted workspace cannot be resumed on this host. */ }
  }
  return sessions
}

/** A known missing rollout invalidates an index entry. No catalog is not proof of loss. */
export async function localRolloutAvailable(home: string, threadId: string): Promise<boolean | null> {
  try {
    const files = (await readdir(home)).filter(name => /^state_\d+\.sqlite$/u.test(name))
      .sort((a, b) => Number(b.slice(6, -7)) - Number(a.slice(6, -7)))
    if (!files[0]) return null
    const db = new DatabaseSync(join(home, files[0]), {readOnly: true})
    let path: unknown
    try {
      if (!db.prepare('PRAGMA table_info(threads)').all().some(row => row.name === 'rollout_path')) return null
      path = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(threadId)?.rollout_path
    } finally { db.close() }
    if (typeof path !== 'string') return null
    try { return (await stat(path)).isFile() }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  } catch { return null } // Catalog inspection is advisory; app-server still validates any resume.
}

export interface LocalCodexProject {
  readonly path: string
  readonly name: string
  readonly threadIds: readonly string[]
}

/** Desktop projects are explicit roots, not the execution cwd of recent threads.
 * Missing desktop state retains CLI-only discovery; malformed state never expands it. */
export async function readLocalCodexProjects(home: string): Promise<readonly LocalCodexProject[] | null> {
  let state: Record<string, unknown>
  try {
    const path = join(home, '.codex-global-state.json')
    if ((await stat(path)).size > 16 * 1024 * 1024) return []
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    state = value as Record<string, unknown>
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : [] }
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const assignments = record(state['thread-project-assignments']), hints = record(state['thread-workspace-root-hints'])
  const projects: LocalCodexProject[] = []
  const saved = state['local-projects']
  const entries = saved !== undefined ? Object.entries(record(saved)) :
    (Array.isArray(state['electron-saved-workspace-roots']) ? state['electron-saved-workspace-roots'] : []).map((path, i) => [String(i), {rootPaths:[path]}] as const)
  for (const [id, raw] of entries) {
    const project = record(raw)
    if (!Array.isArray(project.rootPaths)) continue
    for (const path of project.rootPaths) {
      if (typeof path !== 'string' || !isAbsolute(path)) continue
      try {
        const canonical = await realpath(path)
        if (!(await stat(canonical)).isDirectory() || projects.some(item => item.path === canonical)) continue
        const threadIds = Object.keys({...hints, ...assignments}).filter(thread => {
          const assignment = record(assignments[thread])
          if (assignments[thread] !== undefined) return assignment.projectKind === 'local' && assignment.projectId === id
          return hints[thread] === path || hints[thread] === canonical
        })
        projects.push({path:canonical,name:[...(typeof project.name === 'string' && project.name.trim() ? project.name.trim() : basename(canonical))].slice(0,80).join(''),threadIds})
      } catch { /* Only locally available project roots are selectable. */ }
    }
  }
  return projects
}
