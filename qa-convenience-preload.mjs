// Isolated, synthetic Microsoft fixture. Never sends requests to a real external service.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
if(process.env.NODE_ENV!=='test'||!process.env.DATA_DIR?.includes('data-qa-convenience'))throw Error('Isolated QA only');
const file=join(process.env.DATA_DIR,'mock-graph.json');
const state=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{events:[],calls:[],refreshes:0};
const persist=()=>writeFileSync(file,JSON.stringify(state,null,2));
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const people=[{id:'employee-one',displayName:'김민수',mail:'minsu.one@example.invalid'},{id:'employee-two',displayName:'김민수',mail:'minsu.two@example.invalid'}];
globalThis.fetch=async(url,options={})=>{
 const target=new URL(url);
 if(target.href==='https://login.microsoftonline.com/qa-tenant/oauth2/v2.0/token'){
  const body=new URLSearchParams(options.body),code=body.get('code'),refresh=body.get('refresh_token');
  const owner=(refresh||code)==='bob'?'bob':'alice';
  if(refresh){state.refreshes++;persist();return json({access_token:owner,refresh_token:owner,expires_in:3600});}
  const claims={oid:'qa-'+owner,name:'QA '+owner,email:owner+'@example.invalid',tid:'qa-tenant',aud:'qa-client',exp:Math.floor(Date.now()/1000)+3600};
  return json({id_token:'x.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.x',access_token:owner,refresh_token:owner,expires_in:code==='expired'?1:3600,
    scope:code==='noConsent'?'openid profile email':'openid profile email User.ReadBasic.All Calendars.ReadWrite'});
 }
 if(target.origin!=='https://graph.microsoft.com')throw Error('External network blocked in QA');
 const owner=options.headers.authorization.replace('Bearer ',''),method=options.method||'GET';
 const body=options.body?JSON.parse(options.body):null;
 state.calls.push({owner,method,path:target.pathname,body});persist();
 if(target.pathname==='/v1.0/users')return json({value:people});
 if(target.pathname==='/v1.0/me/events'&&method==='POST'){
  let event=state.events.find(e=>e.owner===owner&&e.body.transactionId===body.transactionId);
  if(!event){event={id:'event-'+(state.events.length+1),owner,body,deleted:false};state.events.push(event);persist();}
  if(body.subject.startsWith('QA ambiguous')&&!event.responseLost){event.responseLost=true;persist();throw Error('Synthetic response lost AFTER calendar creation');}
  if(body.subject.startsWith('QA slow'))await new Promise(r=>setTimeout(r,1500));
  return json({id:event.id},201);
 }
 if(target.pathname.startsWith('/v1.0/me/events/')){
  const id=decodeURIComponent(target.pathname.split('/').at(-1)),event=state.events.find(e=>e.id===id&&e.owner===owner&&!e.deleted);
  if(!event)return json({},404);
  if(method==='PATCH'){
   if(body.subject.startsWith('QA forbidden'))return json({},403);
   if(body.subject.startsWith('QA missing'))return json({},404);
   event.body={...event.body,...body};persist();return json({id});
  }
  if(method==='DELETE'){event.deleted=true;persist();return new Response(null,{status:204});}
 }
 throw Error('Unexpected Graph call '+method+' '+target.pathname);
};
persist();
