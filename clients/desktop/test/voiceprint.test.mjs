import assert from 'node:assert/strict'
import {test} from 'node:test'
import {deleteVoiceprint, registerVoiceprint} from '../src/main/voiceprint.mjs'
import {readFile} from 'node:fs/promises'
import {normalizeSettings, publicSettings} from '../src/main/settings-store.mjs'

test('registration keeps the speech key off the upload service and always cleans temporary audio', async () => {
  const ticket = 'b'.repeat(64)
  const calls = []
  const id = '6d7dd0de-6563-4b1f-885e-f39db4f7b360'
  let fail = false
  const fetcher = async (url, init) => {
    calls.push([url,init])
    if (url === 'https://upload.example/uploads') {
      assert.equal(init.headers['X-Api-Key'], undefined)
      return Response.json({ticket,audioUrl:`https://upload.example/audio/${ticket}`}, {status:201})
    }
    if (url.includes('/api/proxy/invoke/?Action=UpdateVoiceprint')) {
      assert.equal(init.headers['X-Api-Key'],'private-key')
      assert.equal(init.redirect,'error', 'never forward credentials across redirects')
      const body = JSON.parse(init.body)
      assert.equal(body.AudioUrl, `https://upload.example/audio/${ticket}`)
      assert.equal(body.Action,0)
      assert.match(body.SpeakerName, /^nova-/)
      return Response.json({Result:{Code:fail?1001:1000,SpeakID:id}})
    }
    assert.equal(url, `https://upload.example/uploads/${ticket}`)
    assert.equal(init.method,'DELETE')
    return new Response(null,{status:204})
  }
  const input = {audio:new Uint8Array(160044),uploadUrl:'https://upload.example',apiKey:'private-key',fetcher}
  const result = await registerVoiceprint(input)
  assert.ok(result)
  assert.equal(result.id,id)
  assert.match(result.name,/^nova-/)
  assert.equal(calls.length,3)
  fail = true
  await assert.rejects(registerVoiceprint(input), /voiceprint_provider_failed/)
  assert.equal(calls.at(-1)[1].method,'DELETE')
})

test('voiceprint settings survive normalization without exposing credentials', () => {
  const raw = {voiceprintEnabled:true,voiceprintId:'6d7dd0de-6563-4b1f-885e-f39db4f7b360', voiceprintName:'nova-example',voiceprintUploadUrl:'https://upload.example'}
  const settings = normalizeSettings(raw)
  assert.equal(settings.voiceprintEnabled,true)
  assert.equal(publicSettings(settings).voiceprintId,raw.voiceprintId)
  assert.equal(normalizeSettings({voiceprintUploadUrl:'http://untrusted.example'}).voiceprintUploadUrl,'')
})

test('only the active settings recording window may request microphone audio', async () => {
  const {configureWindowSecurity} = await import('../src/main/security.mjs')
  let check, request, active = null
  const settings = {}, other = {}
  const renderer = {setWindowOpenHandler(){},on(){},session:{setPermissionCheckHandler(fn){check=fn},setPermissionRequestHandler(fn){request=fn}}}
  configureWindowSecurity({webContents:renderer}, () => active)
  assert.equal(check(settings,'media','nova://orb',{mediaType:'audio'}),false)
  active = settings
  assert.equal(check(settings,'media','nova://orb',{mediaType:'audio'}),true)
  assert.equal(check(settings,'media','nova://orb',{mediaType:'video'}),false)
  assert.equal(check(other,'media','nova://orb',{mediaType:'audio'}),false)
  request(settings,'media',value=>assert.equal(value,false),{securityOrigin:'nova://orb',mediaTypes:['audio','video']})
  active = null
  assert.equal(check(settings,'media','nova://orb',{mediaType:'audio'}),false)
})

