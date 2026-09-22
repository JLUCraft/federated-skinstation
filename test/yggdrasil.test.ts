import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verify} from 'node:crypto';
import {PNG} from 'pngjs';
import {site} from './helpers/site.js';

test('Yggdrasil optional client token, refresh failure atomicity, requestUser and idempotent invalidation',async()=>{
 const s=await site();try{
  const a=await s.enroll('Contract');assert.match(a.clientToken,/^[a-f0-9]{32}$/);
  const selected=await s.post('/authserver/refresh',{accessToken:a.accessToken,selectedProfile:a.selectedProfile});assert.equal(selected.statusCode,400);assert.equal(selected.json().error,'IllegalArgumentException');
  assert.equal((await s.post('/authserver/validate',{accessToken:a.accessToken})).statusCode,204);
  assert.equal((await s.post('/authserver/refresh',{accessToken:a.accessToken,clientToken:'wrong'})).statusCode,403);
  const refreshed=await s.post('/authserver/refresh',{accessToken:a.accessToken});assert.equal(refreshed.statusCode,200,refreshed.body);const next=refreshed.json();assert.equal(next.clientToken,a.clientToken);assert.equal(next.user,undefined);
  assert.equal((await s.post('/authserver/validate',{accessToken:a.accessToken})).statusCode,403);
  assert.equal((await s.post('/authserver/invalidate',{accessToken:next.accessToken,clientToken:'deliberately-wrong'})).statusCode,204);
  assert.equal((await s.post('/authserver/invalidate',{accessToken:next.accessToken})).statusCode,204);
  assert.equal((await s.post('/authserver/invalidate',{accessToken:'unknown'})).statusCode,204);
 }finally{await s.close();}
});
test('Yggdrasil join IP binding, lookup aliases and signed textures',async()=>{
 const s=await site();try{
  const a=await s.enroll('Network');await s.post('/sessionserver/session/minecraft/join',{accessToken:a.accessToken,selectedProfile:a.selectedProfile.id,serverId:'unique-hash'});
  const path='/sessionserver/session/minecraft/hasJoined?username=Network&serverId=unique-hash';
  assert.equal((await s.app.inject(path+'&ip=192.0.2.1')).statusCode,204);
  const joined=await s.app.inject(path+'&ip=127.0.0.1');assert.equal(joined.statusCode,200);
  const texture=joined.json().properties.find((p:{name:string})=>p.name==='textures');assert.ok(verify('RSA-SHA1',Buffer.from(texture.value),s.keys.publicKey,Buffer.from(texture.signature,'base64')));
  for(const route of ['/api/users/profiles/minecraft/Network','/minecraftservices/minecraft/profile/lookup/name/Network'])assert.equal((await s.app.inject(route)).json().id,a.selectedProfile.id);
  assert.equal((await s.post('/minecraftservices/minecraft/profile/lookup/bulk/byname',['Network','network','Missing'])).json().length,1);
  assert.equal((await s.app.inject('/')).headers['x-authlib-injector-api-location'],'https://skin.example.test/');
 }finally{await s.close();}
});
test('standard multipart textures enforce owner, dimensions, model, cape padding and deletion',async()=>{
 const s=await site();try{
  const a=await s.enroll('Textures'),b=await s.enroll('Other');
  const upload=async(kind:string,width:number,height:number,owner=a,model='slim')=>{
   const png=PNG.sync.write(new PNG({width,height}));const boundary='contract-boundary';
   const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="texture.png"\r\nContent-Type: image/png\r\n\r\n`),png,Buffer.from(`\r\n--${boundary}--\r\n`)]);
   return s.app.inject({method:'PUT',url:`/api/user/profile/${a.selectedProfile.id}/${kind}`,headers:{authorization:`Bearer ${owner.accessToken}`,'content-type':`multipart/form-data; boundary=${boundary}`},payload});
  };
  assert.equal((await upload('skin',64,64,b)).statusCode,403);
  assert.equal((await upload('skin',63,64)).statusCode,403);
  const skin=await upload('skin',64,64);assert.equal(skin.statusCode,204,skin.body);
  const cape=await upload('cape',22,17,a,'');assert.equal(cape.statusCode,204,cape.body);
  const response=await s.app.inject('/sessionserver/session/minecraft/profile/'+a.selectedProfile.id);
  const value=response.json().properties.find((p:{name:string})=>p.name==='textures').value;const textures=JSON.parse(Buffer.from(value,'base64').toString()).textures;
  assert.equal(textures.SKIN.metadata.model,'slim');const data=await s.app.inject(new URL(textures.CAPE.url).pathname);assert.equal(data.headers['content-type'],'image/png');assert.equal(PNG.sync.read(data.rawPayload).width,64);
  assert.equal((await s.app.inject({method:'DELETE',url:`/api/user/profile/${a.selectedProfile.id}/skin`})).statusCode,401);
  assert.equal((await s.app.inject({method:'DELETE',url:`/api/user/profile/${a.selectedProfile.id}/skin`,headers:{authorization:`Bearer ${a.accessToken}`}})).statusCode,204);
  const after=(await s.app.inject('/sessionserver/session/minecraft/profile/'+a.selectedProfile.id)).json();assert.equal(JSON.parse(Buffer.from(after.properties.find((p:{name:string})=>p.name==='textures').value,'base64').toString()).textures.SKIN,undefined);
 }finally{await s.close();}
});
