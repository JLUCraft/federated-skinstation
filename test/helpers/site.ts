import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {build,type Config} from '../../server/app.js';
import type {MuaConfig} from '../../server/mua.js';
export async function site(mua?:MuaConfig,muaFetch?:typeof fetch){
 const dir=await mkdtemp(join(tmpdir(),'jlu-contract-'));const keys=generateKeyPairSync('rsa',{modulusLength:2048});
 await writeFile(join(dir,'key.pem'),keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 if(mua?.member?.oauthSigningKey)mua.member.oauthSigningKey=join(dir,'key.pem');
 if(mua?.member){mua.member.storageKeyEnv='JLU_TEST_STORAGE_KEY';process.env.JLU_TEST_STORAGE_KEY=randomBytes(32).toString('hex');}
 let code='';
 const config:Config={listen:'127.0.0.1',port:0,origin:'https://skin.example.test',database:join(dir,'db'),textures:join(dir,'textures'),signingKey:join(dir,'key.pem'),schools:{jlu:{emailDomains:['school.test']}},smtp:{host:'unused',port:465,from:'test@example.test'},mua};
 const app=await build(config,{mail:async(_,value)=>{code=value;},muaFetch}).catch(async error=>{await rm(dir,{recursive:true,force:true});throw error;});
 const post=(url:string,payload:object)=>app.inject({method:'POST',url,payload});
 async function enroll(name:string){const account={email:name.toLowerCase()+'@school.test',name,school:'jlu',password:'password-for-contract-testing'};
  const start=await post('/api/email/start',account);if(start.statusCode!==202)throw new Error(start.body);
  await post('/api/email/confirm',{email:account.email,code});
  return (await post('/authserver/authenticate',{username:account.email,password:account.password,requestUser:true})).json();
 }
 return {app,dir,keys,post,enroll,close:async()=>{await app.close();await rm(dir,{recursive:true,force:true});}};
}
