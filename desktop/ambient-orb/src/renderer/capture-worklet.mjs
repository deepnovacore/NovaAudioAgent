import { CaptureAccumulator } from './audio.mjs'

class NovaCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.capture = new CaptureAccumulator()
  }

  process(inputs) {
    for (const samples of this.capture.push(inputs)) {
      this.port.postMessage(samples, [samples.buffer])
    }
    return true
  }
}

registerProcessor('nova-capture', NovaCaptureProcessor)
