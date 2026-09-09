import {
  AlertTone, GenerationPlayback, OnsetTracker, PlaybackMeter,
  admitBrowserPlayback, applyAlertCommand, decodeAudioFrame, floatToPcm16,
  measurePcmLevel, observePcmOnset, resumeAudioContextWithWatchdog,
} from '/shared/audio.mjs'

export function createBrowserAudio({send, onLevel = () => {}, onSettings = () => {}}) {
  let context, media, source, processor, sink, meter, tick
  let lifetime = 0, captureEpoch = 0, muted = false, volume = 1, cursor = 0, input = 0
  const nodes = new Map()
  const tone = new AlertTone()
  // UI and socket callbacks must not tear down the audio render callbacks.
  const notify = (callback, value) => { try { callback(value) } catch {} }
  const report = message => {
    if (message) notify(send, {...message, t_render_ms: performance.now()})
  }
  const onset = new OnsetTracker({mintId: () => crypto.randomUUID()})
  const playback = new GenerationPlayback({
    maxQueuedBytes: 60 * 48_000,
    stopAll() {
      let playedMs = 0
      for (const [node, item] of nodes) {
        playedMs += Math.max(0, Math.min(item.duration, context.currentTime - item.start)) * 1000
        clearTimeout(item.timer)
        node.onended = null
        try { node.stop() } catch {}
        node.disconnect()
      }
      nodes.clear()
      cursor = 0
      return playedMs
    },
  })
  function resetPlayback({serverChanged = false} = {}) {
    if (serverChanged) playback.backendExited()
    else playback.disconnect()
    tone.stop()
  }
  function stop() {
    muted = false
    lifetime += 1
    captureEpoch += 1
    clearInterval(tick)
    onset.reset()
    resetPlayback({serverChanged: true})
    if (processor) processor.port.onmessage = null
    processor?.disconnect()
    source?.disconnect()
    sink?.disconnect()
    media?.getTracks().forEach(track => track.stop())
    const oldContext = context
    context = media = source = processor = sink = meter = null
    if (oldContext) void oldContext.close().catch(() => {})
    input = 0
    notify(onLevel, {input: 0, output: 0, speaking: false})
  }
  async function start({microphoneId} = {}) {
    stop()
    const token = lifetime
    // Called before the first await, while the Start button gesture is active.
    const ctx = context = new AudioContext()
    const running = resumeAudioContextWithWatchdog(ctx)
    // Attach a rejection handler immediately while permission UI may be pending.
    running.catch(() => {})
    let stream
    try {
      const mediaPromise = navigator.mediaDevices.getUserMedia({audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        channelCount: 1, ...(microphoneId ? {deviceId: {exact: microphoneId}} : {}),
      }})
      stream = await mediaPromise
      if (token !== lifetime) { stream.getTracks().forEach(track => track.stop()); return }
      media = stream
      await running
      await ctx.audioWorklet.addModule('/shared/capture-worklet.mjs')
      if (token !== lifetime) return
      meter = new PlaybackMeter(ctx, () => nodes.size > 0 || Boolean(tone.oscillator))
      meter.gain.gain.value = volume
      source = ctx.createMediaStreamSource(stream)
      processor = new AudioWorkletNode(ctx, 'nova-capture')
      sink = ctx.createGain()
      sink.gain.value = 0
      source.connect(processor)
      processor.connect(sink)
      sink.connect(ctx.destination)
      processor.port.postMessage({epoch: captureEpoch})
      processor.port.onmessage = event => {
        if (token !== lifetime || muted || event.data?.epoch !== captureEpoch) return
        const samples = event.data.samples
        if (!(samples instanceof Float32Array) || !samples.length) return
        const pcm = floatToPcm16(samples, ctx.sampleRate)
        input = measurePcmLevel(pcm)
        const verdict = observePcmOnset(pcm, onset, performance.now())
        if (verdict) report({type: 'speech.onset', speech_id: verdict.speechId})
        notify(send, pcm)
      }
      stream.getAudioTracks().forEach(track => { track.enabled = !muted })
      tick = setInterval(() => notify(onLevel, {
        input: muted ? 0 : input, output: meter?.level() ?? 0, speaking: onset.active,
      }), 50)
      const settings = stream.getAudioTracks()[0]?.getSettings() ?? {}
      const devices = await navigator.mediaDevices.enumerateDevices()
      if (token === lifetime) notify(onSettings, {echoCancellation: settings.echoCancellation, devices})
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop())
      if (token !== lifetime) return
      stop()
      throw error
    }
  }
  function setMuted(value) {
    muted = Boolean(value)
    captureEpoch += 1
    processor?.port.postMessage({epoch: captureEpoch})
    media?.getAudioTracks().forEach(track => { track.enabled = !muted })
    onset.reset()
    input = 0
  }
  function setVolume(value) {
    if (!Number.isFinite(value)) return
    volume = Math.max(0, Math.min(1, value))
    if (meter) meter.gain.gain.value = volume
  }
  function stopGeneration(frame) {
    const cleared = playback.clear(frame.utteranceId, frame.generationEpoch)
    if (cleared) report({type: 'playback.stopped', utterance_id: frame.utteranceId,
      generation_epoch: frame.generationEpoch, played_ms: cleared.playedMs})
  }
  async function receive(raw) {
    if (!context || !meter) return
    const token = lifetime
    const ctx = context
    const frame = decodeAudioFrame(raw)
    tone.stop()
    const admission = await admitBrowserPlayback(playback, frame, () => resumeAudioContextWithWatchdog(ctx))
    if (token !== lifetime) return
    if (admission.status === 'stopped') {
      report({type: 'playback.stopped', utterance_id: frame.utteranceId,
        generation_epoch: frame.generationEpoch, played_ms: admission.playedMs})
    }
    if (admission.status !== 'ready') return
    let queued
    while ((queued = playback.dequeue())) {
      const duration = queued.pcm.byteLength / 48_000
      const start = Math.max(ctx.currentTime, cursor)
      // Bound scheduled audio as well as the shared queue; settle overflow explicitly.
      if (start + duration - ctx.currentTime > 60) { stopGeneration(queued); return }
      try {
        const buffer = ctx.createBuffer(1, queued.pcm.byteLength / 2, 24_000)
        const samples = buffer.getChannelData(0)
        const view = new DataView(queued.pcm.buffer, queued.pcm.byteOffset, queued.pcm.byteLength)
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768
        const node = ctx.createBufferSource()
        node.buffer = buffer
        node.connect(meter.destination)
        const currentFrame = queued
        const item = {start, duration, timer: null}
        nodes.set(node, item)
        const started = () => {
          if (!nodes.has(node)) return
          if (ctx.state === 'running' && ctx.currentTime >= start) report(playback.markStarted())
          else item.timer = setTimeout(started, 10)
        }
        node.onended = () => {
          clearTimeout(item.timer)
          nodes.delete(node)
          node.disconnect()
          report(playback.markStarted())
          report(playback.frameEnded(currentFrame))
        }
        node.start(start)
        cursor = start + duration
        started()
      } catch (error) {
        stopGeneration(queued)
        throw error
      }
    }
  }
  async function control(message) {
    if (message.type === 'playback.terminal') {
      report(playback.markProviderTerminal(message.utterance_id, message.generation_epoch))
    } else if (message.type === 'playback.clear') {
      const cleared = playback.clear(message.utterance_id, message.generation_epoch)
      const last = playback.lastCompletion
      const playedMs = cleared?.playedMs ?? (last?.utterance_id === message.utterance_id
        && last.generation_epoch === message.generation_epoch ? last.played_ms : 0)
      report({...message, type: 'playback.cleared', played_ms: playedMs})
    } else if (message.type === 'playback.alert') {
      const result = await applyAlertCommand(playback, message, {startTone() {
        if (!context || !meter) return
        tone.play(context)
        tone.gain.disconnect()
        tone.gain.connect(meter.destination)
      }})
      if (Object.hasOwn(message, 'utterance_id')) {
        report({...message, type: 'playback.cleared', played_ms: result.playedMs})
      }
    }
  }
  return {start, stop, setMuted, setVolume, receive, control, resetPlayback}
}
