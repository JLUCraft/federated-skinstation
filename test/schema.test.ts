import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, migrations } from '../server/store.js';
import { LocalIdentity } from '../server/permissions.js';

test('migrations initialize once and preserve existing data on reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skin-schema-'));
  try {
    const path = join(dir, 'store.sqlite');
    let store = new Store(path);
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 7);
    store.db.prepare('INSERT INTO attempts VALUES(?,?,?)').run('preserved', 10, 2);
    store.close();
    store = new Store(path);
    assert.equal(
      store.db.prepare('SELECT count FROM attempts WHERE key=?').get('preserved')!.count,
      2,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schema one migration retains accounts, profile data, sessions and legacy member identifiers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skin-migrate-'));
  try {
    const path = join(dir, 'store.sqlite');
    const old = new DatabaseSync(path);
    migrations[0].apply(old);
    old.exec(`
      INSERT INTO accounts VALUES('alice','Alice','alice@a.test','a','password',10);
      INSERT INTO identity_members VALUES('alice','legacy-alice',1);
      INSERT INTO tokens VALUES('token','client','alice',1000);
      INSERT INTO joins VALUES('server','alice','token',1000,NULL);
      INSERT INTO profile_textures VALUES('alice','skin','texture','default');
      PRAGMA user_version=1;
    `);
    old.close();
    for (let open = 0; open < 2; open++) {
      const store = new Store(path);
      try {
        assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 7);
        assert.equal(store.account('id', 'alice')!.disabled, 0);
        assert.equal(store.account('id', 'alice')!.verified_at, 10);
        assert.equal(
          store.db.prepare('SELECT legacy_member FROM identity_members').get()!.legacy_member,
          'legacy-alice',
        );
        assert.equal(store.db.prepare('SELECT hash FROM profile_textures').get()!.hash, 'texture');
        assert.equal(store.db.prepare('SELECT token FROM joins').get()!.token, 'token');
        assert.equal(store.db.prepare('SELECT account FROM tokens').get()!.account, 'alice');
      } finally {
        store.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('splitting configuration seed markers retains completed imports including revoked grants', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skin-admin-seeds-'));
  try {
    const path = join(dir, 'store.sqlite');
    const previous = new DatabaseSync(path);
    migrations[0].apply(previous);
    migrations[1].apply(previous);
    previous.exec(`
      INSERT INTO identity_seeds VALUES('admins');
      INSERT INTO grants VALUES('site','user','site','global','admin','config',1,2,'root');
      INSERT INTO grants VALUES('mua','user','mua','service:mua','admin','config',1,NULL,NULL);
      PRAGMA user_version=2;
    `);
    previous.close();
    const store = new Store(path);
    try {
      new LocalIdentity(store).seedAdmins(['site', 'another'], ['mua', 'other']);
      assert.equal(store.db.prepare('SELECT count(*) AS total FROM grants').get()!.total, 2);
      assert.equal(
        store.db.prepare("SELECT revoked_at FROM grants WHERE id='site'").get()!.revoked_at,
        2,
      );
      assert.deepEqual(
        store.db
          .prepare('SELECT name FROM identity_seeds ORDER BY name')
          .all()
          .map((row) => row.name),
        ['mua_admins', 'site_admins'],
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
