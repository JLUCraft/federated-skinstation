import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store, Rejected, type Account} from '../server/store.js';

test('registration name conflicts are explicit and leave the existing account unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skin-registration-'));
  const db = new Store(join(dir, 'accounts.sqlite'));
  try {
    const first: Account = {id:'first', name:'Member', email:'one@school.test', school:'school', password:'hash', verified_at:0};
    const second: Account = {...first, id:'second', email:'two@school.test'};
    db.confirm(first.email, db.challenge(first, 100), 100);
    const code = db.challenge(second, 100);
    assert.throws(() => db.confirm(second.email, code, 101), error => error instanceof Rejected && error.statusCode === 409);
    assert.equal(db.account('name', first.name)?.id, first.id);
    assert.equal(db.account('email', second.email), undefined);
  } finally { db.close(); await rm(dir, {recursive:true, force:true}); }
});

test('a taken game name is reported when registration starts, before any email is sent', async () => {
  const { site } = await import('./helpers/site.js');
  const s = await site();
  try {
    await s.enroll('Taken');
    const start = await s.post('/api/email/start', { email: 'other@school.test', name: 'taken', school: 'jlu', password: 'password-for-contract-testing' });
    assert.equal(start.statusCode, 409);
    assert.equal(start.json().error, 'Name Conflict');
    const free = await s.post('/api/email/start', { email: 'other@school.test', name: 'Free', school: 'jlu', password: 'password-for-contract-testing' });
    assert.equal(free.statusCode, 202);
  } finally { await s.close(); }
});
