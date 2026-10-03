import {randomUUID} from 'node:crypto'

const VOICEPRINT_API = 'https://openspeech.bytedance.com/api/proxy/invoke/?Action=UpdateVoiceprint'
const SPEAK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validUploadUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null
  if (!value.trim()) return ''
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
    return url.href.replace(/\/$/, '')
  } catch {return null}
}

async function boundedJson(response) {
  if (!response.ok) throw new Error(response.status === 429 ? 'voiceprint_rate_limited' : 'voiceprint_request_failed')
  const reader = response.body.getReader()
  const parts = []; let size = 0
  try {
    for (;;) {
      const {done, value} = await reader.read()
      if (done) break
      size += value.length
      if (size > 16384) throw new Error('voiceprint_response_invalid')
      parts.push(value)
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'))
  } finally {await reader.cancel().catch(() => {})}
}

export async function registerVoiceprint({audio, uploadUrl, apiKey, fetcher = fetch}) {
  const base = validUploadUrl(uploadUrl)
  if (!base || typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('voiceprint_configuration_required')
  if (!(audio instanceof Uint8Array) || audio.length < 160044 || audio.length > 960044 || audio.length % 2) throw new Error('voiceprint_audio_invalid')
  let ticket
  try {
    const uploaded = await boundedJson(await fetcher(`${base}/uploads`, {method:'POST',headers:{'Content-Type':'audio/wav'},body:audio,redirect:'error',signal:AbortSignal.timeout(30000)}))
    if (!/^[a-f0-9]{64}$/.test(uploaded.ticket)) throw new Error('voiceprint_response_invalid')
    ticket = uploaded.ticket
    if (uploaded.audioUrl !== `${base}/audio/${ticket}`) throw new Error('voiceprint_response_invalid')
    const name = `nova-${randomUUID()}`
    const response = await boundedJson(await fetcher(VOICEPRINT_API, {
      method:'POST', headers:{'Content-Type':'application/json','X-Api-Key':apiKey}, redirect:'error',signal:AbortSignal.timeout(45000),
      body:JSON.stringify({Action:0,AudioUrl:uploaded.audioUrl,SpeakerName:name}),
    }))
    if (response.ResponseMetadata?.Error || response.Result?.Code !== 1000) throw new Error('voiceprint_provider_failed')
    const id = response.Result.SpeakID ?? response.Result.SpeakId
    if (typeof id !== 'string' || !SPEAK_ID.test(id)) throw new Error('voiceprint_response_invalid')
    return {id,name}
  } finally {
    if (ticket) {
      // Server TTL cleanup retries if the desktop closes or this request fails.
      await fetcher(`${base}/uploads/${ticket}`, {method:'DELETE',redirect:'error',signal:AbortSignal.timeout(10000)}).catch(() => {})
    }
  }
}

export async function voiceprintHealth(uploadUrl, fetcher = fetch) {
  const base = validUploadUrl(uploadUrl)
  if (!base) return false
  try {
    const result = await boundedJson(await fetcher(`${base}/healthz`, {redirect:'error',cache:'no-store',signal:AbortSignal.timeout(2500)}))
    return result.ok === true
  } catch {return false}
}

export async function deleteVoiceprint({id, apiKey, fetcher = fetch}) {
  if (typeof id !== 'string' || !SPEAK_ID.test(id) || typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('voiceprint_configuration_required')
  const response = await boundedJson(await fetcher(VOICEPRINT_API, {
    method:'POST', headers:{'Content-Type':'application/json','X-Api-Key':apiKey}, redirect:'error',signal:AbortSignal.timeout(15000),
    body:JSON.stringify({Action:2,SpeakId:id}),
  }))
  // 176: the vendor no longer has this SpeakId, which is the state deletion wants.
  if (response.ResponseMetadata?.Error?.Code === 176) return
  if (response.ResponseMetadata?.Error || response.Result?.Code !== 1000) throw new Error('voiceprint_provider_failed')
}
