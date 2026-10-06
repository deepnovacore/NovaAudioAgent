import {onButton} from './button-action.mjs'
import {floatToPcm16} from './audio.mjs'
import {t} from './locale.mjs'

export function voiceprintWav(samples, sampleRate) {
  const pcm = floatToPcm16(samples, sampleRate)
  if (pcm.length < 160000 || pcm.length > 960000) throw new Error('voiceprint_audio_invalid')
  const wav = new Uint8Array(44 + pcm.length), view = new DataView(wav.buffer)
  const text = (offset, value) => wav.set(new TextEncoder().encode(value), offset)
  text(0,'RIFF'); view.setUint32(4,wav.length-8,true); text(8,'WAVEfmt ')
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true)
  view.setUint32(24,16000,true); view.setUint32(28,32000,true); view.setUint16(32,2,true)
  view.setUint16(34,16,true); text(36,'data'); view.setUint32(40,pcm.length,true); wav.set(pcm,44)
  return wav
}

async function record(signal, progress) {
  const stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false})
  let context, source, processor, timer
  try {
    signal.throwIfAborted()
    context = new AudioContext({sampleRate:16000})
    await context.resume()
    await context.audioWorklet.addModule('nova://orb/capture-worklet.mjs')
    signal.throwIfAborted()
    source = context.createMediaStreamSource(stream)
    processor = new AudioWorkletNode(context,'nova-capture')
    const chunks = []; let count = 0
    const done = new Promise((resolve,reject) => {
      const abort = () => reject(new Error('voiceprint_cancelled'))
      signal.addEventListener('abort',abort,{once:true})
      timer = setTimeout(() => reject(new Error('voiceprint_audio_invalid')),16000)
      processor.port.onmessage = event => {
        const samples = event.data?.samples
        if (!(samples instanceof Float32Array)) return
        const remaining = Math.floor(context.sampleRate * 12) - count
        const chunk = samples.slice(0,Math.max(0,remaining))
        chunks.push(chunk); count += chunk.length
        progress(Math.min(12,Math.floor(count/context.sampleRate)))
        if (count >= context.sampleRate * 12) {
          signal.removeEventListener('abort',abort)
          resolve()
        }
      }
    })
    source.connect(processor); processor.connect(context.destination)
    await done
    const samples = new Float32Array(count); let offset = 0
    for (const chunk of chunks) {samples.set(chunk,offset); offset += chunk.length}
    return voiceprintWav(samples,context.sampleRate)
  } finally {
    clearTimeout(timer)
    processor?.disconnect(); source?.disconnect()
    stream.getTracks().forEach(track=>track.stop())
    await context?.close().catch(()=>{})
  }
}

export function createVoiceprintPanel({document, api, stage}) {
  const url = document.querySelector('#voiceprint-upload-url')
  const controls = document.querySelector('#voiceprint-controls')
  const health = document.querySelector('#voiceprint-health')
  const enabled = document.querySelector('#voiceprint-enabled')
  const identity = document.querySelector('#voiceprint-identity')
  const register = document.querySelector('#voiceprint-register')
  const cancel = document.querySelector('#voiceprint-cancel')
  const note = document.querySelector('#voiceprint-status')
  let view = {}, urlUnsaved = false, healthy = false, checking = false, busy = false, abort = null, checkedUrl = null
  function paint() {
    const supported = view.pipelineMode === 'cascaded' && view.cascadedAsrProvider === 'volcengine'
    controls.hidden = !healthy || !supported
    enabled.checked = healthy && view.voiceprintEnabled === true
    enabled.disabled = busy || !view.voiceprintId || !view.voiceprintName
    // Main uploads only to the saved URL, so a staged one must be saved first.
    register.disabled = busy || urlUnsaved
    cancel.hidden = !abort
    url.disabled = busy
    identity.textContent = view.voiceprintId || t('尚未注册声纹')
    health.textContent = !supported ? t('声纹功能仅支持火山引擎 ASR。') : healthy
      ? t('声纹服务可用') : t('声纹服务不可用：注册入口已隐藏，声纹验证已停用。')
  }
  async function check() {
    if (checking) return
    checking = true
    const value = view.voiceprintUploadUrl || ''
    try {
      const result = await api.voiceprint({action:'health',uploadUrl:value})
      if (value === (view.voiceprintUploadUrl || '')) {healthy = result.healthy === true; checkedUrl = value}
    } catch {healthy = false} finally {checking = false; paint()}
  }
  url.addEventListener('change',()=>{stage({voiceprintUploadUrl:url.value.trim()}); void check()})
  enabled.addEventListener('change',()=>stage({voiceprintEnabled:enabled.checked}))
  cancel.addEventListener('click',()=>abort?.abort())
  onButton(register,async()=>{
    if (busy || !healthy) return
    busy = true; abort = new AbortController(); paint()
    const signal = abort.signal
    try {
      const started = await api.voiceprint({action:'start'})
      if (!started.ok) throw new Error(started.error)
      signal.throwIfAborted()
      const audio = await record(signal,seconds=>{note.textContent=t('正在录音：{0}/12 秒',seconds)})
      await api.voiceprint({action:'stop'})
      signal.throwIfAborted()
      abort = null; paint()
      note.textContent=t('正在注册声纹…')
      const result = await api.voiceprint({action:'register',audio})
      if (result.error) throw Object.assign(new Error(result.error), {orphanedId:result.orphanedId,retainedId:result.retainedId})
      // Main has saved the new identity; the settings push repaints it.
      note.textContent=t('声纹已注册。勾选验证并保存后生效；需要继续对话时，请重新开启麦克风。')
      if (result.previousDeleteFailed) note.textContent += ' ' + t('旧声纹未能从火山删除，请稍后手动删除：{0}', result.previousDeleteFailed)
    } catch (error) {
      const messages = {
        voiceprint_rate_limited:t('今日注册次数已用完或操作过于频繁，请稍后重试。'),
        voiceprint_configuration_required:t('请先保存火山语音 API Key 和上传服务地址。'),
        voiceprint_provider_failed:t('火山未能注册声纹，请检查语音服务权限或重新录音。'),
        voiceprint_microphone_denied:t('请在系统设置中允许 Nova 使用麦克风。'),
        voiceprint_settings_changed:t('注册期间语音 API Key 已更改，本次声纹已丢弃，请重新注册。'),
      }
      note.textContent = signal.aborted ? t('已取消') : messages[error.message] || t('声纹注册失败，请检查网络、麦克风和服务配置后重试。')
      if (error.retainedId) note.textContent = t('已保留声纹：{0}。请先恢复设置，再重试注册。', error.retainedId)
      if (error.orphanedId) note.textContent += ' ' + t('本次声纹未能从火山删除，请稍后手动删除：{0}', error.orphanedId)
    } finally {
      await api.voiceprint({action:'stop'}).catch(()=>{})
      abort = null; busy = false; paint(); void check()
    }
  })
  const interval = setInterval(()=>{void check()},30000)
  window.addEventListener('pagehide',()=>{clearInterval(interval);abort?.abort(); void api.voiceprint({action:'stop'})})
  return {render(next, drafts = {}) {
    view = next
    urlUnsaved = Object.hasOwn(drafts, 'voiceprintUploadUrl')
    if (document.activeElement !== url) url.value=next.voiceprintUploadUrl || ''
    if (checkedUrl !== (next.voiceprintUploadUrl || '')) {healthy=false; void check()}
    if (next.pipelineMode !== 'cascaded') abort?.abort()
    paint()
  }}
}
