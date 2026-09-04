import type {ObservationAdmission} from '../watcher.js'
import type {VisionIdentity} from '../../vision-assess.js'
import type {VisionLifecycleSink} from './controller-core.js'

interface VisionLifecycleTarget {
  /** Returns whether this exact identity may cross the Watch admission boundary. */
  permissionGranted(identity: VisionIdentity): boolean
  hit(identity: VisionIdentity): void
  terminal(identity: VisionIdentity): void
}

/** Host-private delegate correlation; stale callbacks can only touch their own identity. */
export class VisionLifecycleBridge implements VisionLifecycleSink {
  static readonly MAX_PENDING = 64
  readonly #identities = new Map<string, VisionIdentity>()
  readonly #pending = new Map<string, ReadonlySet<'granted' | 'hit' | 'terminal'>>()
  #target: VisionLifecycleTarget | null = null

  attach(target: VisionLifecycleTarget): void { this.#target = target }
  bind(delegateId: string, identity: VisionIdentity): void {
    this.#identities.set(delegateId, {...identity})
    const pending = this.#pending.get(delegateId)
    this.#pending.delete(delegateId)
    // A callback which arrived before its delegate was bound must fail closed. Its Watch has already
    // stopped, so a following terminal wins over any queued grant and must not briefly activate this
    // controller slot while binding catches up.
    if (pending?.has('terminal')) {
      this.#terminal(delegateId, identity)
      return
    }
    if (pending?.has('granted')) this.#target?.permissionGranted(identity)
    if (pending?.has('hit')) this.#target?.hit(identity)
  }
  /**
   * Permission is the synchronous no-return boundary: a queued runtime stop cannot prevent a Watch
   * from arming in the current stack, so it must receive an immediate proceed/deny decision here.
   */
  admission(delegateId: string, status: ObservationAdmission): boolean {
    if (status !== 'granted') return true
    const identity = this.#identities.get(delegateId)
    if (identity === undefined) {
      this.#queue(delegateId, 'granted')
      return false
    }
    try { return this.#target?.permissionGranted(identity) === true } catch { return false }
  }
  /** A Vision-owned hit must end its adapter window; terminal releases the controller slot. */
  hit(delegateId: string): boolean { return this.#identities.has(delegateId) }
  terminal(delegateId: string): void { this.#deliver(delegateId, 'terminal') }

  #deliver(delegateId: string, kind: 'hit' | 'terminal'): void {
    const identity = this.#identities.get(delegateId)
    if (identity === undefined) {
      this.#queue(delegateId, kind)
      return
    }
    if (kind === 'hit') this.#target?.hit(identity)
    else this.#terminal(delegateId, identity)
  }
  #queue(delegateId: string, kind: 'granted' | 'hit' | 'terminal'): void {
    if (this.#pending.size >= VisionLifecycleBridge.MAX_PENDING && !this.#pending.has(delegateId)) return
    this.#pending.set(delegateId, new Set([...(this.#pending.get(delegateId) ?? []), kind]))
  }
  #terminal(delegateId: string, identity: VisionIdentity): void {
    this.#target?.terminal(identity)
    this.#identities.delete(delegateId)
  }
}
