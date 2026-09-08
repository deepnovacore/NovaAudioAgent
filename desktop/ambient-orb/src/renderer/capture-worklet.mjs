import { CaptureAccumulator } from './audio.mjs'

class NovaCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.epoch = 0
    this.port.onmessage = event => {
      if (Number.isSafeInteger(event.data?.epoch)) {
        this.epoch = event.data.epoch
        this.capture = new CaptureAccumulator()
      }
    }
    this.capture = new CaptureAccumulator()
  }

  process(inputs) {
    for (const samples of this.capture.push(inputs)) {
      this.port.postMessage({samples, epoch: this.epoch}, [samples.buffer])
    }
    return true
  }
}

registerProcessor('nova-capture', NovaCaptureProcessor)
