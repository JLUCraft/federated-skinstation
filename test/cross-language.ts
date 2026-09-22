// Invoke after building union-core/tools/unionctl. Tests the actual Rust/TS wire format.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { issueStudent } from '../server/federation.js';
const binary=resolve(process.env.UNIONCTL??'../target/debug/unionctl');
const dir=await mkdtemp(join(tmpdir(),'union-interop-'));
const run=(...args:string[])=>execFileSync(binary,args,{encoding:'utf8'}).trim();
try {
 const root=run('keygen','--out',join(dir,'root.key'));
 const issuer=run('keygen','--out',join(dir,'issuer.key'));
 const holder=run('keygen','--out',join(dir,'holder.key'));
 const now=Math.floor(Date.now()/1000);
 const delegation=join(dir,'delegation.json');
 await writeFile(join(dir,'claims.json'),JSON.stringify({id:'interop-delegation',school:'jlu',issuer,not_before:now-60,expires_at:now+3600,max_credential_seconds:3600,evidence:['institutional_email']}));
 run('delegate-students','--key',join(dir,'root.key'),'--claims',join(dir,'claims.json'),'--out',delegation);
 const proof=await issueStudent({id:'0123456789abcdef0123456789abcdef',name:'Student',email:'example@mails.jlu.edu.cn',school:'jlu',password:'unused',verified_at:now},holder,{emailDomains:['mails.jlu.edu.cn'],issuerKey:join(dir,'issuer.key'),delegation,roots:[root]},now);
 const credential=join(dir,'credential.json'),policy=join(dir,'policy.json');
 await writeFile(credential,JSON.stringify(proof));
 await writeFile(policy,JSON.stringify({local_school:'jlu',province_schools:[],mua_schools:[],school_roots:{jlu:[root]},revoked:[],max_verification_age_seconds:86400}));
 const args=['verify-student','--policy',policy,'--credential',credential,'--holder',holder,'--profile','0123456789abcdef0123456789abcdef'];
 assert.equal(JSON.parse(run(...args))[0],'local');
 proof.student.payload[0]^=1;await writeFile(credential,JSON.stringify(proof));
 assert.notEqual(spawnSync(binary,args,{stdio:'ignore'}).status,0);
 console.log('Rust school delegation → TS issuance → Rust verification: passed; altered payload rejected.');
} finally {await rm(dir,{recursive:true,force:true});}
