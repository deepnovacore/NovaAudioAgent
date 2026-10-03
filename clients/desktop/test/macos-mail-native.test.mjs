import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'

test('Mail Apple-event failures cannot report an empty successful snapshot',{skip:process.platform!=='darwin'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nova-mail-native-'))
 try {
  const source=await readFile(new URL('../native/macos_mail.swift',import.meta.url),'utf8')
  await writeFile(join(dir,'check.swift'),source.replace('@main struct MailReader','struct MailReader')+`
@main struct Check {
 static func main() {
  if CommandLine.arguments[1] == "batch-over-limit" {_=MailReader.batchIDs("fixture",["INBOX"],499,8);MailReader.emit(["unexpected":true])}
  var event=AppleEvent()
  if CommandLine.arguments[1] == "partial-timeout" {
   let errors=MailErrors();errors.onTimeout={MailReader.emit(["complete":false,"kept":2,"cursor":2])}
   _=errors.eventDidFail(&event,withError:NSError(domain:NSOSStatusErrorDomain,code:-1712))
  }
  _=MailErrors().eventDidFail(&event,withError:NSError(domain:NSOSStatusErrorDomain,code:Int(CommandLine.arguments[1])!))
  MailReader.emit(["complete":true,"messages":[]])
 }
}
`)
  execFileSync('xcrun',['swiftc','-module-cache-path',join(dir,'cache'),'-parse-as-library',join(dir,'check.swift'),'-o',join(dir,'check')])
  assert.deepEqual(JSON.parse(execFileSync(join(dir,'check'),['partial-timeout'],{encoding:'utf8'})),{complete:false,kept:2,cursor:2})
  for(const [code,error] of [['-1712','timeout'],['-1743','native_unavailable'],['batch-over-limit','scope_denied']]){
   assert.deepEqual(JSON.parse(execFileSync(join(dir,'check'),[code],{encoding:'utf8'})),{error})
  }
 } finally {await rm(dir,{recursive:true,force:true})}
})
