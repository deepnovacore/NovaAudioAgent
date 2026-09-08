export class WakeAudioRouter {
  constructor({upload, detect, now = () => performance.now()}) {
    Object.assign(this, {upload, detect, now})
    this.state = 'active'
    this.epoch = 0
    this.drainUntil = 0
  }
  apply(value) {
    if (!value || !['active', 'sleeping', 'blocked'].includes(value.state)
      || !Number.isSafeInteger(value.epoch) || value.epoch < this.epoch) return
    if (value.epoch !== this.epoch) this.drainUntil = this.now() + 120
    this.state = value.state
    this.epoch = value.epoch
  }
  accept(pcm, axes) {
    if (!axes.activated || axes.muted || this.now() < this.drainUntil) return
    if (this.state === 'sleeping') this.detect({pcm, epoch: this.epoch})
    else if (this.state === 'active' && axes.connected) this.upload(pcm)
  }
}

export function canAutoSleep(axes, backendIdle, backendIdleAt, now) {
  return backendIdle && now - backendIdleAt < 2500
    && axes.connected && axes.backendState === 'connected' && !axes.error
    && axes.capture === 'idle' && axes.playback === 'idle'
    && axes.codex === 'idle' && !axes.pendingConfirmation && !axes.activationPending
}
