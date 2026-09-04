import type {ObservationAdmission} from '../watcher.js'
import type {VisionIdentity} from '../../vision-assess.js'
import type {VisionLifecycleSink} from './controller-core.js'

interface VisionLifecycleTarget {
  permissionGranted(identity: VisionIdentity): void
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
    if (pending?.has('granted')) this.#target?.permissionGranted(identity)
    if (pending?.has('hit')) this.#target?.hit(identity)
    if (pending?.has('terminal')) this.#terminal(delegateId, identity)
  }
  admission(delegateId: string, status: ObservationAdmission): void { if (status === 'granted') this.#deliver(delegateId, 'granted') }
  /** A Vision-owned hit must end its adapter window; terminal releases the controller slot. */
  hit(delegateId: string): boolean { return this.#identities.has(delegateId) }
  terminal(delegateId: string): void { this.#deliver(delegateId, 'terminal') }

  #deliver(delegateId: string, kind: 'granted' | 'hit' | 'terminal'): void {
    const identity = this.#identities.get(delegateId)
    if (identity === undefined) {
      if (this.#pending.size >= VisionLifecycleBridge.MAX_PENDING && !this.#pending.has(delegateId)) return
      this.#pending.set(delegateId, new Set([...(this.#pending.get(delegateId) ?? []), kind]))
      return
    }
    if (kind === 'granted') this.#target?.permissionGranted(identity)
    else if (kind === 'hit') this.#target?.hit(identity)
    else this.#terminal(delegateId, identity)
  }
  #terminal(delegateId: string, identity: VisionIdentity): void {
    this.#target?.terminal(identity)
    this.#identities.delete(delegateId)
  }
}
