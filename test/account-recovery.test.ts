import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { now, Store } from '../server/store.js';
import { site } from './helpers/site.js';
import type { Login } from './helpers/site.js';
import { authority } from './helpers/identity.js';

await test('club recovery proves the new mailbox and replaces credentials without replacing the account', async () => {
  const service = await site();
  const store = new Store(join(service.dir, 'db'));
  try {
    const root = await service.enroll('Admin');
    const manager = await service.enroll('Manager');
    const member = await service.enroll('Member');
    authority(store, [root.user.id]);
    const request = (login: typeof root, url: string, payload: object) =>
      service.app.inject({
        method: 'POST',
        url,
        payload,
        headers: { authorization: `Bearer ${login.accessToken}` },
      });
    const delegated = await request(root, '/api/identity/grants', {
      account: manager.user.id,
      scope: 'club:jlu',
      permission: 'accounts.recover',
    });
    assert.equal(delegated.statusCode, 200, delegated.body);
    store.db
      .prepare('INSERT INTO passkeys VALUES(?,?,?,?,?,?)')
      .run('old-passkey', member.user.id, Buffer.from([1]), 0, 'Old device', now());
    store.db
      .prepare("INSERT INTO oauth_refresh VALUES('old-refresh',?,?,'client','scope',?)")
      .run(member.user.id, member.selectedProfile.id, now() + 100);
    store.db
      .prepare("INSERT INTO oauth_devices VALUES('device','CODE','client','scope',?,?,NULL,0,0)")
      .run(now() + 100, member.user.id);
    store.passwordReset('member@school.test', now());
    const proposed = await request(manager, '/api/clubs/jlu/recoveries', {
      account: member.user.id,
      email: 'recovered@example.test',
    });
    assert.equal(proposed.statusCode, 204, proposed.body);
    const confirmation = service.verificationCode();
    const me = () =>
      service.app.inject({
        url: '/api/me',
        headers: { authorization: `Bearer ${member.accessToken}` },
      });
    assert.equal((await me()).statusCode, 200);
    const password = 'password-after-club-recovery';
    const pendingAuthentication = store.account('id', member.user.id)!;
    assert.equal(
      (
        await service.post('/api/recovery/confirm', {
          confirmation: confirmation.split('.')[0] + '.wrong',
          password,
        })
      ).statusCode,
      403,
    );
    const completed = await service.post('/api/recovery/confirm', { confirmation, password });
    assert.equal(completed.statusCode, 204, completed.body);
    assert.throws(
      () => store.mint(pendingAuthentication, 'pending-login', now()),
      /Credentials changed/,
    );
    assert.equal((await me()).statusCode, 403);
    for (const table of ['tokens', 'oauth_refresh', 'oauth_devices', 'passkeys', 'password_resets'])
      assert.equal(
        store.db
          .prepare(`SELECT count(*) AS total FROM ${table} WHERE account=?`)
          .get(member.user.id)!.total,
        0,
      );
    assert.equal(store.account('email', 'recovered@example.test')!.id, member.user.id);
    assert.equal(
      store.db.prepare('SELECT status FROM memberships WHERE account=?').get(member.user.id)!
        .status,
      'active',
    );
    assert.equal(
      (await service.post('/api/recovery/confirm', { confirmation, password })).statusCode,
      403,
    );
    const login = await service.post('/authserver/authenticate', {
      username: 'recovered@example.test',
      password,
      requestUser: true,
    });
    assert.equal(login.statusCode, 200, login.body);
    assert.equal(login.json<Login>().user.id, member.user.id);
  } finally {
    store.close();
    await service.close();
  }
});

await test('pending recovery rechecks the home club, global authority, expiry and current delegation', async () => {
  const service = await site();
  const store = new Store(join(service.dir, 'db'));
  try {
    const root = await service.enroll('Admin');
    const manager = await service.enroll('Manager');
    const member = await service.enroll('Member');
    const identity = authority(store, [root.user.id]);
    const request = (login: typeof root, url: string, payload: object) =>
      service.app.inject({
        method: 'POST',
        url,
        payload,
        headers: { authorization: `Bearer ${login.accessToken}` },
      });
    const granted = await request(root, '/api/identity/grants', {
      account: manager.user.id,
      scope: 'club:jlu',
      permission: 'accounts.recover',
    });
    store.db.prepare("INSERT INTO clubs VALUES('other','Other','school','other')").run();
    assert.equal(
      (
        await request(root, '/api/clubs/other/recoveries', {
          account: member.user.id,
          email: 'wrong@example.test',
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await request(manager, '/api/clubs/jlu/recoveries', {
          account: root.user.id,
          email: 'root@example.test',
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await request(manager, '/api/clubs/jlu/recoveries', {
          account: member.user.id,
          email: 'member@example.test',
        })
      ).statusCode,
      204,
    );
    const pending = service.verificationCode();
    identity.revokeGrant(root.user.id, granted.json<{ id: string }>().id);
    const password = 'password-after-club-recovery';
    assert.equal(
      (await service.post('/api/recovery/confirm', { confirmation: pending, password })).statusCode,
      403,
    );
    assert.equal(store.account('email', 'member@school.test')!.id, member.user.id);
    assert.equal(
      (
        await request(root, '/api/clubs/jlu/recoveries', {
          account: member.user.id,
          email: 'expired@example.test',
        })
      ).statusCode,
      204,
    );
    const expired = service.verificationCode();
    store.db.prepare('UPDATE account_recoveries SET expires=0 WHERE account=?').run(member.user.id);
    assert.equal(
      (await service.post('/api/recovery/confirm', { confirmation: expired, password })).statusCode,
      403,
    );
    assert.equal(
      (
        await request(root, '/api/clubs/jlu/recoveries', {
          account: member.user.id,
          email: 'revoked@example.test',
        })
      ).statusCode,
      204,
    );
    const revoked = service.verificationCode();
    identity.revokeMembership(root.user.id, member.user.id, 'jlu');
    assert.equal(
      (await service.post('/api/recovery/confirm', { confirmation: revoked, password })).statusCode,
      403,
    );
    assert.equal(store.account('email', 'member@school.test')!.id, member.user.id);
  } finally {
    store.close();
    await service.close();
  }
});
