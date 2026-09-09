import type {AsrClient} from './ports.js'

/** Draft-only ASR: never emits conversation events or starts an LLM response. */
export async function transcribeDraft(client: AsrClient, pcm: Uint8Array, signal: AbortSignal): Promise<string> {
  if (!pcm.length || pcm.length % 2 || pcm.length > 16000 * 2 * 60) throw new Error('invalid dictation')
  const session = await client.open(signal)
  let text = ''
  const reading = (async () => {
    for await (const result of session.events(signal)) {
      if (typeof result.text !== 'string' || result.text.length > 4000) throw new Error('invalid transcript')
      if (result.final) text = result.text
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
    if (!text.trim()) throw new Error('empty transcript')
    return text
  } finally { await session.close() }
}
