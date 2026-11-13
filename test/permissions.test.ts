import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store, digest, now, type Account } from '../server/store.js';
import { LocalIdentity } from '../server/permissions.js';
import { parseScope, createAuthorizer, type Scope } from '../shared/permissions.js';
import { site } from './helpers/site.js';

const schools = { a: { emailDomains: ['a.test'] }, b: { emailDomains: ['b.test'] } };
function fixture(t: { after(fn: () => void): void }) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const identity = new LocalIdentity(store);
  identity.configureSchools(schools);
  const account = (id: string, school = 'a') => {
    const a: Account = {
      id,
      name: id,
      email: `${id}@${school}.test`,
      school,
      password: 'unused',
      verified_at: 0,
    };
    store.confirm(a.email, store.challenge(a, now()), now(), (id) =>
      identity.enrollVerifiedEmail(id, schools),
    );
    return store.account('id', id)!;
  };
  const grant = (account: string, scope: string, permission: string, kind = 'user') => {
    const id = randomUUID();
    store.db
      .prepare('INSERT INTO grants VALUES(?,?,?,?,?,?,?,NULL,NULL)')
      .run(id, kind, account, scope, permission, 'root', now());
    return id;
  };
  const member = (account: string, club: string, roles: string[] = []) =>
    store.db
      .prepare("INSERT INTO memberships VALUES(?,?,'active','import',?,?,NULL)")
      .run(account, club, JSON.stringify(roles), now());
  const service = (id: string, club = 'a') =>
    store.db
      .prepare('INSERT INTO services VALUES(?,?,?,?,?,?)')
      .run(id, club, id, 'test-key', 'root', now());
  account('root');
  identity.seedAdmins(['root'], []);
  return { store, identity, account, grant, member, service };
}

await test('global admin, disabled accounts and global-only permissions precede scoped authority', (t) => {
  const { store, identity, account, grant } = fixture(t);
  account('alice');
  assert.equal(identity.authorize('root', 'club:b', 'chairs.manage'), true);
  assert.equal(identity.authorize('missing', 'global', 'admin'), false);
  grant('missing', 'global', 'admin');
  assert.equal(identity.authorize('missing', 'global', 'admin'), false);
  grant('alice', 'club:a', 'manage');
  assert.equal(identity.authorize('alice', 'club:a', 'accounts.disable'), false);
  grant('alice', 'global', 'manage');
  assert.equal(identity.authorize('alice', 'global', 'accounts.disable'), false);
  grant('alice', 'global', 'accounts.disable');
  assert.equal(identity.authorize('alice', 'club:b', 'accounts.disable'), true);
  store.db.prepare('UPDATE accounts SET disabled=1 WHERE id=?').run('root');
  assert.equal(identity.authorize('root', 'global', 'admin'), false);
  assert.equal(identity.authorize('root', 'club:a', 'read'), false);
});

await test('active membership gates service and parent grants; roles and manage inherit within their club', (t) => {
  const { store, identity, account, grant, member, service } = fixture(t);
  account('alice');
  service('a-service');
  service('b-service', 'b');
  grant('alice', 'club:b', 'manage');
  grant('alice', 'service:b-service', 'read');
  assert.equal(identity.authorize('alice', 'club:b', 'read'), false);
  assert.equal(identity.authorize('alice', 'service:b-service', 'read'), false);
  grant('alice', 'club:a', 'manage');
  assert.equal(identity.authorize('alice', 'service:a-service', 'services.manage'), true);
  assert.equal(identity.authorize('alice', 'service:a-service', 'read'), true);
  assert.equal(identity.authorize('alice', 'service:unknown', 'read'), false);
  grant('alice', 'global', 'write');
  assert.equal(identity.authorize('alice', 'service:a-service', 'write'), true);
  member('alice', 'b', ['member']);
  assert.equal(identity.authorize('alice', 'service:b-service', 'read'), true);
  store.db.prepare("UPDATE grants SET revoked_at=? WHERE principal='alice'").run(now());
  assert.equal(identity.authorize('alice', 'club:a', 'write'), false);
  assert.equal(identity.authorize('alice', 'club:b', 'read'), true);
  store.db
    .prepare("UPDATE memberships SET roles=? WHERE account='alice' AND club='a'")
    .run(JSON.stringify(['write', 'toString', 'president']));
  assert.equal(identity.authorize('alice', 'club:a', 'write'), true);
  assert.equal(identity.authorize('alice', 'club:a', 'chairs.manage'), false);
  grant('alice', 'club:a', 'admin', 'service');
  assert.equal(identity.authorize('alice', 'club:a', 'chairs.manage'), false);
});

