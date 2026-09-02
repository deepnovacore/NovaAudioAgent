/* eslint-disable @typescript-eslint/require-await -- test owner methods implement the async production contract */
import {spawn, type ChildProcess} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import type {Readable, Writable} from 'node:stream'

import type {
  ApprovedSpawnSpec,
  CodexProcessOwnerFactory,
  CodexProcessSpawnControl,
  OwnedCodexProcess,
} from '../../../src/codex-process-owner.js'

export const FAKE_APP_SERVER_PATH = fileURLToPath(new URL(
  '../../../../test/fixtures/codex/fake-app-server.mjs',
  import.meta.url,
))

export type FakeAppServerScenario =
  | 'happy-chunks'
  | 'malformed-after-turn'
  | 'stdout-overflow'
  | 'stderr-overflow'
  | 'delayed-turn'
  | 'duplicate-response'
  | 'unknown-response'
  | 'server-request'
  | 'file-approval'
  | 'file-approval-held-terminal'
  | 'file-approval-decline'
  | 'file-approval-turn-interrupted'
  | 'file-approval-process-exit'
  | 'file-approval-invalid-start'
  | 'command-approval'
  | 'clean-eof'
  | 'pending-eof'
  | 'turn-rejection-order'
  | 'descendant-leader-first'
  | 'descendant-ignore-term'

export class FakeAppServerOwnerFactory implements CodexProcessOwnerFactory {
  readonly #scenario: FakeAppServerScenario
  owner: FakeAppServerOwner | null = null

  constructor(scenario: FakeAppServerScenario) {
    this.#scenario = scenario
  }

  async spawn(_spec: ApprovedSpawnSpec, control: CodexProcessSpawnControl): Promise<FakeAppServerOwner> {
    void _spec
    if (control.signal.aborted || control.expiresAtMs <= Date.now()) {
      throw new Error('fake owner spawn cancelled')
    }
    const child = spawn(process.execPath, [FAKE_APP_SERVER_PATH, this.#scenario], {
      cwd: process.cwd(),
      env: {PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? ''},
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    })
    if (child.stdin === null || child.stdout === null || child.stderr === null || child.pid === undefined) {
      child.kill('SIGKILL')
      throw new Error('fake owner spawn failed')
    }
    const owner = new FakeAppServerOwner(child)
    this.owner = owner
    return owner
  }
}