test('recorded WAV format and unhealthy settings hide registration while retaining the saved target', async () => {
  const {voiceprintWav,createVoiceprintPanel} = await import('../src/renderer/voiceprint-panel.mjs')
  const bytes = voiceprintWav(new Float32Array(48000*5),48000)
  const wav = Buffer.from(bytes)
  assert.equal(wav.length,160044)
  assert.equal(wav.toString('ascii',0,4),'RIFF')
  assert.equal(wav.readUInt32LE(24),16000)
  assert.equal(wav.readUInt32LE(40),160000)
  assert.throws(()=>voiceprintWav(new Float32Array(100),16000),/voiceprint_audio_invalid/)
  const elements = new Map()
  const doc = {querySelector(id) {if (!elements.has(id)) elements.set(id,{addEventListener(){}}); return elements.get(id)}}
  let ready = true, cleanup
  const previous = globalThis.window
  globalThis.window = {addEventListener(name,fn){if(name==='pagehide') cleanup=fn}}
  const saved = {pipelineMode:'cascaded',cascadedAsrProvider:'volcengine',voiceprintId:'saved',voiceprintName:'name',voiceprintEnabled:true,voiceprintUploadUrl:'https://one.example'}
  try {
    const panel = createVoiceprintPanel({document:doc,api:{voiceprint:async()=>({healthy:ready})},stage(){throw new Error('health must not erase saved preferences')}})
    panel.render(saved)
    await new Promise(setImmediate)
    assert.equal(elements.get('#voiceprint-controls').hidden,false)
    assert.equal(elements.get('#voiceprint-enabled').checked,true)
    ready = false
    panel.render({...saved,voiceprintUploadUrl:'https://two.example'})
    await new Promise(setImmediate)
    assert.equal(elements.get('#voiceprint-controls').hidden,true)
    assert.equal(elements.get('#voiceprint-enabled').checked,false)
    assert.equal(elements.get('#voiceprint-identity').textContent,'saved')
  } finally {cleanup?.();globalThis.window=previous}
})

test('deleting a voiceprint sends Action 2 with the SpeakId and treats a missing record as deleted', async () => {
  const id = '6d7dd0de-6563-4b1f-885e-f39db4f7b360'
  let reply = {Result:{Code:1000}}
  const fetcher = async (url, init) => {
    assert.match(url, /Action=UpdateVoiceprint$/)
    assert.equal(init.headers['X-Api-Key'], 'private-key')
    assert.equal(init.redirect, 'error')
    assert.deepEqual(JSON.parse(init.body), {Action:2, SpeakId:id})
    return Response.json(reply)
  }
  await deleteVoiceprint({id, apiKey:'private-key', fetcher})
  reply = {ResponseMetadata:{Error:{Code:176,Message:'not found'}}}
  await deleteVoiceprint({id, apiKey:'private-key', fetcher})
  reply = {Result:{Code:1002}}
  await assert.rejects(deleteVoiceprint({id, apiKey:'private-key', fetcher}), /voiceprint_provider_failed/)
  await assert.rejects(deleteVoiceprint({id:'not-an-id', apiKey:'private-key', fetcher}), /voiceprint_configuration_required/)
})

