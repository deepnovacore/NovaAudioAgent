// Same-process monotonic timings; null explicitly means that stage was not observed.
export function voiceMetrics(events,telemetry,audioBytes,input={}){
 const event=kind=>events.find(e=>e.kind===kind)?.ms
 const stage=name=>telemetry.find(e=>e.name===name)?.ms
 const diff=(a,b)=>a==null||b==null?null:Math.round(a-b)
 const start=event('user_speech_started'),end=event('user_speech_ended')
 const first=events.find(e=>['user_transcript_delta','user_transcript_final'].includes(e.kind)&&e.text?.trim())?.ms
 const partials=events.filter(e=>e.kind==='user_transcript_delta'&&e.text?.trim())
 const normalized=text=>text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'')
 const useful=input.reference?partials.find(e=>normalized(e.text).length>=2&&normalized(input.reference).startsWith(normalized(e.text)))?.ms:undefined
 const audio=event('response_audio_delta'),tts=stage('volcengine.tts.first_text'),terminal=event('response_terminal')
 return {
  inputStartToFirstTranscriptMs:diff(first,input.startedMs),speechStartToFirstTranscriptMs:diff(first,start),
  firstUsefulTranscriptFromInputMs:diff(useful,input.startedMs),
  firstUsefulTranscriptFromSpeechEventMs:diff(useful,start),
  firstUsefulTranscriptFromAcousticProxyMs:diff(useful,input.acousticStartMs),
  finalTranscriptCount:events.filter(e=>e.kind==='user_transcript_final').length,
  firstTranscriptBeforeEndpoint:first!=null&&end!=null&&first<end,partialCount:partials.length,
  maxPartialGapMs:partials.length<2?null:Math.max(...partials.slice(1).map((e,i)=>e.ms-partials[i].ms)),
  endpointToFinalTranscriptMs:diff(event('user_transcript_final'),end),
  endpointToLlmRequestMs:diff(stage('cascaded.llm.requested'),end),
  llmFirstTextMs:diff(stage('cascaded.llm.first_text'),stage('cascaded.llm.requested')),
  llmCompletionMs:diff(stage('cascaded.llm.completed'),stage('cascaded.llm.requested')),
  llmFirstTextToTtsTextMs:diff(tts,stage('cascaded.llm.first_text')),
  ttsFirstAudioMs:diff(audio,tts),endpointToFirstAudioMs:diff(audio,end),
  estimatedAcousticEndToEndpointMs:diff(end,input.acousticEndMs),
  estimatedAcousticEndToFirstAudioMs:diff(audio,input.acousticEndMs),
  responseAudioSeconds:audioBytes/48000,
  // Includes sentence buffering and upstream text supply; not isolated engine RTF.
  ttsDeliveryRtf:tts==null||terminal==null||!audioBytes?null:(terminal-tts)/(audioBytes/48),
  memoryPrerecallMs:telemetry.filter(e=>e.name==='memory.prerecall.completed').map(e=>e.fields.duration_ms),
  completed:events.some(e=>e.kind==='response_terminal'&&e.status==='completed'),
 }
}
export function wavPcm(wav){for(let i=12;i+8<=wav.length;){const n=wav.readUInt32LE(i+4);if(wav.toString('ascii',i,i+4)==='data')return wav.subarray(i+8,i+8+n);i+=8+n+(n%2)}throw Error('missing WAV data')}
// A reproducible energy proxy, not human-labelled speech boundaries or production VAD.
export function acousticBounds(pcm){let first=null,last=null;for(let i=0;i+640<=pcm.length;i+=640){let energy=0;for(let j=i;j<i+640;j+=2)energy+=(pcm.readInt16LE(j)/32768)**2;if(Math.sqrt(energy/320)>.01){first??=i/32;last=(i+640)/32}}return {startMs:first,endMs:last}}
