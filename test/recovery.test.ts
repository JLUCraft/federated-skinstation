import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store,encodePassword,verifyPassword} from '../server/store.js';
test('password recovery is single use, scoped, expiring and revokes game sessions',async()=>{
 const db=new Store(':memory:');
 try {
  const password=await encodePassword('old-password-for-testing');
  const next=await encodePassword('new-password-for-testing');
  const a={id:'a',email:'a@school.test',name:'A',school:'school',password,verified_at:0};
  db.confirm(a.email,db.challenge(a,100),100);
  const b={...a,id:'b',email:'b@school.test',name:'B'};
  db.confirm(b.email,db.challenge(b,100),100);
  const token=db.mint('a','client',100);db.join(token,'a','game',100);
  const other=db.mint('b','client',100);
  const first=db.passwordReset(a.email,101)!;
  const code=db.passwordReset(a.email,102)!;
  assert.throws(()=>db.resetPassword(a.email,first,next,103));
  assert.throws(()=>db.resetPassword(b.email,code,next,103));
  assert.throws(()=>db.resetPassword(a.email,code,next,1002));
  assert.ok(db.token(token,undefined,103));
  db.resetPassword(a.email,code,next,103);
  assert.throws(()=>db.resetPassword(a.email,code,next,103));
  assert.throws(()=>db.token(token,undefined,103));
  assert.equal(db.joined('A','game',103),undefined);
  assert.equal(db.token(other,undefined,103).id,'b');
  assert.equal(await verifyPassword('new-password-for-testing',db.account('id','a')!.password),true);
  assert.equal(await verifyPassword('old-password-for-testing',db.account('id','a')!.password),false);
  assert.equal(db.passwordReset('unknown@school.test',104),undefined);
 } finally {db.close();}
});