test('main registers against saved settings and replaces the vendor record only after committing the new one', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const handler = source.slice(source.indexOf("ipcMain.handle('nova:settings:voiceprint'"), source.indexOf("ipcMain.handle('nova:settings:get'"))
  const register = handler.slice(handler.indexOf("input.action !== 'register'"))
  assert.doesNotMatch(register, /input\.uploadUrl/, 'register uploads only to the saved URL')
  assert.doesNotMatch(handler.slice(handler.indexOf("input.action === 'start'")), /input\.uploadUrl/)
  const changed = register.indexOf('if (currentKey !== apiKey)')
  const commit = register.indexOf('applyDesktopSettings({settingsPatch:{voiceprintId:result.id')
  const removeOld = register.indexOf('deleteVoiceprint({id:previousId')
  assert.ok(changed > 0 && changed < commit && commit < removeOld)
  assert.ok(register.indexOf('await accessCredentials(() => speechKey(currentSettings))') < changed)
  assert.match(register.slice(0, commit), /deleteVoiceprint\(\{id:result\.id,apiKey/)
  assert.match(register.slice(changed, commit), /discard\('voiceprint_settings_changed'\)/)
  // saved:false (busy, invalid, rolled back) must discard the new ID and keep the old one.
  const gate = register.indexOf("committed?.saved !== true")
  assert.ok(commit < gate && gate < removeOld)
  assert.match(register.slice(gate, removeOld), /discard\('voiceprint_request_failed'\)/)
  assert.match(register, /catch \{return \{error,orphanedId:result\.id\}\}/, 'a failed discard surfaces the orphaned ID')
})

test('queued voiceprint registration reads upload target, key and previous ID from one current settings snapshot', async () => {
  const {runInNewContext} = await import('node:vm')
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const handlerSource = source.slice(source.indexOf("ipcMain.handle('nova:settings:voiceprint'"), source.indexOf("ipcMain.handle('nova:settings:get'"))
  const sender = {}, calls = []
  let handler, release
  const waiting = new Promise(resolve => { release = resolve })
  const context = {
    settingsWindow:{webContents:sender},currentSettings:{voiceprintUploadUrl:'https://old.example',voiceprintId:'old',key:'old-key'},voiceprintBusy:false,secretCodec:{},net:{fetch(){}},
    accessCredentials:async operation=>{if(!calls.length)await waiting;calls.push('read');return operation()},
    decryptSecretsForSpawn:settings=>({doubaoAsrApiKey:settings.key}),voiceprintHealth:async url=>{calls.push(url);return true},
    registerVoiceprint:async input=>{calls.push([input.uploadUrl,input.apiKey]);return {id:'new',name:'new-name'}},
    deleteVoiceprint:async input=>{calls.push(input.id)},applyDesktopSettings:async()=>{context.currentSettings.voiceprintId='new';return {saved:true}},
    endVoiceprintRecording(){},ipcMain:{handle(_channel,fn){handler=fn}},
  }
  runInNewContext(handlerSource,context)
  const result = handler({sender},{action:'register',audio:new Uint8Array()})
  context.currentSettings = {voiceprintUploadUrl:'https://new.example',voiceprintId:'previous',key:'new-key'}
  release()
  assert.equal((await result).id,'new')
  assert.deepEqual(calls,['read','https://new.example',['https://new.example','new-key'],'read','previous'])
})

test('the panel blocks registration until the upload URL is saved and never stages the identity itself', async () => {
  const {createVoiceprintPanel} = await import('../src/renderer/voiceprint-panel.mjs')
  const elements = new Map()
  const doc = {querySelector(id) {if (!elements.has(id)) elements.set(id,{addEventListener(){}}); return elements.get(id)}}
  let cleanup
  const previous = globalThis.window
  globalThis.window = {addEventListener(name,fn){if(name==='pagehide') cleanup=fn}}
  const saved = {pipelineMode:'cascaded',cascadedAsrProvider:'volcengine',voiceprintId:'',voiceprintName:'',voiceprintUploadUrl:'https://one.example'}
  try {
    const panel = createVoiceprintPanel({document:doc,api:{voiceprint:async()=>({healthy:true})},stage(){}})
    panel.render(saved, {})
    await new Promise(setImmediate)
    assert.equal(elements.get('#voiceprint-register').disabled,false)
    panel.render({...saved,voiceprintUploadUrl:'https://two.example'}, {voiceprintUploadUrl:'https://two.example'})
    assert.equal(elements.get('#voiceprint-register').disabled,true)
  } finally {cleanup?.();globalThis.window=previous}
  const source = await readFile(new URL('../src/renderer/voiceprint-panel.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /stage\(\{voiceprintId/)
})

test('the orb acknowledges a recording lease only after a pending activation settles', async () => {
  const source = await readFile(new URL('../src/renderer/index.mjs', import.meta.url), 'utf8')
  const apply = source.slice(source.indexOf('async function applyVoiceprintRecording'), source.indexOf('function microphoneGated'))
  assert.ok(apply.indexOf('await pendingActivation') >= 0 && apply.indexOf('await pendingActivation') < apply.indexOf('await deactivateCapture()'))
  const activate = source.slice(source.indexOf('async function activateCapture'), source.indexOf('async function startBrowserCapture'))
  assert.match(activate, /presentationMode==='background'\|\|voiceprintRecording\)\{/, 'late activation releases capture during recording')
  assert.match(activate, /pendingActivation = null\n\s*settle\(\)/)
})

test('registration cleanup respects failed recovery and pending backend configuration', async t => {
  const {runInNewContext} = await import('node:vm')
  const {applySettingsTransaction} = await import('../src/main/settings-apply.mjs')
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  const handlerSource = source.slice(source.indexOf("ipcMain.handle('nova:settings:voiceprint'"), source.indexOf("ipcMain.handle('nova:settings:get'"))
  for (const scenario of ['rollback_failed', 'pending_restart', 'rollback_success', 'credential_failed', 'credential_discard_failed']) await t.test(scenario, async () => {
    let handler, restarts = 0, credentialReads = 0
    const deleted = [], events = [], sender = {}
    const original = {voiceprintUploadUrl:'https://upload.example',voiceprintId:'old',voiceprintEnabled:scenario !== 'pending_restart'}
    const context = {
      settingsWindow:{webContents:sender},currentSettings:{...original},voiceprintBusy:false,
      settingsRecoveryAvailable:false,settingsRestartPending:scenario === 'pending_restart',secretCodec:{},net:{fetch(){}},
      decryptSecretsForSpawn:()=>({doubaoAsrApiKey:'key'}),voiceprintHealth:async()=>true,
      accessCredentials:async operation=>{credentialReads++;await Promise.resolve();if(scenario.startsWith('credential_')&&credentialReads===2)throw Error('credential unavailable');return operation()},
      registerVoiceprint:async()=>({id:'new',name:'new-name'}),
      deleteVoiceprint:async({id})=>{deleted.push(id);events.push(`delete:${id}`);if(scenario==='credential_discard_failed')throw Error('delete unavailable')},
      endVoiceprintRecording(){},ipcMain:{handle(_channel,fn){handler=fn}},
      applyDesktopSettings:async(payload,restart)=>applySettingsTransaction({
        coordinator:{run:async(_key,fn)=>({status:'done',value:await fn()})},patch:payload,
        write:async value=>{context.currentSettings={...context.currentSettings,...value.settingsPatch};context.settingsRecoveryAvailable=true;return context.currentSettings},
        publishCommitted(){},publishStatus(){},needsBackendRestart:()=>true,deferRestart:!restart,
        prepareConfiguration:async()=>({}),commitConfiguration:async()=>({}),
        restartBackend:async()=>{restarts++;if(scenario!=='pending_restart')throw Error('restart failed');events.push('restarted')},
        rollback:async()=>{if(scenario==='rollback_failed')throw Error('backend could not stop');context.currentSettings={...original};context.settingsRecoveryAvailable=false},
        complete:async()=>{context.settingsRecoveryAvailable=false},
      }),
    }
    runInNewContext(handlerSource,context)
    const result = await handler({sender},{action:'register',audio:new Uint8Array()})
    assert.equal(credentialReads,2,'registration and final key check use the queued credential path')
    if(scenario==='credential_discard_failed') {
      assert.equal(result.orphanedId,'new','failed cleanup returns the remote ID for recovery')
    } else if(scenario==='credential_failed') {
      assert.deepEqual(deleted,['new'],'a failed final key check discards the newly registered ID')
      assert.equal(result.error,'voiceprint_request_failed')
    } else if(scenario==='rollback_failed') {
      assert.equal(context.currentSettings.voiceprintId,'new')
      assert.deepEqual(deleted,[], 'an ID still referenced by failed recovery must survive')
      assert.equal(result.retainedId,'new')
    } else if(scenario==='pending_restart') {
      assert.equal(restarts,1,'saved disabled does not prove the running backend stopped using the old ID')
      assert.deepEqual(events,['restarted','delete:old'])
      assert.equal(result.id,'new')
    } else {
      assert.equal(context.currentSettings.voiceprintId,'old')
      assert.deepEqual(deleted,['new'])
      assert.equal(result.error,'voiceprint_request_failed')
    }
  })
})
