import {test} from 'node:test';
import assert from 'node:assert/strict';
import {constants,createHmac,generateKeyPairSync,privateDecrypt,sign,verify} from 'node:crypto';
import {site} from './helpers/site.js';
import type {MuaConfig} from '../server/mua.js';

test('member signed email lookup, cross-site binding ownership and administrator blacklist isolation',async()=>{
 const host=generateKeyPairSync('rsa',{modulusLength:2048});const cfg:MuaConfig={apiRoot:'https://mua.example.test/api/union',hostPublicKey:host.publicKey.export({type:'spki',format:'pem'}).toString(),member:{keyEnv:'JLU_TEST_MEMBER',adminAccounts:[]}};
 process.env.JLU_TEST_MEMBER='only-test-key';const calls:{url:string;body:unknown}[]=[];
 const s=await site(cfg,async(input,init)=>{assert.equal(new Headers(init?.headers).get('X-Union-Member-Key'),'only-test-key');calls.push({url:String(input),body:init?.body?JSON.parse(String(init.body)):null});return Response.json(String(input).includes('unmapped')?[]:{token:'binding-code',data:[]});});
 try{
  const a=await s.enroll('Member'),b=await s.enroll('Nonadmin');cfg.member!.adminAccounts!.push(a.user.id);
  const auth=(token:string)=>({authorization:`Bearer ${token}`});
  assert.equal((await s.app.inject({url:'/api/mua/admin/blacklist',headers:auth(b.accessToken)})).statusCode,403);
  assert.equal((await s.app.inject({url:'/api/mua/admin/blacklist?page=2&q=test',headers:auth(a.accessToken)})).statusCode,200);
  assert.ok(calls.at(-1)!.url.endsWith('/blacklist/query?page=2&q=test'));
  const prior=calls.length;
  assert.equal((await s.app.inject({method:'POST',url:'/api/mua/profiles/bind',headers:auth(a.accessToken),payload:{uuid:b.selectedProfile.id}})).statusCode,403);assert.equal(calls.length,prior);
  assert.equal((await s.app.inject({method:'POST',url:'/api/mua/profiles/bindto',headers:auth(a.accessToken),payload:{token:'other-site-code'}})).statusCode,200);assert.deepEqual(calls.at(-1)!.body,{uuid:a.selectedProfile.id,token:'other-site-code'});
  assert.equal((await s.app.inject({url:'/api/mua/profiles',headers:auth(a.accessToken)})).statusCode,200);
  const timestamp=String(Math.floor(Date.now()/1000)),nonce='query-email';const headers={'x-message-timestamp':timestamp,'x-message-nonce':nonce,'x-message-signature':sign('RSA-SHA256',Buffer.from(timestamp+nonce),host.privateKey).toString('base64')};
  assert.equal((await s.app.inject('/api/union/member/queryemail?username=Member')).statusCode,403);
  const email=await s.app.inject({url:'/api/union/member/queryemail?username=Member',headers});assert.equal(email.statusCode,200,email.body);assert.equal(email.json().email,'member@school.test');
  assert.equal((await s.app.inject({url:'/api/union/member/queryemail?username=Member',headers})).statusCode,403);
 }finally{await s.close();delete process.env.JLU_TEST_MEMBER;}
});
test('MUA provider requires explicit consent, authenticates encrypted envelope and consumes request once',async()=>{
 const host=generateKeyPairSync('rsa',{modulusLength:2048});const cfg:MuaConfig={apiRoot:'https://mua.example.test/api/union',hostPublicKey:host.publicKey.export({type:'spki',format:'pem'}).toString(),member:{keyEnv:'JLU_TEST_PROVIDER',oauthSigningKey:'fixture'}};
 process.env.JLU_TEST_PROVIDER='provider-test-key';const s=await site(cfg,async input=>{assert.ok(String(input).endsWith('/oauth2/backend'));return Response.json({publicKey:host.publicKey.export({type:'spki',format:'pem'}).toString()});});
 try{
  const a=await s.enroll('Provider');const request=await s.app.inject('/api/union/member/oauth2/grant?state=original-state&client_id=app');assert.equal(request.statusCode,302);
  const ticket=new URLSearchParams(new URL(request.headers.location!).hash.slice(1)).get('mua-grant');const headers={authorization:`Bearer ${a.accessToken}`};
  assert.equal((await s.app.inject({method:'POST',url:'/api/mua/authorize',headers,payload:{ticket,consent:false}})).statusCode,403);
  const accepted=await s.app.inject({method:'POST',url:'/api/mua/authorize',headers,payload:{ticket,consent:true}});assert.equal(accepted.statusCode,200,accepted.body);
  const url=new URL(accepted.json().url);assert.equal(url.origin,'https://mua.example.test');assert.equal(url.searchParams.get('state'),'original-state');
  const encrypted=Buffer.from(url.searchParams.get('userInfoToken')!,'base64'),blocks:Buffer[]=[];
  for(let offset=0;offset<encrypted.length;offset+=256){const block=privateDecrypt({key:host.privateKey,padding:constants.RSA_NO_PADDING},encrypted.subarray(offset,offset+256));assert.equal(block[0],0);assert.equal(block[1],2);const end=block.indexOf(0,2);assert.ok(end>=10);blocks.push(block.subarray(end+1));}
  const envelope=JSON.parse(Buffer.concat(blocks).toString());assert.equal(envelope.mac,createHmac('sha256','provider-test-key').update(envelope.userInfo).digest('hex'));
  assert.ok(verify('RSA-SHA256',Buffer.from(envelope.userInfo+'.'+envelope.mac),s.keys.publicKey,Buffer.from(envelope.signature,'base64')));
  const claim=JSON.parse(Buffer.from(envelope.userInfo,'base64').toString());assert.equal(claim.email,'provider@school.test');assert.equal(claim.nickname,'Provider');assert.ok(Number.isSafeInteger(claim.uid));
  assert.equal((await s.app.inject({method:'POST',url:'/api/mua/authorize',headers,payload:{ticket,consent:true}})).statusCode,403);
  assert.equal((await s.app.inject('/api/union/member/oauth2/grant?userInfoToken=inject')).statusCode,403);
 }finally{await s.close();delete process.env.JLU_TEST_PROVIDER;}
});
