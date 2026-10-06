// Disposable two-school acceptance fixture. No external mail, MUA account or production key.
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {build,type Config} from '../../server/app.js';

process.umask(0o077);
const state=process.env.ROOMS_ACCEPTANCE_STATE;
const binary=process.env.ACCEPTANCE_DRIVER;
if(!state||!binary)throw new Error('Set ROOMS_ACCEPTANCE_STATE and ACCEPTANCE_DRIVER');
const directory=resolve(state);
await mkdir(directory,{recursive:true,mode:0o700});
const run=(...args:string[])=>execFileSync(binary,args,{encoding:'utf8'}).trim();
const applications:Array<Awaited<ReturnType<typeof build>>>=[];
const configs:Config[]=[];
const records:Array<Record<string,unknown>>=[];
try {
 for(const school of ['school-a','school-b']){
  const path=join(directory,school);await mkdir(path,{mode:0o700});
  const identities:Record<string,string>={};
  for(const role of ['root','issuer','host','player'])identities[role]=run('keygen','--out',join(path,role+'.key'));
  const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
  await writeFile(join(path,'textures.pem'),rsa.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  let verification='';
  const config:Config={listen:'127.0.0.1',port:0,origin:'http://127.0.0.1',database:join(path,'accounts.sqlite'),textures:join(path,'textures'),signingKey:join(path,'textures.pem'),schools:{[school]:{emailDomains:[school+'.test']}},peers:[],smtp:{host:'unused',port:465,from:'fixture@invalid.test'}};
  const app=await build(config,{mail:async(_email,code)=>{verification=code;}});
  applications.push(app);configs.push(config);
  config.origin=await app.listen({host:'127.0.0.1',port:0});
  const name=school==='school-a'?'MemberA':'MemberB';
  const account={email:name.toLowerCase()+'@'+school+'.test',school,name,password:'disposable-room-acceptance-password'};
  const post=async(url:string,payload:unknown)=>{
   const response=await fetch(config.origin+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
   if(!response.ok)throw new Error(`Fixture ${url}: ${response.status}`);
   return response.status===204?null:await response.json();
  };
  await post('/api/email/start',account);
  await post('/api/email/confirm',{email:account.email,code:verification});
  const login=await post('/authserver/authenticate',{username:account.email,password:account.password,requestUser:true});
  await writeFile(join(path,'login.json'),JSON.stringify(login),{mode:0o600});
  records.push({school,path,origin:config.origin,identities,profile:login.selectedProfile,texturePublicKey:rsa.publicKey.export({type:'spki',format:'pem'}).toString()});
 }
 for(let index=0;index<configs.length;index++)configs[index].peers=records.filter((_,other)=>other!==index).map(record=>({origin:String(record.origin),publicKey:String(record.texturePublicKey)}));
 await writeFile(join(directory,'schools.json'),JSON.stringify(records,null,2),{mode:0o600});
 console.log('Two isolated schools verified accounts; chairs will bind their devices in the identity log.');
 await new Promise<void>(resolve=>{process.once('SIGTERM',()=>resolve());process.once('SIGINT',()=>resolve());});
} finally {await Promise.all(applications.map(app=>app.close()));}