await test('chair authority transfers by club appointment and nominee acceptance without outside votes', (t) => {
  const { store, identity, account } = fixture(t);
  account('alice');
  account('bob');
  account('outsider', 'b');
  const first = identity.proposeSuccession('root', 'a', 'alice');
  identity.acceptSuccession('alice', first);
  assert.equal(identity.authorize('alice', 'club:a', 'president'), true);
  assert.equal(identity.authorize('alice', 'club:a', 'members.manage'), true);
  assert.equal(identity.authorize('alice', 'club:b', 'president'), false);
  assert.throws(() => identity.proposeSuccession('outsider', 'a', 'bob'));
  assert.throws(() => identity.proposeSuccession('alice', 'a', 'outsider'));
  const next = identity.proposeSuccession('alice', 'a', 'bob');
  const competing = identity.proposeSuccession('alice', 'a', 'alice');
  assert.throws(() => identity.acceptSuccession('outsider', next));
  identity.acceptSuccession('bob', next);
  assert.equal(identity.authorize('alice', 'club:a', 'president'), false);
  assert.equal(identity.authorize('bob', 'club:a', 'president'), true);
  assert.equal(store.db.prepare("SELECT epoch FROM chairs WHERE club='a'").get()!.epoch, 2);
  assert.equal(
    store.db.prepare('SELECT status FROM successions WHERE id=?').get(competing)!.status,
    'rejected',
  );
  assert.throws(() => identity.acceptSuccession('alice', competing));
  assert.throws(() => identity.acceptSuccession('bob', next));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM succession_votes').get()!.n, 2);
  const abandoned = identity.proposeSuccession('bob', 'a', 'alice');
  identity.revokeMembership('root', 'bob', 'a');
  assert.throws(() => identity.acceptSuccession('alice', abandoned));
  assert.equal(identity.authorize('bob', 'club:a', 'president'), false);
});

await test('revocation keeps other-club tokens and grants, then removes all token families at the last club', async () => {
  const s = await site();
  const store = new Store(join(s.dir, 'db'));
  const identity = new LocalIdentity(store);
  try {
    const login = await s.enroll('Alice');
    const id = login.user.id as string;
    const root: Account = {
      id: 'root',
      name: 'Root',
      email: 'root@school.test',
      school: 'jlu',
      password: 'unused',
      verified_at: 0,
    };
    store.confirm(root.email, store.challenge(root, now()), now(), (account) =>
      identity.enrollVerifiedEmail(account, s.config.schools),
    );
    store.db.prepare("INSERT INTO clubs VALUES('other','Other','school','other')").run();
    store.db
      .prepare("INSERT INTO memberships VALUES(?,'other','active','import','[]',?,NULL)")
      .run(id, now());
    for (const [grantId, scope] of [
      ['club', 'club:jlu'],
      ['service', 'service:owned'],
      ['other', 'club:other'],
    ])
      store.db
        .prepare("INSERT INTO grants VALUES(?,'user',?,?,'read','test',?,NULL,NULL)")
        .run(grantId, id, scope, now());
    store.db.prepare("INSERT INTO services VALUES('owned','jlu','owned','key',?,?)").run(id, now());
    store.db
      .prepare("INSERT INTO grants VALUES('root','user',?,'global','admin','test',?,NULL,NULL)")
      .run(root.id, now());
    store.db
      .prepare(
        "INSERT INTO oauth_refresh(hash,account,profile,client,scope,expires) VALUES('refresh',?,?, 'client','scope',?)",
      )
      .run(id, id, now() + 100);
    store.db
      .prepare("INSERT INTO oauth_devices VALUES('device','CODE','client','scope',?,?,NULL,0,0)")
      .run(now() + 100, id);
    store.join(login.accessToken, id, 'server', now());
    identity.revokeMembership(root.id, id, 'jlu');
    assert.equal(store.token(login.accessToken, undefined, now()).id, id);
    assert.notEqual(
      store.db.prepare("SELECT revoked_at FROM grants WHERE id='club'").get()!.revoked_at,
      null,
    );
    assert.notEqual(
      store.db.prepare("SELECT revoked_at FROM grants WHERE id='service'").get()!.revoked_at,
      null,
    );
    assert.equal(
      store.db.prepare("SELECT revoked_at FROM grants WHERE id='other'").get()!.revoked_at,
      null,
    );
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM oauth_refresh').get()!.n, 1);
    identity.revokeMembership(root.id, id, 'other');
    assert.throws(() => store.token(login.accessToken, undefined, now()));
    for (const table of ['tokens', 'joins', 'oauth_refresh', 'oauth_devices'])
      assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
  } finally {
    store.close();
    await s.close();
  }
});

