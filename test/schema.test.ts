import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../server/store.js';
test('only current database schema is accepted, with no migration',()=>{
 const dir=mkdtempSync(join(tmpdir(),'union-schema-'));
 try {
  const path=join(dir,'store.sqlite');let store=new Store(path);assert.equal((store.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,1);store.close();
  store=new Store(path);store.close();
  for(const version of [0,2]){const db=new DatabaseSync(path);db.exec(`PRAGMA user_version=${version}`);db.close();assert.throws(()=>new Store(path),/Unsupported database schema/);}
 } finally {rmSync(dir,{recursive:true,force:true});}
});
