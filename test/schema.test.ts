import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, migrations } from '../server/store.js';

test('migrations initialize once and preserve existing data on reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skin-schema-'));
  try {
    const path = join(dir, 'store.sqlite');
    let store = new Store(path);
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 2);
    store.db.prepare('INSERT INTO attempts VALUES(?,?,?)').run('preserved', 10, 2);
    store.close();
    store = new Store(path);
    assert.equal(store.db.prepare('SELECT count FROM attempts WHERE key=?').get('preserved')!.count, 2);
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
        assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 2);
        assert.equal(store.account('id', 'alice')!.disabled, 0);
        assert.equal(store.account('id', 'alice')!.verified_at, 10);
        assert.equal(store.db.prepare('SELECT legacy_member FROM identity_members').get()!.legacy_member, 'legacy-alice');
        assert.equal(store.db.prepare('SELECT hash FROM profile_textures').get()!.hash, 'texture');
        assert.equal(store.db.prepare('SELECT token FROM joins').get()!.token, 'token');
        assert.equal(store.db.prepare('SELECT account FROM tokens').get()!.account, 'alice');
      } finally { store.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