export class FakeAppServerOwner implements OwnedCodexProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exit: Promise<number | null>
  readonly approvalDecision: Promise<'accept' | 'decline'>
  readonly pid: number
  readonly #child: ChildProcess
  readonly #barriers = new Map<string, (() => void)[]>()
  readonly #approvalResponseProbes = new Map<string, {
    readonly resolve: (count: number) => void
    readonly reject: (error: Error) => void
  }>()
  readonly #seen = new Set<string>()
  #stdinClosed = false
  #nextApprovalResponseProbe = 0
  #resolveApprovalDecision!: (decision: 'accept' | 'decline') => void

  constructor(child: ChildProcess) {
    if (child.stdin === null || child.stdout === null || child.stderr === null || child.pid === undefined) {
      throw new Error('invalid fake child')
    }
    this.#child = child
    this.stdin = child.stdin
    this.stdout = child.stdout
    this.stderr = child.stderr
    this.pid = child.pid
    this.approvalDecision = new Promise(resolve => { this.#resolveApprovalDecision = resolve })
    this.exit = new Promise((resolve, reject) => {
      child.once('exit', code => {
        this.#rejectApprovalResponseProbes(new Error('fake child exited before probe response'))
        resolve(code)
      })
      child.once('error', error => {
        this.#rejectApprovalResponseProbes(error)
        reject(error)
      })
    })
    void this.exit.catch(() => undefined)
    child.on('message', message => {
      if (!plain(message)) return
      if (message.type === 'barrier' && typeof message.name === 'string') {
        if (
          message.name === 'approval_response_count'
          && typeof message.probe_id === 'string'
          && Number.isSafeInteger(message.response_count)
          && Number(message.response_count) >= 0
        ) {
          const probe = this.#approvalResponseProbes.get(message.probe_id)
          if (probe !== undefined) {
            this.#approvalResponseProbes.delete(message.probe_id)
            probe.resolve(Number(message.response_count))
          }
        }
        if (
          message.name === 'approval_response'
          && (message.decision === 'accept' || message.decision === 'decline')
        ) this.#resolveApprovalDecision(message.decision)
        this.#seen.add(message.name)
        for (const release of this.#barriers.get(message.name) ?? []) release()
        this.#barriers.delete(message.name)
      }
    })
  }

  waitForBarrier(
    name: 'turn_start' | 'descendant_started' | 'approval_request' | 'approval_response',
  ): Promise<void> {
    if (this.#seen.has(name)) return Promise.resolve()
    return new Promise(resolve => {
      const waiting = this.#barriers.get(name) ?? []
      waiting.push(resolve)
      this.#barriers.set(name, waiting)
    })
  }

  release(
    name: 'turn_start' | 'clean_eof' | 'leader_exit'
      | 'approval_process_exit' | 'approval_turn_completion',
  ): void {
    this.#child.send?.({type: 'release', name})
  }

  /** Test-only FIFO probe: runs behind every JSON-RPC response already queued on child stdin. */
  probeApprovalResponseCountForTest(): Promise<number> {
    if (this.#stdinClosed || this.stdin.destroyed || this.stdin.writableEnded) {
      return Promise.reject(new Error('fake child stdin is closed'))
    }
    if (this.#approvalResponseProbes.size !== 0) {
      return Promise.reject(new Error('fake child approval response probe is already pending'))
    }
    this.#nextApprovalResponseProbe += 1
    const probeId = `approval-response-probe-${this.#nextApprovalResponseProbe}`
    return new Promise((resolve, reject) => {
      this.#approvalResponseProbes.set(probeId, {resolve, reject})
      this.stdin.write(`${JSON.stringify({
        method: 'fixture/approvalResponseCount',
        params: {probeId},
      })}\n`, error => {
        if (error == null) return
        this.#approvalResponseProbes.delete(probeId)
        reject(error)
      })
    })
  }

  async closeStdin(): Promise<void> {
    if (this.#stdinClosed) return
    this.#stdinClosed = true
    await new Promise<void>(resolve => { this.stdin.end(resolve) })
  }

  async waitTreeGone(graceMs: number): Promise<boolean> {
    const deadline = Date.now() + graceMs
    while (this.#treeAlive()) {
      if (Date.now() >= deadline) return false
      await new Promise<void>(resolve => { setTimeout(resolve, 10) })
    }
    return await settleWithin(this.exit, Math.max(1, deadline - Date.now()))
  }

  async terminateTree(): Promise<void> { this.#signal('SIGTERM') }
  async killTree(): Promise<void> { this.#signal('SIGKILL') }

  async dispose(): Promise<void> {
    this.#rejectApprovalResponseProbes(new Error('fake child owner disposed'))
    this.stdin.destroy()
    this.stdout.destroy()
    this.stderr.destroy()
    this.#child.disconnect?.()
  }

  #treeAlive(): boolean {
    try {
      process.kill(process.platform === 'win32' ? this.pid : -this.pid, 0)
      return true
    } catch (error) {
      return isErrno(error, 'EPERM')
    }
  }

  #signal(signal: NodeJS.Signals): void {
    try {
      process.kill(process.platform === 'win32' ? this.pid : -this.pid, signal)
    } catch (error) {
      if (!isErrno(error, 'ESRCH')) throw error
    }
  }

  #rejectApprovalResponseProbes(error: Error): void {
    for (const probe of this.#approvalResponseProbes.values()) probe.reject(error)
    this.#approvalResponseProbes.clear()
  }
}

async function settleWithin(work: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work.then(() => true, () => true),
      new Promise<false>(resolve => { timer = setTimeout(() => { resolve(false) }, milliseconds) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}
