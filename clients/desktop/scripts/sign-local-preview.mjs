// Local developer preview only. Distribution continues to use electron-builder's
// Developer ID / hardened-runtime signing and notarization path, unchanged.
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
const require=createRequire(import.meta.url)
const sign=require('./sign-mac-with-native-manifest.cjs')
const app=process.argv[2]
if(process.platform!=='darwin'||!app?.endsWith('.app'))throw new Error('Usage: node scripts/sign-local-preview.mjs /absolute/path/to/Preview.app')
await sign({app:resolve(app),identity:'-',identityValidation:false,platform:'darwin',version:'43.2.0',type:'development',
  // Ad-hoc signatures have no Team ID, so they cannot use Team-ID library validation.
  // No host OS setting is changed. Renderer sandbox / context isolation stay enabled.
  optionsForFile:()=>({hardenedRuntime:false}),preAutoEntitlements:false,preEmbedProvisioningProfile:false})
console.log('Local preview signature and native resource manifest verified')
