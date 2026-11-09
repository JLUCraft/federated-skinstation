import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';

test('migrations initialize once and preserve existing data on reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skin-schema-'));
  try {
    const path = join(dir, 'store.sqlite');
    let store = new Store(path);
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 1);
    store.db.prepare('INSERT INTO attempts VALUES(?,?,?)').run('preserved', 10, 2);
    store.close();
    store = new Store(path);
    assert.equal(store.db.prepare('SELECT count FROM attempts WHERE key=?').get('preserved')!.count, 2);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
