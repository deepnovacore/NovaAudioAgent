import type {AsrClient} from './ports.js'
import {DICTATION_MIN_BYTES, DICTATION_SILENCE_PEAK, DictationError, pcmLevel} from '../dictation.js'

/** Draft-only ASR: never emits conversation events or starts an LLM response. */
export async function transcribeDraft(client: AsrClient, pcm: Uint8Array, signal: AbortSignal): Promise<string> {
  if (pcm.length % 2 || pcm.length > 16000 * 2 * 60) throw new Error('invalid dictation')
  if (pcm.length < DICTATION_MIN_BYTES) throw new DictationError('no_audio', 'recording too short')
  if (pcmLevel(pcm).peak < DICTATION_SILENCE_PEAK) throw new DictationError('no_audio', 'silent recording')
  const session = await client.open(signal)
  let text = '', partial = ''
  const reading = (async () => {
    for await (const result of session.events(signal)) {
      if (typeof result.text !== 'string' || result.text.length > 4000) throw new Error('invalid transcript')
      if (result.final) { if (result.text.trim()) text = result.text }
      else if (result.text.trim()) partial = result.text
    }
  })()
  void reading.catch(() => undefined)
  try {
    for (let offset = 0; offset < pcm.length; offset += 3200) {
      signal.throwIfAborted()
      await session.append(pcm.slice(offset, offset + 3200), signal)
    }
    await session.finish(signal)
    await reading
    signal.throwIfAborted()
    const transcript = text.trim() ? text : partial
    if (!transcript.trim()) throw new DictationError('no_speech', 'empty transcript')
    return transcript
  } finally { await session.close() }
}
