import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {SecretState} from '../server/secret-state.js';
import {site} from './helpers/site.js';

test('MUA encrypted secrets survive restart; corruption and wrong keys fail closed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jlu-secret-state-'));
 const name='JLU_TEST_SECRET_STORAGE';process.env[name]=randomBytes(32).toString('hex');
 const cipher=SecretState.fromEnvironment(name);let db:Store|undefined;
 try{
  db=new Store(join(dir,'db'));
  db.db.exec('CREATE TABLE mua_state(name TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const privateKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
  for(const [key,value] of [['memberKey','member-secret'],['textureKey',privateKey]])db.db.prepare('INSERT INTO mua_state VALUES(?,?)').run(key,cipher.seal(key,value));
  assert.throws(()=>cipher.open('memberKey','plaintext'));
  cipher.validate(db);
  const value=(db.db.prepare("SELECT value FROM mua_state WHERE name='textureKey'").get() as {value:string}).value;
  assert.ok(value.startsWith('sealed:v1:'));assert.ok(!value.includes('PRIVATE KEY'));
  assert.equal(cipher.open('textureKey',value),privateKey);
  assert.throws(()=>cipher.open('memberKey',value));
  const damaged=Buffer.from(value.slice('sealed:v1:'.length),'base64');damaged[damaged.length-1]^=1;
  assert.throws(()=>cipher.open('textureKey','sealed:v1:'+damaged.toString('base64')));
  db.close();db=new Store(join(dir,'db'));cipher.validate(db);
  assert.equal((db.db.prepare("SELECT value FROM mua_state WHERE name='textureKey'").get() as {value:string}).value,value);
  process.env[name]=randomBytes(32).toString('hex');assert.throws(()=>SecretState.fromEnvironment(name).validate(db!));
  delete process.env[name];assert.throws(()=>SecretState.fromEnvironment(name));
 }finally{db?.close();delete process.env[name];await rm(dir,{recursive:true,force:true});}
});

test('OAuth provider refuses startup without an independently pinned backend encryption key',async()=>{
 const host=generateKeyPairSync('rsa',{modulusLength:2048});
 await assert.rejects(site({apiRoot:'https://mua.example.test/api/union',hostPublicKey:host.publicKey.export({type:'spki',format:'pem'}).toString(),member:{keyEnv:'JLU_UNUSED_KEY',oauthSigningKey:'fixture'}}));
});
