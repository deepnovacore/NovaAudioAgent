import Foundation
import EventKit

// Read-only protocol: no EventKit save/remove APIs are exposed.
@main struct CalendarReader {
 static let store = EKEventStore()
 static let iso = ISO8601DateFormatter()
 static func emit(_ value: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data()
  if data.count > 2 * 1024 * 1024 { FileHandle.standardOutput.write(Data("{\"error\":\"response_too_large\",\"complete\":false}\n".utf8)) }
  else { FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])) }
  exit(0)
 }
 static func status() -> String {
  let s = EKEventStore.authorizationStatus(for: .event)
  if #available(macOS 14.0, *) { if s == .fullAccess { return "granted" }; if s == .writeOnly { return "write_only" } }
  else if s == .authorized { return "granted" }
  return s == .notDetermined ? "not_determined" : s == .restricted ? "restricted" : "denied"
 }
 static func main() async {
  DispatchQueue.global().asyncAfter(deadline: .now() + 30) { emit(["error":"timeout", "complete":false]) }
  let data = FileHandle.standardInput.readData(ofLength: 65537)
  guard data.count <= 65536, let r = (try? JSONSerialization.jsonObject(with:data)) as? [String:Any], let command = r["command"] as? String else { emit(["error":"invalid_request", "complete":false]) }
  let permitted: Set<String> = command == "snapshot" ? ["command","calendars","start","end"] : ["command"]
  guard Set(r.keys).isSubset(of:permitted) else { emit(["error":"invalid_request", "complete":false]) }
  if command == "request_access" {
   if #available(macOS 14.0, *) { _ = try? await store.requestFullAccessToEvents() }
   else { _ = try? await withCheckedThrowingContinuation { (c:CheckedContinuation<Bool,Error>) in store.requestAccess(to:.event) { granted,error in if let error=error {c.resume(throwing:error)} else {c.resume(returning:granted)} } } }
   emit(["status":status()])
  }
  if command == "status" { emit(["status":status()]) }
  guard command == "list_calendars" || command == "snapshot" else { emit(["error":"unsupported_command", "complete":false]) }
  guard status() == "granted" else { emit(["error":"permission_denied", "status":status(), "complete":false]) }
  let calendars = store.calendars(for:.event)
  if command == "list_calendars" {
   guard calendars.count <= 200 else { emit(["error":"response_too_large", "complete":false]) }
   emit(["items":calendars.map { ["id":$0.calendarIdentifier,"name":$0.title,"source":$0.source.title] }, "complete":true])
  }
  guard let ids=r["calendars"] as? [String], !ids.isEmpty, ids.count <= 20, let startRaw=r["start"] as? String, let endRaw=r["end"] as? String else { emit(["error":"invalid_request", "complete":false]) }
  iso.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
  guard let start=iso.date(from:startRaw), let end=iso.date(from:endRaw), end > start, end.timeIntervalSince(start) <= 730*86400, start.timeIntervalSinceNow >= -366*86400, end.timeIntervalSinceNow <= 366*86400 else { emit(["error":"scope_denied", "complete":false]) }
  let selected=calendars.filter { ids.contains($0.calendarIdentifier) }
  guard Set(selected.map(\.calendarIdentifier)) == Set(ids) else { emit(["error":"calendar_unavailable", "complete":false]) }
  // ponytail: cap one window at 200 events; split windows when large-calendar acceptance requires pagination.
  var events:[[String:Any]]=[];var complete=true;var bytes=0
  let deadline=Date().addingTimeInterval(25)
  store.enumerateEvents(matching:store.predicateForEvents(withStart:start,end:end,calendars:selected)) { event,stop in
   guard events.count < 200, Date() < deadline else { complete=false;stop.pointee=true;return }
   let occurrence=event.occurrenceDate ?? event.startDate!
   let item:[String:Any]=["calendarId":event.calendar.calendarIdentifier,"id":event.calendarItemIdentifier,"occurrence":iso.string(from:occurrence),"title":event.title ?? "","notes":event.notes ?? "","location":event.location ?? "","start":iso.string(from:event.startDate),"end":iso.string(from:event.endDate),"allDay":event.isAllDay,"timeZone":event.timeZone?.identifier ?? TimeZone.current.identifier,"cancelled":event.status == .canceled]
   let size=(try? JSONSerialization.data(withJSONObject:item).count) ?? 2*1024*1024
   guard bytes+size < 1900000 else { complete=false;stop.pointee=true;return }
   bytes+=size;events.append(item)
  }
  emit(["events":events,"complete":complete,"status":status()])
 }
}
