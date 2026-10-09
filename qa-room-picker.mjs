// Layout-only smoke test, isolated from the user's preview and booking database.
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';
const root=dirname(fileURLToPath(import.meta.url));
const run=resolve(root,'data-qa-room-picker',String(Date.now()));mkdirSync(run,{recursive:true});
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const base=`http://127.0.0.1:${port}`,results=[];
const child=spawn(process.execPath,['server/index.mjs'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),DATA_DIR:run,ALLOW_ANONYMOUS:'1',SEED_DEMO:'0',MS_TENANT_ID:'',MS_CLIENT_ID:'',MS_CLIENT_SECRET:'',APP_BASE_URL:'',MICROSOFT_TOKEN_KEY:'',ADMIN_MS_EMAIL:'',ADMIN_MS_OBJECT_ID:'',BACKUP_DIR:''}});
let logs='',browser;child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const check=(name,good)=>{assert.ok(good,name);results.push(name);console.log('PASS '+name);};
try{
 let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(logs);try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await pause(100);}assert.ok(ready,logs);
 const {chromium}=await import(pathToFileURL(process.env.QA_PLAYWRIGHT_MODULE));browser=await chromium.launch({executablePath:process.env.QA_BROWSER,headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'Asia/Seoul'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.getByRole('button',{name:'빠른 예약 펼치기'}).click();
 check('redundant current-time button removed',await page.locator('.current-time-control').count()===0);
 await page.locator('.daily-timeline').evaluate(el=>{el.scrollTop=0;});await page.locator('.nav-today').click();
 await page.waitForFunction(()=>document.querySelector('.daily-timeline').scrollTop>0);
 check('today button still returns to current time',await page.locator('.daily-timeline').evaluate(el=>el.scrollTop>0));
 await page.locator('.room-picker-toggle').click();
 check('empty favorite banner and duplicate shortcuts removed',await page.locator('.favorite-shortcuts').count()===0&&await page.locator('.room-picker-empty').count()===0);
 await page.getByRole('button',{name:'즐겨찾기만 보기',exact:true}).click();
 check('empty favorite filter explains how to add rooms',await page.locator('.room-picker-empty').isVisible()&&await page.locator('.room-picker-row').count()===0);
 await page.locator('.room-picker-filters').getByRole('button',{name:'전체 회의실 보기',exact:true}).click();
 await page.locator('.room-picker-floor-group').first().locator('.room-picker-row > button:first-child').nth(1).click();
 for(const [width,height] of [[1440,1000],[1280,720],[390,844],[320,740]]){
  await page.setViewportSize({width,height});await pause(150);
  const box=await page.locator('.room-picker-toggle').evaluate(el=>{
   const r=el.getBoundingClientRect(),s=getComputedStyle(el),card=el.closest('.room-picker-card'),floor=el.querySelector('.room-picker-field-floor');
   const children=[...el.querySelectorAll('.room-picker-field-title,.room-picker-field-specs,i')].map(c=>c.getBoundingClientRect());
   return {height:r.height,background:s.backgroundColor,cardBorder:getComputedStyle(card).borderLeftWidth,floorBackground:getComputedStyle(floor).backgroundColor,
    floorSeparator:getComputedStyle(floor,'::before').display,font:getComputedStyle(el.querySelector('strong')).fontSize,
    contained:children.every(c=>c.top>=r.top+7&&c.bottom<=r.bottom-7&&c.left>=r.left&&c.right<=r.right),overflow:document.documentElement.scrollWidth>innerWidth};
  });
  check(`room field has comfortable height ${width}`,box.height>=68);
  check(`previous neutral appearance restored ${width}`,box.background!=='rgb(234, 242, 255)'&&box.cardBorder==='1px'&&box.floorBackground==='rgba(0, 0, 0, 0)'&&box.floorSeparator!=='none');
  check(`text and arrow fit without reducing font ${width}`,box.contained&&parseFloat(box.font)>=15&&!box.overflow);
  await page.locator('.room-picker-card').screenshot({path:resolve(run,`picker-${width}.png`)});
  await page.screenshot({path:resolve(run,`page-${width}.png`),fullPage:true});
 }
 await page.setViewportSize({width:1280,height:900});await page.locator('.room-picker-toggle').click();
 const star=page.locator('.room-picker-row .room-favorite').first();await star.click();check('favorites remain functional',await star.getAttribute('aria-pressed')==='true');
 await page.locator('.room-picker-floor-group').last().locator('.room-favorite').first().click();
 const iconStyle={border:await star.evaluate(el=>getComputedStyle(el).borderTopWidth),color:await page.locator('.room-picker-row-map').first().evaluate(el=>getComputedStyle(el).color)};console.log('ICON_STYLE '+JSON.stringify(iconStyle));
 await page.locator('.room-picker-options').screenshot({path:resolve(run,'rooms-all.png')});
 check('favorite icons are borderless and map icons are muted',iconStyle.border==='0px'&&iconStyle.color==='rgb(120, 134, 154)');
 await page.getByRole('button',{name:'즐겨찾기만 보기',exact:true}).click();
 check('favorites filter shows only saved rooms without duplicates',await page.locator('.room-picker-row').count()===2&&await page.locator('.room-picker-floor-group').count()===2);
 await page.locator('.room-picker-options').screenshot({path:resolve(run,'rooms-favorites.png')});
 await page.locator('.room-favorite').first().click();await page.waitForFunction(()=>document.querySelectorAll('.room-picker-row').length===1);
 check('removing a favorite updates filtered list',await page.locator('.room-picker-row').count()===1);
 await page.locator('.room-favorite').first().click();await page.locator('.room-picker-empty').waitFor({state:'visible'});
 check('last favorite removal shows helpful empty state',await page.locator('.room-picker-empty').isVisible());
 await page.locator('.room-picker-filters').getByRole('button',{name:'전체 회의실 보기',exact:true}).click();
 await page.locator('.room-favorite').first().focus();await page.keyboard.press('Enter');
 check('keyboard can toggle favorites',await page.locator('.room-favorite').first().getAttribute('aria-pressed')==='true');
 await page.locator('.room-picker-floor-group').last().locator('.room-picker-row > button:first-child').first().click();
 check('room selection still works',await page.locator('.room-picker-field-title strong').textContent()==='대회의실');
 check('floor label switches correctly',await page.locator('.room-picker-field-floor').textContent()==='12F');
 const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Seoul'});mobile.on('pageerror',e=>errors.push(e.message));
 await mobile.goto(base);await mobile.getByRole('button',{name:'빠른 예약 펼치기'}).click();await mobile.locator('.room-picker-toggle').click();
 const mobileRow=mobile.locator('.room-picker-row').first();
 check('mobile icon targets remain touch friendly',await mobileRow.evaluate(el=>[...el.querySelectorAll('.room-favorite,.room-picker-row-map')].every(b=>{const r=b.getBoundingClientRect();return r.width>=44&&r.height>=44;})));
 check('mobile menu has no horizontal overflow',await mobile.locator('.room-picker-options').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
 await mobile.locator('.room-favorite').first().tap();await mobile.getByRole('button',{name:'즐겨찾기만 보기',exact:true}).tap();
 check('touch favorite filter works',await mobile.locator('.room-picker-row').count()===1);
 await mobile.locator('.room-picker-options').screenshot({path:resolve(run,'rooms-favorites-mobile.png')});
 await mobile.locator('.room-picker-row-map').first().tap();
 check('location action still opens floor plan',await mobile.locator('.app-shell.map-open').count()===1);
 check('no browser errors',errors.length===0);
 writeFileSync(resolve(run,'results.json'),JSON.stringify({passed:results.length,results},null,2));console.log('RESULT '+results.length+' passed; '+run);
}finally{if(browser)await browser.close();child.kill();}
