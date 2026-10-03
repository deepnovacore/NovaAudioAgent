import {parentPort,workerData} from 'node:worker_threads'
import {DatabaseSync} from 'node:sqlite'
import {preparePrivateDatabasePath} from '../storage/private-database.js'
if(!parentPort)throw Error('personal lock requires worker')
const database=new DatabaseSync(preparePrivateDatabasePath((workerData as {path:string}).path))
try {
 database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
 parentPort.postMessage({ready:true})
 parentPort.once('message',()=>{database.exec('ROLLBACK');database.close();parentPort!.close()})
} catch {
 database.close()
 parentPort.postMessage({ready:false})
 parentPort.close()
}