await test('email confirmation enrolls atomically and never restores a revoked membership', (t) => {
  const { store, identity, account } = fixture(t);
  const alice = account('alice');
  const row = () =>
    store.db.prepare("SELECT * FROM memberships WHERE account='alice' AND club='a'").get()!;
  assert.equal(row().source, 'email_domain');
  identity.revokeMembership('root', 'alice', 'a');
  const revokedAt = row().revoked_at;
  store.confirm(alice.email, store.challenge(alice, now()), now(), (id) =>
    identity.enrollVerifiedEmail(id, schools),
  );
  assert.equal(row().status, 'revoked');
  assert.equal(row().revoked_at, revokedAt);
  assert.equal(identity.authorize('alice', 'club:a', 'read'), false);
  assert.throws(() =>
    store.db
      .prepare("UPDATE memberships SET status='active',revoked_at=NULL WHERE account='alice'")
      .run(),
  );
  assert.throws(() =>
    store.db
      .prepare(
        "INSERT OR REPLACE INTO memberships VALUES('alice','a','active','email_domain','[]',1,NULL)",
      )
      .run(),
  );
  const bad: Account = { ...alice, id: 'bad', name: 'bad', email: 'bad@wrong.test' };
  const code = store.challenge(bad, now());
  assert.throws(() =>
    store.confirm(bad.email, code, now(), (id) => identity.enrollVerifiedEmail(id, schools)),
  );
  assert.equal(store.account('id', 'bad'), undefined);
  assert.ok(store.db.prepare('SELECT 1 FROM challenges WHERE email=?').get(bad.email));
});

await test('admin configuration seeds once, scopes MUA authority, and never revives revoked grants', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const identity = new LocalIdentity(store);
  identity.seedAdmins([], []);
  assert.equal(store.db.prepare('SELECT count(*) AS total FROM identity_seeds').get()!.total, 0);
  identity.seedAdmins([], ['mua']);
  identity.seedAdmins(['site', 'site'], ['mua']);
  assert.equal(identity.authorize('site', 'global', 'admin'), false);
  for (const id of ['site', 'mua'])
    store.db
      .prepare(
        "INSERT INTO accounts(id,name,email,school,password,verified_at) VALUES(?,?,?,'a','unused',1)",
      )
      .run(id, id, `${id}@a.test`);
  assert.equal(identity.authorize('site', 'global', 'admin'), true);
  assert.equal(identity.authorize('mua', 'service:mua', 'admin'), true);
  assert.equal(identity.authorize('mua', 'global', 'admin'), false);
  store.db.prepare("UPDATE grants SET revoked_at=1 WHERE principal='site'").run();
  new LocalIdentity(store).seedAdmins(['site', 'new'], ['mua']);
  assert.equal(identity.authorize('site', 'global', 'admin'), false);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM grants').get()!.n, 2);
});

await test('each authorization appends one linked audit entry and existing entries cannot be replaced', (t) => {
  const { store, identity } = fixture(t);
  const before = Number(store.db.prepare('SELECT count(*) AS n FROM audit').get()!.n);
  for (const [scope, permission] of [
    ['global', 'admin'],
    ['club:', 'read'],
    ['global', 'unknown'],
  ])
    identity.authorize('root', scope, permission);
  identity.authorize('missing', 'global', 'read');
  const rows = store.db.prepare('SELECT * FROM audit ORDER BY seq').all();
  assert.equal(rows.length, before + 4);
  let previous = '';
  for (const row of rows) {
    assert.equal(row.prev_hash, previous);
    assert.equal(
      row.hash,
      digest(
        JSON.stringify([
          row.seq,
          row.at,
          row.actor_kind,
          row.actor,
          row.scope,
          row.action,
          row.target,
          row.payload_digest,
          row.prev_hash,
          row.actor_client === null ? null : { client: row.actor_client, request: row.request_id },
        ]),
      ),
    );
    previous = String(row.hash);
  }
  assert.throws(() => store.db.exec("UPDATE audit SET actor='tampered'"));
  assert.throws(() => store.db.exec('DELETE FROM audit'));
  assert.throws(() =>
    store.db.exec('INSERT OR REPLACE INTO audit SELECT * FROM audit WHERE seq=1'),
  );
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit').get()!.n, rows.length);
});

await test('scope parsing and recursive ownership stop at missing owners or cycles', () => {
  for (const scope of ['global', 'club:a', 'service:a', 'league:a', 'event:a', 'workflow:a'])
    assert.ok(parseScope(scope));
  for (const scope of ['', 'club:', 'global:a', 'club:a:b', 'club:a b', 'unknown:a'])
    assert.equal(parseScope(scope), undefined);
  const parents: Record<string, Scope | null> = {
    'event:e': 'league:l',
    'league:l': 'club:a',
    'club:a': 'global',
    global: null,
  };
  let audits = 0;
  const authorize = createAuthorizer({
    enabled: () => true,
    parent: (scope) => parents[scope],
    membership: () => ({ active: true, roles: [] }),
    chair: () => false,
    grants: (_account, scope) => (scope === 'club:a' ? ['manage'] : []),
    audit: () => {
      audits++;
    },
  });
  assert.equal(authorize('alice', 'event:e', 'write'), true);
  assert.equal(authorize('alice', 'workflow:unknown', 'read'), false);
  parents['league:l'] = 'event:e';
  assert.equal(authorize('alice', 'event:e', 'read'), false);
  assert.equal(audits, 3);
});
