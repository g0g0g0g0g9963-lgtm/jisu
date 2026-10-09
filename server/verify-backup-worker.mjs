import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
// Read-only verification, off the request thread. This never opens the live DB.
let database;
try {
  database=new DatabaseSync(workerData.path,{readOnly:true});
  const integrity=database.prepare("PRAGMA integrity_check").all();
  if(integrity.length!==1 || Object.values(integrity[0])[0]!=="ok")throw new Error("Integrity failure");
  const columns=database.prepare("PRAGMA table_info(bookings)").all().map(row=>row.name);
  if(!["id","room_id","date","start","end","owner"].every(key=>columns.includes(key)))throw new Error("Schema failure");
  const bookings=Number(database.prepare("SELECT COUNT(*) AS count FROM bookings").get().count);
  parentPort.postMessage({ok:true,bookings});
}catch{parentPort.postMessage({ok:false});}finally{database?.close();}
