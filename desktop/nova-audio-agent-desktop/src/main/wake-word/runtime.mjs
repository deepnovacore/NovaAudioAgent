import { Worker } from 'node:worker_threads'
import {removeWakeWordDownload} from './model-manager.mjs'

// Main owns presence; epochs fence in-flight PCM and detections across transitions.
export class WakeWordRuntime {
  constructor({modelRoot, WorkerClass = Worker, now = () => performance.now(),
    show = () => {}, hide = () => {}, changed = () => {}}) {
    Object.assign(this, {modelRoot, WorkerClass, now, show, hide, changed})
    this.worker = null
    this.state = 'active'
    this.status = 'off'
    this.epoch = 0
    this.enabled = false
    this.muted = true
    this.activated = false
    this.idleSince = null
    this.pending = false
    this.queue = []
    this.queuedBytes = 0
    this.droppedFrames = 0
  }
  snapshot() { return {state: this.state, status: this.status, epoch: this.epoch} }
  publish() { this.changed(this.snapshot()) }
  reset() {
    this.epoch++
    this.pending = false
    this.queue = []
    this.queuedBytes = 0
    this.worker?.postMessage({type: 'reset', epoch: this.epoch})
    this.publish()
  }
  configure({wakeWordEnabled, autoHideSeconds}) {
    this.seconds = autoHideSeconds
    this.idleSince = null
    const changed = this.enabled !== wakeWordEnabled
    this.enabled = wakeWordEnabled === true
    if (!this.enabled) {
      this.stop()
      this.status = 'off'
      if (this.state !== 'active') this.wake()
      else this.reset()
    } else if (changed || this.status === 'off') this.start()
  }
  start() {
    if (this.worker || !this.enabled) return
    this.status = 'loading'
    this.publish()
    try {
      const worker = new this.WorkerClass(new URL('./worker.mjs', import.meta.url), {
        workerData: {modelRoot: this.modelRoot},
      })
      this.worker = worker
      worker.on('message', message => {
        if (this.worker !== worker) return
        if (message?.type === 'ready') {
          this.status = 'ready'
          this.idleSince = null
          if (this.state === 'blocked') this.wake()
          else this.reset()
        } else if (message?.type === 'error') this.fail()
        else if (message?.epoch === this.epoch) {
          if (message.type === 'consumed') {
            this.pending = false
            this.flush()
          }
          if (message.type === 'detected' && this.state === 'sleeping'
            && !this.muted && this.activated && this.now() - this.lastReport < 2500) this.wake()
        }
      })
      worker.on('error', () => { if (this.worker === worker) this.fail() })
      const ownerThreadId = worker.threadId
      worker.on('exit', () => {
        // Exit proves no worker still holds download handles, including after terminate().
        if (Number.isInteger(ownerThreadId)) {
          void removeWakeWordDownload(this.modelRoot, ownerThreadId).catch(error => {
            console.warn('[wake-word] download cleanup failed', error.code)
          })
        }
        if (this.worker === worker) this.fail()
      })
    } catch { this.fail() }
  }
  fail() {
    this.stop()
    this.status = 'error'
    if (this.state === 'sleeping') {
      this.state = 'blocked'
      this.muted = true
      this.show()
    }
    this.reset()
  }
  stop() {
    const worker = this.worker
    this.worker = null
    this.pending = false
    this.queue = []
    this.queuedBytes = 0
    worker?.terminate()
  }
  wake() {
    this.state = 'active'
    this.idleSince = null
    this.reset()
    this.show()
  }
  report(value) {
    if (!value || value.epoch !== this.epoch
      || !['idle', 'muted', 'activated'].every(key => typeof value[key] === 'boolean')) return false
    const now = this.now()
    if (this.lastReport !== undefined && now - this.lastReport > 2500) this.idleSince = null
    this.lastReport = now
    if (this.state === 'blocked' && !value.muted) {
      this.reset()
      return true
    }
    if (this.muted !== value.muted || this.activated !== value.activated) {
      this.idleSince = null
      this.muted = value.muted
      this.activated = value.activated
      this.reset()
    }
    if (this.state !== 'active') return true
    if (!this.enabled || this.status !== 'ready' || !value.idle || !value.activated || !this.seconds) {
      this.idleSince = null
      return true
    }
    this.idleSince ??= now
    if (now - this.idleSince >= this.seconds * 1000) {
      this.sleep()
    }
    return true
  }
  sleep() {
    if (!this.enabled || this.status !== 'ready' || !this.activated || this.state !== 'active') return false
    this.state = 'sleeping'
    this.reset()
    this.hide()
    return true
  }
  activity() { this.idleSince = null }
  accept(value) {
    if (!this.enabled || this.status !== 'ready' || this.state !== 'sleeping'
      || this.muted || !this.activated || this.now() - this.lastReport > 2500
      || value?.epoch !== this.epoch || !(value.pcm instanceof Uint8Array)
      || value.pcm.length === 0 || value.pcm.length > 6400 || value.pcm.length % 2) return false
    // Keep up to 100 ms of 16 kHz PCM16 during short encoder stalls.
    if (this.pending) {
      if (this.queuedBytes + value.pcm.length > 3200) {
        this.droppedFrames++
        return false
      }
      this.queue.push({pcm: value.pcm, at: this.now()})
      this.queuedBytes += value.pcm.length
    } else {
      this.pending = true
      this.worker.postMessage({type: 'audio', pcm: value.pcm, epoch: this.epoch})
    }
    return true
  }
  flush() {
    while (this.queue.length) {
      const frame = this.queue.shift()
      this.queuedBytes -= frame.pcm.length
      if (this.now() - frame.at > 100) { this.droppedFrames++; continue }
      if (this.accept({pcm: frame.pcm, epoch: this.epoch})) break
      this.droppedFrames++
    }
  }
}
