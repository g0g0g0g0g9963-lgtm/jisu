// Test-only deterministic clock and synthetic OIDC. Never calls Microsoft or any network.
import { pathToFileURL } from 'node:url';
const NativeDate=Date;
const fixed=NativeDate.parse(process.env.TEST_NOW || '2026-10-08T01:15:00Z');
globalThis.Date=class extends NativeDate { constructor(...a){super(...(a.length?a:[fixed]));} static now(){return fixed;} };
globalThis.fetch=async (url,options={})=>{
  if(String(url)!=='https://login.microsoftonline.com/qa-tenant/oauth2/v2.0/token') throw Error('Outbound network blocked in fixture');
  const code=new URLSearchParams(options.body).get('code');
  const users={
    alice:{name:'QA Alice',preferred_username:'alice@example.invalid',oid:'fixture-alice'},
    bob:{name:'QA Bob',preferred_username:'bob@example.invalid',oid:'fixture-bob'},
    same:{name:'QA Shared',preferred_username:'other@example.invalid',oid:'fixture-other'},
    renamed:{name:'QA Alice Renamed',preferred_username:'alice@example.invalid',oid:'fixture-alice'},
    emailChanged:{name:'QA Alice Renamed',preferred_username:'alice.changed@example.invalid',oid:'fixture-alice'},
    spoof:{name:'QA Alice',preferred_username:'alice@example.invalid',oid:'fixture-attacker'},
    noOid:{name:'QA Alice',preferred_username:'alice@example.invalid'},
  };
  const u=users[code];
  if(!u) return new Response(JSON.stringify({error_description:'<img src=x onerror="window.__qa_xss=1">'}),{status:400});
  const payload={...u,aud:'qa-client',tid:'qa-tenant',exp:Math.floor(fixed/1000)+3600};
  return new Response(JSON.stringify({id_token:'fixture.'+Buffer.from(JSON.stringify(payload)).toString('base64url')+'.fixture'}),{status:200});
};
if(process.env.TEST_FIXTURE_SSO==='1'||process.env.TEST_FIXTURE_BOUNDARIES==='1'){
 const db=await import(pathToFileURL(process.cwd()+'/server/db.mjs'));
 const base={roomId:process.env.TEST_ROOM,dates:['2026-10-09'],start:'16:00',end:'17:00',owner:'QA Shared',team:'QA',purpose:'Legacy ownership fixture'};
 if(process.env.TEST_FIXTURE_SSO==='1'){
  db.createBookings(base);
  db.createBookings({...base,start:'17:00',end:'17:30',owner:'QA Old Email Owner',ownerEmail:'alice@example.invalid',purpose:'Legacy email ownership fixture'});
 }
 if(process.env.TEST_FIXTURE_BOUNDARIES==='1'){
  db.createBookings({...base,dates:['2026-10-08'],start:'09:00',end:'11:00',owner:'QA Alice',purpose:'Ongoing fixture'});
  db.createBookings({...base,roomId:process.env.TEST_ROOM2,dates:['2026-10-08'],start:'09:00',end:'10:00',owner:'QA Alice',purpose:'Ended fixture'});
 }
}

