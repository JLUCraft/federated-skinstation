import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store, encodePassword, now, type Account } from '../server/store.js';
import { site } from './helpers/site.js';

function bootstrap(store: Store, account: string) {
  store.db.prepare("INSERT INTO grants VALUES('test-admin','user',?,'global','admin','fixture',?,NULL,NULL)")
    .run(account, now());
}

test('central identity manages scoped grants and chair succession without escalating authority', async () => {
  const service = await site();
  const store = new Store(join(service.dir, 'db'));
  try {
    const root = await service.enroll('Admin');
    const alice = await service.enroll('Alice');
    const bob = await service.enroll('Bob');
    const request = (login: typeof root, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
      service.app.inject({ method, url, payload, headers: { authorization: `Bearer ${login.accessToken}` } });
    const grant = (login: typeof root, account: string, scope: string, permission: string) =>
      request(login, 'POST', '/api/identity/grants', { account, scope, permission });
    service.config.siteAdmins = [root.user.id];
    assert.equal((await request(root, 'GET', '/api/me')).json().siteAdmin, false);
    bootstrap(store, root.user.id);
    assert.equal((await request(root, 'GET', '/api/me')).json().siteAdmin, true);
    const initial = (await request(alice, 'GET', '/api/identity')).json();
    assert.equal(initial.account, alice.user.id);
    assert.equal(initial.memberships[0].club, 'jlu');
    assert.equal(initial.memberships[0].chair, false);
    assert.equal((await grant(root, alice.user.id, 'global', 'manage')).statusCode, 200);
    assert.equal((await grant(alice, alice.user.id, 'global', 'admin')).statusCode, 403);
    assert.equal((await grant(alice, alice.user.id, 'global', 'accounts.disable')).statusCode, 403);
    assert.equal((await request(alice, 'DELETE', '/api/identity/grants/test-admin')).statusCode, 403);
    assert.equal((await request(root, 'DELETE', '/api/identity/grants/test-admin')).statusCode, 403);
    assert.equal((await request(root, 'POST', `/api/admin/accounts/${root.user.id}/disable`)).statusCode, 403);
    assert.equal((await request(alice, 'POST', '/api/clubs/jlu/successions', { nominee: alice.user.id })).statusCode, 403);
    assert.equal((await grant(root, alice.user.id, 'club:jlu', 'president')).statusCode, 403);
    assert.equal((await grant(alice, bob.user.id, 'club:jlu', 'read')).statusCode, 200);
    const delegated = await grant(root, bob.user.id, 'service:mua', 'admin');
    assert.equal(delegated.statusCode, 200, delegated.body);
    assert.equal((await request(bob, 'GET', '/api/me')).json().muaAdmin, true);
    assert.equal((await request(bob, 'GET', '/api/me')).json().siteAdmin, false);
    assert.equal((await request(root, 'DELETE', '/api/identity/grants/' + delegated.json().id)).statusCode, 204);
    assert.equal((await request(bob, 'GET', '/api/me')).json().muaAdmin, false);
    const first = await request(root, 'POST', '/api/clubs/jlu/successions', { nominee: bob.user.id });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal((await request(alice, 'POST', '/api/identity/successions/' + first.json().id + '/accept')).statusCode, 403);
    assert.equal((await request(bob, 'POST', '/api/identity/successions/' + first.json().id + '/accept')).statusCode, 204);
    const next = await request(bob, 'POST', '/api/clubs/jlu/successions', { nominee: alice.user.id });
    assert.equal(next.statusCode, 200, next.body);
    const nominations = (await request(alice, 'GET', '/api/identity')).json().successions;
    assert.equal(nominations[0].id, next.json().id);
    assert.equal((await request(alice, 'POST', '/api/identity/successions/' + next.json().id + '/accept')).statusCode, 204);
    assert.equal((await request(alice, 'GET', '/api/identity')).json().memberships[0].chair, true);
    assert.equal((await request(bob, 'GET', '/api/clubs/jlu/members')).statusCode, 403);
    assert.equal((await request(alice, 'GET', '/api/clubs/jlu/members')).json().members.length, 3);
    assert.equal((await request(alice, 'POST', `/api/clubs/jlu/members/${root.user.id}/revoke`)).statusCode, 403);
    assert.equal((await request(root, 'GET', '/api/me')).json().siteAdmin, true);
    store.db.prepare("INSERT INTO clubs VALUES('other','Other','school','other')").run();
    assert.equal((await grant(alice, bob.user.id, 'club:other', 'read')).statusCode, 403);
    const inherited = (await request(root, 'GET', '/api/identity/grants?scope=global')).json().grants;
    const aliceGrant = inherited.find((entry: { principal: string }) => entry.principal === alice.user.id);
    assert.equal((await request(root, 'DELETE', '/api/identity/grants/' + aliceGrant.id)).statusCode, 204);
    assert.equal((await request(alice, 'GET', '/api/identity/grants?scope=global')).statusCode, 403);
    assert.ok(store.db.prepare("SELECT 1 FROM audit WHERE actor=? AND action='authorize' AND target='admin'").get(alice.user.id));
  } finally {
    store.close();
    await service.close();
  }
});

test('HTTP membership revocation and account disablement invalidate every session family', async () => {
  const service = await site();
  const store = new Store(join(service.dir, 'db'));
  try {
    const root = await service.enroll('Admin');
    const bob = await service.enroll('Bob');
    bootstrap(store, root.user.id);
    const headers = (login: typeof root) => ({ authorization: `Bearer ${login.accessToken}` });
    const revoke = (club: string) => service.app.inject({
      method: 'POST', url: `/api/clubs/${club}/members/${bob.user.id}/revoke`, headers: headers(root),
    });
    const me = (login: typeof root) => service.app.inject({ url: '/api/me', headers: headers(login) });
    store.db.prepare("INSERT INTO clubs VALUES('other','Other','school','other')").run();
    store.db.prepare("INSERT INTO memberships VALUES(?,'other','active','import','[]',?,NULL)").run(bob.user.id, now());
    store.db.prepare("INSERT INTO oauth_refresh VALUES('refresh',?,?,'client','scope',?)").run(bob.user.id, bob.user.id, now() + 100);
    store.db.prepare("INSERT INTO oauth_devices VALUES('device','CODE','client','scope',?,?,NULL,0,0)").run(now() + 100, bob.user.id);
    await service.post('/sessionserver/session/minecraft/join', {
      accessToken: bob.accessToken, selectedProfile: bob.selectedProfile.id, serverId: 'active-game',
    });
    assert.equal((await revoke('jlu')).statusCode, 204);
    assert.equal((await me(bob)).statusCode, 200);
    assert.equal((await revoke('other')).statusCode, 204);
    assert.equal((await me(bob)).statusCode, 403);
    assert.equal((await service.post('/authserver/refresh', { accessToken: bob.accessToken })).statusCode, 403);
    const credentials = { username: 'bob@school.test', password: 'password-for-contract-testing' };
    assert.equal((await service.post('/authserver/authenticate', credentials)).statusCode, 403);
    assert.equal((await service.app.inject('/sessionserver/session/minecraft/hasJoined?username=Bob&serverId=active-game')).statusCode, 204);
    assert.equal(store.db.prepare('SELECT count(*) AS total FROM oauth_refresh WHERE account=?').get(bob.user.id)!.total, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS total FROM oauth_devices WHERE account=?').get(bob.user.id)!.total, 0);
    assert.equal((await service.post('/api/email/start', {
      email: credentials.username, password: credentials.password, name: 'Bob', school: 'jlu',
    })).statusCode, 202);
    assert.equal((await service.post('/api/email/confirm', { email: credentials.username, code: service.verificationCode() })).statusCode, 204);
    assert.equal((await service.post('/authserver/authenticate', credentials)).statusCode, 403);
    const alice = await service.enroll('Alice');
    const disabled = await service.app.inject({
      method: 'POST', url: `/api/admin/accounts/${alice.user.id}/disable`, headers: headers(root),
    });
    assert.equal(disabled.statusCode, 204, disabled.body);
    assert.equal((await me(alice)).statusCode, 403);
    assert.equal((await service.post('/authserver/authenticate', {
      username: 'alice@school.test', password: credentials.password,
    })).statusCode, 403);
    assert.throws(() => store.mint(store.account('id', alice.user.id)!, 'client', now()), /Account disabled/);
  } finally {
    store.close();
    await service.close();
  }
});

test('existing accounts reverify email into local membership while retaining their legacy identifier as data', async () => {
  const service = await site();
  const store = new Store(join(service.dir, 'db'));
  try {
    const password = 'password-for-legacy-account';
    const account: Account = {
      id: 'legacy-account', name: 'Legacy', email: 'legacy@school.test', school: 'jlu',
      password: await encodePassword(password), verified_at: 0,
    };
    store.confirm(account.email, store.challenge(account, now()), now());
    store.db.prepare("INSERT INTO identity_members VALUES(?,'former-member',1)").run(account.id);
    const login = () => service.post('/authserver/authenticate', { username: account.email, password });
    assert.equal((await login()).statusCode, 403);
    const challenge = await service.post('/api/email/start', {
      email: account.email, password, school: account.school, name: account.name,
    });
    assert.equal(challenge.statusCode, 202, challenge.body);
    assert.equal((await service.post('/api/email/confirm', {
      email: account.email, code: service.verificationCode(),
    })).statusCode, 204);
    const admitted = await login();
    assert.equal(admitted.statusCode, 200, admitted.body);
    const snapshot = await service.app.inject({
      url: '/api/identity', headers: { authorization: `Bearer ${admitted.json().accessToken}` },
    });
    assert.equal(snapshot.json().account, account.id);
    assert.equal(snapshot.json().memberships[0].status, 'active');
    assert.equal(store.db.prepare('SELECT legacy_member FROM identity_members WHERE account=?').get(account.id)!.legacy_member, 'former-member');
    assert.equal((await service.post('/api/identity/proposal', {})).statusCode, 404);
    assert.equal((await service.post('/api/identity/confirm', {})).statusCode, 404);
  } finally {
    store.close();
    await service.close();
  }
});
