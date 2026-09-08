import { parentPort, workerData } from 'node:worker_threads'
import { createSherpaWakeWordDetector } from './sherpa-detector.mjs'

let detector
let epoch = -1
parentPort.on('message', message => {
  try {
    if (message?.type === 'reset') {
      epoch = message.epoch
      detector?.reset()
    } else if (detector && message?.type === 'audio' && message.epoch === epoch) {
      if (detector.accept(message.pcm)) parentPort.postMessage({type: 'detected', epoch})
      parentPort.postMessage({type: 'consumed', epoch})
    }
  } catch { parentPort.postMessage({type: 'error'}) }
})
createSherpaWakeWordDetector({modelRoot: workerData.modelRoot}).then(value => {
  detector = value
  parentPort.postMessage({type: 'ready'})
}).catch(() => parentPort.postMessage({type: 'error'}))
