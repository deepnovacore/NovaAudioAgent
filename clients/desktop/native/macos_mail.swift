import Foundation
import ScriptingBridge
import Carbon

final class MailErrors:NSObject,SBApplicationDelegate {
 var onTimeout:(()->Void)?
 func eventDidFail(_ event:UnsafePointer<AppleEvent>,withError error:Error)->Any? {
  if (error as NSError).code == -1712 {onTimeout?()}
  MailReader.fail((error as NSError).code == -1712 ? "timeout" : "native_unavailable")
 }
}

// Only fixed read selectors are used. No caller-supplied script or Apple-event command.
@main struct MailReader {
 static let iso:ISO8601DateFormatter = { let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds];return f }()
 static func emit(_ value:[String:Any]) -> Never {
  let bytes=(try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys])) ?? Data()
  FileHandle.standardOutput.write(bytes.count<=2*1024*1024 ? bytes : Data("{\"error\":\"response_too_large\"}".utf8));exit(0)
 }
 static func fail(_ code:String) -> Never {emit(["error":code])}
 static func string(_ object:SBObject,_ key:String)->String {let raw=object.value(forKey:key);guard let value=(raw as? String) ?? ((raw as? SBObject)?.get() as? String) else {fail("invalid_contract")};return value}
 static func list(_ object:SBObject,_ key:String)->SBElementArray {guard let value=object.value(forKey:key) as? SBElementArray else {fail("invalid_contract")};return value}
 static func object(_ array:SBElementArray,_ index:Int)->SBObject {guard let value=array.object(at:index) as? SBObject else {fail("invalid_contract")};return value}
 static func identifier(_ account:String,_ path:[String])->String {String(data:try! JSONSerialization.data(withJSONObject:[account,path]),encoding:.utf8)!}
 static func spec(_ want:OSType,_ form:OSType,_ selection:NSAppleEventDescriptor,_ container:NSAppleEventDescriptor)->NSAppleEventDescriptor {
  let r=NSAppleEventDescriptor.record();r.setDescriptor(NSAppleEventDescriptor(typeCode:want),forKeyword:UInt32(keyAEDesiredClass));r.setDescriptor(NSAppleEventDescriptor(enumCode:form),forKeyword:UInt32(keyAEKeyForm));r.setDescriptor(selection,forKeyword:UInt32(keyAEKeyData));r.setDescriptor(container,forKeyword:UInt32(keyAEContainer));return r.coerce(toDescriptorType:UInt32(typeObjectSpecifier))!
 }
 // Fixed get-data event over a bounded message range; never fetch all properties or raw source.
 static func batchIDs(_ account:String,_ path:[String],_ start:Int,_ count:Int)->[Int] {
  guard start>=1,count>=1,count<=8,start+count-1<=500 else {fail("scope_denied")}
  var box=account=="@local" ? NSAppleEventDescriptor.null() : spec(0x6d616374,UInt32(formUniqueID),NSAppleEventDescriptor(string:account),NSAppleEventDescriptor.null())
  for name in path {box=spec(0x6d627870,UInt32(formName),NSAppleEventDescriptor(string:name),box)}
  let range=NSAppleEventDescriptor.record()
  range.setDescriptor(spec(0x6d737367,UInt32(formAbsolutePosition),NSAppleEventDescriptor(int32:Int32(start)),NSAppleEventDescriptor(descriptorType:UInt32(typeCurrentContainer),data:Data())!),forKeyword:UInt32(keyAERangeStart))
  range.setDescriptor(spec(0x6d737367,UInt32(formAbsolutePosition),NSAppleEventDescriptor(int32:Int32(start+count-1)),NSAppleEventDescriptor(descriptorType:UInt32(typeCurrentContainer),data:Data())!),forKeyword:UInt32(keyAERangeStop))
  let messages=spec(0x6d737367,UInt32(formRange),range.coerce(toDescriptorType:UInt32(typeRangeDescriptor))!,box)
  let ids=spec(UInt32(typeProperty),UInt32(formPropertyID),NSAppleEventDescriptor(typeCode:0x49442020),messages)
  let event=NSAppleEventDescriptor(eventClass:UInt32(kAECoreSuite),eventID:UInt32(kAEGetData),targetDescriptor:NSAppleEventDescriptor(bundleIdentifier:"com.apple.mail"),returnID:AEReturnID(kAutoGenerateReturnID),transactionID:AETransactionID(kAnyTransactionID))
  event.setParam(ids,forKeyword:UInt32(keyDirectObject))
  do {let reply=try event.sendEvent(options:.waitForReply,timeout:10)
   if let error=reply.paramDescriptor(forKeyword:UInt32(keyErrorNumber)),error.int32Value != 0 {fail("native_unavailable")}
   guard let result=reply.paramDescriptor(forKeyword:UInt32(keyDirectObject)) else {fail("invalid_contract")}
   guard result.numberOfItems==count else {fail("snapshot_expired")}
   let ids=(1...count).map{Int(result.atIndex($0)?.int32Value ?? 0)}
   guard ids.allSatisfy({$0>0}),Set(ids).count==count else {fail("invalid_contract")}
   return ids
  }catch{fail("timeout")}
 }

 static func main() {
  DispatchQueue.global().asyncAfter(deadline:.now()+28){fail("timeout")}
  let bytes=FileHandle.standardInput.readData(ofLength:65537)
  guard bytes.count<=65536,let input=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any],let command=input["command"] as? String else {fail("invalid_request")}
  guard ["status","request_access","list_mailboxes","snapshot"].contains(command) else {fail("unsupported_command")}
  let keys:Set<String>=command=="snapshot" ? ["command","mailboxes","start","end","cursor"] : ["command"]
  guard Set(input.keys).isSubset(of:keys) else {fail("invalid_request")}
  let target=NSAppleEventDescriptor(bundleIdentifier:"com.apple.mail")
  let permission=AEDeterminePermissionToAutomateTarget(target.aeDesc,typeWildCard,typeWildCard,command=="request_access")
  let status=permission==noErr ? "granted" : permission==OSStatus(-1744) ? "not_determined" : permission==OSStatus(-600) ? "mail_not_running" : "denied"
  if command=="status" || command=="request_access" {emit(["status":status])}
  guard status=="granted" else {fail("permission_denied")}
  guard let app=SBApplication(bundleIdentifier:"com.apple.mail") else {fail("native_unavailable")}
  // Apple-event timeouts use ticks (60/second). Never treat a failed count as an empty mailbox.
  app.timeout=600
  let errors=MailErrors();app.delegate=errors
  let accounts=list(app,"accounts");guard accounts.count<=50 else {fail("response_too_large")}
  var roots:[(String,String,SBObject)]=[("@local","本机",app)]
  for i in 0..<accounts.count {let a=object(accounts,i);roots.append((string(a,"id"),string(a,"name"),a))}
  if command=="list_mailboxes" {
   var items:[[String:String]]=[]
   func walk(_ parent:SBObject,_ account:String,_ name:String,_ path:[String]) {
    let boxes=list(parent,"mailboxes");guard boxes.count<=200,path.count<10 else {fail("response_too_large")}
    for i in 0..<boxes.count {let box=object(boxes,i),next=path+[string(box,"name")];items.append(["id":identifier(account,next),"name":name+" / "+next.joined(separator:" / ")]);guard items.count<=200 else {fail("response_too_large")};walk(box,account,name,next)}
   }
   for (id,name,root) in roots {walk(root,id,name,[])}
   emit(["items":items,"complete":true])
  }
  guard let selected=input["mailboxes"] as? [String],!selected.isEmpty,selected.count<=20,Set(selected).count==selected.count,let startRaw=input["start"] as? String,let endRaw=input["end"] as? String,let start=iso.date(from:startRaw),let end=iso.date(from:endRaw),end>start,end.timeIntervalSince(start)<=180*86400,end.timeIntervalSinceNow<=60,start.timeIntervalSinceNow >= -182*86400 else {fail("scope_denied")}
  var boxes:[(String,SBElementArray,Int,[String])]=[],fingerprints:[String]=[],remaining=500,capped=false
  for key in selected {
   guard key.utf8.count<=4096,let data=key.data(using:.utf8),let tuple=(try? JSONSerialization.jsonObject(with:data)) as? [Any],tuple.count==2,let account=tuple[0] as? String,let path=tuple[1] as? [String],!path.isEmpty,path.count<=10,var box=roots.first(where:{$0.0==account})?.2 else {fail("mailbox_unavailable")}
   for name in path {guard let next=list(box,"mailboxes").object(withName:name) as? SBObject else {fail("mailbox_unavailable")};box=next}
   let messages=list(box,"messages"),count=messages.count;guard count<=1000000 else {fail("response_too_large")}
   let limit=min(count,remaining);remaining-=limit;capped = capped || limit<count
   fingerprints.append("\(count):\(limit>0 ? String(batchIDs(account,path,1,1)[0]) : ""):\(limit>0 ? String(batchIDs(account,path,limit,1)[0]) : "")")
   boxes.append((account,messages,limit,path))
  }
  var boxIndex=0,offset=0
  if let cursor=input["cursor"] as? [String:Any] {guard Set(cursor.keys)==Set(["box","offset","fingerprints"]),let b=cursor["box"] as? Int,let o=cursor["offset"] as? Int,b>=0,b<boxes.count,o>=0,let old=cursor["fingerprints"] as? [String],old==fingerprints else {fail("snapshot_expired")};boxIndex=b;offset=o}
  else if !(input["cursor"] is NSNull) {fail("invalid_request")}
  var messages:[[String:Any]]=[],scanned=0,totalBytes=0
  var ids:[Int]=[],idsOffset=0,idsBox = -1
  let pageStarted=Date()
  // ponytail: Mail has no transactional snapshot; restart if count or boundary IDs change, rescan every completed poll.
  while boxIndex<boxes.count && scanned<20 && messages.count<8 && Date().timeIntervalSince(pageStarted)<8 {
   errors.onTimeout=nil
   let (account,array,limit,path)=boxes[boxIndex];if offset>=limit {boxIndex+=1;offset=0;continue}
   if idsBox != boxIndex || offset>=idsOffset+ids.count {ids=batchIDs(account,path,offset+1,min(8,limit-offset));idsOffset=offset;idsBox=boxIndex}
   if !messages.isEmpty {
    // Commit the successful prefix, leaving the slow message at the cursor for retry.
    let prefix:[String:Any]=["status":"granted","messages":messages,"complete":false,"capped":capped,"cursor":["box":boxIndex,"offset":offset,"fingerprints":fingerprints]]
    errors.onTimeout={emit(prefix)}
   }
   guard let m=array.object(withID:NSNumber(value:ids[offset-idsOffset])) as? SBObject else {fail("invalid_contract")};offset+=1;scanned+=1
   guard let received=m.value(forKey:"dateReceived") as? Date else {fail("invalid_contract")}
   if received<start || received>=end {continue}
   guard let id=m.value(forKey:"id") as? NSNumber,let sent=m.value(forKey:"dateSent") as? Date,let read=m.value(forKey:"readStatus") as? Bool,let flagged=m.value(forKey:"flaggedStatus") as? Bool else {fail("invalid_contract")}
   let recipients=list(m,"recipients");guard recipients.count<=200 else {fail("response_too_large")}
   var addresses:[String]=[];for i in 0..<recipients.count {addresses.append(string(object(recipients,i),"address"))}
   let item:[String:Any]=["account":account,"mailbox":selected[boxIndex],"id":id.stringValue,"messageId":string(m,"messageId"),"subject":string(m,"subject"),"sender":string(m,"sender"),"recipients":addresses,"received":iso.string(from:received),"sent":iso.string(from:sent),"content":string(m,"content"),"read":read,"flagged":flagged]
   totalBytes+=(try? JSONSerialization.data(withJSONObject:item).count) ?? 2000000;guard totalBytes<1900000 else {fail("response_too_large")};messages.append(item)
  }
  if boxIndex<boxes.count && offset>=boxes[boxIndex].2 {boxIndex+=1;offset=0}
  let complete=boxIndex==boxes.count
  emit(["status":"granted","messages":messages,"complete":complete,"capped":capped,"cursor":complete ? NSNull() : ["box":boxIndex,"offset":offset,"fingerprints":fingerprints]])
 }
}
