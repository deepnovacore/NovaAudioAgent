import assert from 'node:assert/strict'
import {test} from 'node:test'
import {normalizeSettings,SECRET_KEYS,backendSettings} from '../src/main/settings-store.mjs'
import {capabilityEnvironment,SECRET_ENV_MAP} from '../src/main/backend.mjs'
for(const provider of ['openai','gemini']) {
 test(`${provider} survives desktop normalization and selected credential projection`,()=>{
  const model=provider==='openai'?'gpt-6-luna':'gemini-3.5-flash-lite'
  const settings=normalizeSettings({pipelineMode:'cascaded',integratedProvider:provider,cascadedLlmProvider:provider,cascadedLlmModels:{[provider]:model}})
  assert.equal(settings.integratedProvider,provider)
  assert.equal(backendSettings(settings).cascadedLlmProvider,provider)
  assert.equal(settings.cascadedLlmModels[provider],model)
  const key=`${provider}ApiKey`, env=`${provider.toUpperCase()}_API_KEY`
  assert.ok(SECRET_KEYS.includes(key));assert.equal(SECRET_ENV_MAP[key],env)
  const actual=capabilityEnvironment(settings,{[key]:'selected',dashscopeApiKey:'domestic'},{MEMORY_CONNECTION:'disabled'},{modules:{knowledge:{enabled:false},search:{enabled:false}}})
  assert.equal(actual[env],'selected');assert.equal(actual.DASHSCOPE_API_KEY,undefined)
 })
}
test('partial settings use the selected global provider model and voice defaults',()=>{
 for(const [provider,model,voice] of [['openai','gpt-realtime-2.1-mini','marin'],['gemini','gemini-3.8-live','Kore']]){
  const settings=normalizeSettings({integratedProvider:provider})
  assert.equal(settings.integratedModel,model)
  assert.equal(settings.integratedVoice,voice)
 }
})
