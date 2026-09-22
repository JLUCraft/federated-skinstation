import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../server/app.js';
import { Store } from '../server/store.js';
import { muaSubject, yggdrasilRoot, verifyHost } from '../server/mua.js';
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString();
const headers=(body:Buffer,timestamp:string,nonce:string)=>({'x-message-timestamp':timestamp,'x-message-nonce':nonce,'x-message-signature':sign('RSA-SHA256',Buffer.concat([body,Buffer.from(timestamp+nonce)]),keys.privateKey).toString('base64')});
test('MUA selectors and subjects preserve provider boundaries',()=>{
 assert.equal(yggdrasilRoot('https://skin.mualliance.ltd/api/union','only',['SJMC','FDC','SJMC']),'https://skin.mualliance.ltd/api/union/yggdrasil/only/FDC_SJMC');
 assert.throws(()=>yggdrasilRoot('https://skin.mualliance.ltd/api/union','only',[]));
 assert.throws(()=>yggdrasilRoot('https://skin.mualliance.ltd/api/union','only',['MUA/../all']));
 assert.notEqual(muaSubject({sub:'MUA:123',email:'same@example.org'}),muaSubject({sub:'SJMC:123',email:'same@example.org'}));
 assert.throws(()=>muaSubject({sub:'123'}));
});
test('host signature uses exact bytes, nonce replay protection and asymmetric clock window',()=>{
 const db=new Store(':memory:'); db.db.exec('CREATE TABLE mua_nonces(nonce TEXT PRIMARY KEY,expires INTEGER NOT NULL)');
 try {
  const raw=Buffer.from('{ "nonce": "test" }');const h=headers(raw,'100','nonce');
  verifyHost(db,publicKey,raw,h,100);
  assert.throws(()=>verifyHost(db,publicKey,raw,h,100));
  assert.throws(()=>verifyHost(db,publicKey,Buffer.from('{"nonce":"test"}'),headers(raw,'100','changed'),100));
  assert.throws(()=>verifyHost(db,publicKey,raw,headers(raw,'89','past'),100));
  assert.throws(()=>verifyHost(db,publicKey,raw,headers(raw,'131','future'),100));
  verifyHost(db,publicKey,raw,headers(raw,'90','boundary'),100);
 } finally {db.close();}
});
test('mail enrollment, Yggdrasil invalidation and signed MUA diagnosis HTTP flow',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'skin-test-'));
 await writeFile(join(dir,'rsa.pem'),keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 let verification='';
 process.env.TEST_MUA_SECRET='test-only-secret';
 let exchanges=0;
 const app=await build({listen:'127.0.0.1',port:0,origin:'http://127.0.0.1',database:join(dir,'db.sqlite'),textures:join(dir,'textures'),signingKey:join(dir,'rsa.pem'),schools:{jlu:{emailDomains:['mails.jlu.edu.cn'],issuerKey:'unused',delegation:'unused',roots:[]}},peers:[],smtp:{host:'localhost',port:465,from:'test@localhost'},mua:{apiRoot:'https://skin.mualliance.ltd/api/union',hostPublicKey:publicKey,oauth:{clientId:'test',clientSecretEnv:'TEST_MUA_SECRET'}}},{mail:async(_email,code)=>{verification=code;},muaFetch:async(input,init)=>{ exchanges++; const url=String(input); assert.equal(init?.redirect,'error'); if(url.endsWith('/token'))return new Response(JSON.stringify({access_token:'mock-access-token'})); assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer mock-access-token'); return new Response(JSON.stringify({sub:'MUA:123',nickname:'NotTheGameName',email:'someone@other.edu'})); }});
 try {
  const post=(url:string,payload:object)=>app.inject({method:'POST',url,payload});
  const account={email:'student@mails.jlu.edu.cn',school:'jlu',name:'Student',password:'long-test-password'};
  assert.equal((await post('/api/email/start',account)).statusCode,202);
  assert.equal((await post('/authserver/authenticate',{username:account.email,password:account.password,requestUser:true})).statusCode,403);
  assert.equal((await post('/api/email/confirm',{email:account.email,code:verification})).statusCode,204);
  assert.equal((await post('/api/email/confirm',{email:account.email,code:verification})).statusCode,403);
  const login=(await post('/authserver/authenticate',{username:account.email,password:account.password,requestUser:true})).json(); assert.ok(login.accessToken);
  assert.equal((await post('/sessionserver/session/minecraft/join',{accessToken:login.accessToken,selectedProfile:login.selectedProfile.id,serverId:'match'})).statusCode,204);
  assert.equal((await app.inject('/sessionserver/session/minecraft/hasJoined?username=Student&serverId=match')).json().id,login.selectedProfile.id);
  const link=await app.inject({method:'POST',url:'/api/mua/link',headers:{authorization:`Bearer ${login.accessToken}`}});assert.equal(link.statusCode,200);
  const state=new URL(link.json().url).searchParams.get('state');assert.equal((await app.inject(`/api/mua/callback?state=${state}&code=bad`)).statusCode,403);
  const cookie=String(link.headers['set-cookie']).split(';')[0];
  const callback=`/api/mua/callback?state=${state}&code=opaque-code`;
  assert.equal((await app.inject({url:callback,headers:{cookie}})).statusCode,302);
  assert.equal(exchanges,2);
  assert.equal((await app.inject({url:callback,headers:{cookie}})).statusCode,403);
  const evidence=(await app.inject({url:'/api/mua/link',headers:{authorization:`Bearer ${login.accessToken}`}})).json();
  assert.equal(evidence.evidence,'mua_account_only');assert.equal(evidence.link.subject,'MUA:123');
  assert.equal((await app.inject({url:'/api/me',headers:{authorization:`Bearer ${login.accessToken}`}})).json().school,'jlu');
  assert.equal((await post('/authserver/invalidate',{accessToken:login.accessToken})).statusCode,204);
  assert.equal((await app.inject('/sessionserver/session/minecraft/hasJoined?username=Student&serverId=match')).statusCode,204);
  const raw=Buffer.from('{ "nonce": "probe" }');const h={...headers(raw,String(Math.floor(Date.now()/1000)),'probe-once'),'content-type':'application/json'};
  const response=await app.inject({method:'POST',url:'/api/union/member/diagnose',headers:h,payload:raw});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().nonce,'probe');
  assert.equal((await app.inject({method:'POST',url:'/api/union/member/diagnose',headers:h,payload:raw})).statusCode,403);
 } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});
test('signed MUA member control rotates scoped keys, syncs profiles and remaps UUID atomically',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mua-member-test-'));
 await writeFile(join(dir,'rsa.pem'),keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 const texture=generateKeyPairSync('rsa',{modulusLength:2048});
 let code='';let synced:unknown;
 const app=await build({listen:'127.0.0.1',port:0,origin:'http://127.0.0.1',database:join(dir,'db'),textures:join(dir,'textures'),signingKey:join(dir,'rsa.pem'),schools:{jlu:{emailDomains:['mails.jlu.edu.cn'],issuerKey:'unused',delegation:'unused',roots:[]}},peers:[],smtp:{host:'localhost',port:465,from:'test@localhost'},mua:{apiRoot:'https://skin.mualliance.ltd/api/union',hostPublicKey:publicKey,member:{keyEnv:'TEST_UNUSED_MEMBER_KEY'}}},{mail:async(_,value)=>{code=value;},muaFetch:async(input,init)=>{
  assert.equal(new Headers(init?.headers).get('X-Union-Member-Key'),'rotated-member-secret');
  const url=String(input);
  if(url.endsWith('/serverlist'))return Response.json({servers:[],version:2});
  if(url.endsWith('/privatekey'))return Response.json({privateKey:texture.privateKey.export({type:'pkcs8',format:'pem'}).toString(),privateKeyVersion:3});
  assert.ok(url.endsWith('/sync'));synced=JSON.parse(String(init?.body));return Response.json({});
 }});
 let nonce=0;
 const command=async(path:string,body:object)=>{
  const bytes=Buffer.from(JSON.stringify(body));
  return app.inject({method:'POST',url:'/api/union/member/'+path,headers:{...headers(bytes,String(Math.floor(Date.now()/1000)),String(++nonce)),'content-type':'application/json'},payload:bytes});
 };
 try {
  const account={email:'mua@mails.jlu.edu.cn',school:'jlu',name:'MuaTest',password:'a-long-test-password'};
  await app.inject({method:'POST',url:'/api/email/start',payload:account});
  await app.inject({method:'POST',url:'/api/email/confirm',payload:{email:account.email,code}});
  const login=async()=> (await app.inject({method:'POST',url:'/authserver/authenticate',payload:{username:account.email,password:account.password,requestUser:true}})).json();
  const old=await login();assert.ok(old.accessToken);
  assert.equal((await app.inject({method:'POST',url:'/api/union/member/updatebackendkey',payload:{key:'attacker'}})).statusCode,403);
  assert.equal((await command('updatebackendkey',{key:'rotated-member-secret'})).statusCode,204);
  assert.equal((await command('updatelist',{})).statusCode,204);
  assert.equal((await command('updateprivatekey',{})).statusCode,204);
  assert.equal((await app.inject('/')).json().signaturePublickey,texture.publicKey.export({type:'spki',format:'pem'}).toString());
  assert.equal((await command('sync',{})).statusCode,204);
  assert.deepEqual(synced,{profileList:{[old.selectedProfile.id]:'MuaTest'}});
  const mapped='f'.repeat(32);
  assert.equal((await command('remapuuid',{remapped_uuid:{[old.selectedProfile.id]:mapped}})).statusCode,204);
  assert.equal((await app.inject({method:'POST',url:'/authserver/validate',payload:{accessToken:old.accessToken}})).statusCode,403);
  const next=await login();assert.equal(next.selectedProfile.id,mapped);assert.equal(next.user.id,old.user.id);
  assert.equal((await command('remapuuid',{remapped_uuid:{[old.selectedProfile.id]:mapped}})).statusCode,204);
  assert.equal((await app.inject({method:'POST',url:'/authserver/validate',payload:{accessToken:next.accessToken}})).statusCode,204);
  assert.equal((await app.inject({method:'POST',url:'/sessionserver/session/minecraft/join',payload:{accessToken:next.accessToken,selectedProfile:mapped,serverId:'mua-match'}})).statusCode,204);
  assert.equal((await app.inject('/sessionserver/session/minecraft/hasJoined?username=MuaTest&serverId=mua-match')).json().id,mapped);
  assert.equal((await app.inject(`/sessionserver/session/minecraft/profile/${old.selectedProfile.id}`)).statusCode,204);
  assert.equal((await app.inject(`/sessionserver/session/minecraft/profile/${mapped}`)).json().id,mapped);
 } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});
