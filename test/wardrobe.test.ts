import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Store } from '../server/store.js';
import { registerWardrobe } from '../server/wardrobe.js';

test('wardrobe publication, collection, ownership and applying survive source removal', async () => {
  const db = new Store(':memory:'),
    app = Fastify(),
    now = Math.floor(Date.now() / 1000);
  for (const id of ['alice', 'bob']) {
    const a = {
      id,
      name: id,
      email: `${id}@school.test`,
      school: 'jlu',
      password: 'unused',
      verified_at: now,
    };
    db.confirm(a.email, db.challenge(a, now), now);
  }
  db.db
    .prepare('INSERT INTO profile_textures VALUES(?,?,?,?)')
    .run('alice', 'skin', 'a'.repeat(64), 'slim');
  registerWardrobe(app, db);
  db.db
    .prepare('INSERT INTO wardrobe VALUES(?,?,?,?,?,?,?)')
    .run('item', 'alice', '', 'skin', 'a'.repeat(64), 'slim', 0);
  const headers = (user: string) => ({
    authorization: `Bearer ${db.mint(user, 'test', now)}`,
  });
  const alice = headers('alice'),
    bob = headers('bob');
  try {
    const items = (
      await app.inject({ url: '/api/wardrobe', headers: alice })
    ).json().items;
    assert.equal(items.length, 1);
    assert.equal(items[0].applied, 1);
    const id = items[0].id;
    assert.equal(
      (await app.inject({ url: '/api/library' })).json().items.length,
      0,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/library/${id}/save`,
          headers: bob,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/wardrobe/${id}`,
          headers: bob,
          payload: { title: 'stolen', published: true },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/wardrobe/${id}`,
          headers: alice,
          payload: { title: 'Campus skin', published: true },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: '/api/library' })).json().items[0].title,
      'Campus skin',
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/library/${id}/save`,
          headers: bob,
        })
      ).statusCode,
      200,
    );
    const copy = (
      await app.inject({ url: '/api/wardrobe', headers: bob })
    ).json().items[0];
    assert.equal(copy.published, 0);
    assert.equal(copy.applied, 0);
    await app.inject({
      method: 'DELETE',
      url: `/api/wardrobe/${id}`,
      headers: alice,
    });
    assert.equal(
      (await app.inject({ url: '/api/library' })).json().items.length,
      0,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/wardrobe/${copy.id}/apply`,
          headers: bob,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        db.db
          .prepare('SELECT model FROM profile_textures WHERE account=?')
          .get('bob') as { model: string }
      ).model,
      'slim',
    );
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/wardrobe/${copy.id}`,
          headers: alice,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url: '/api/library?offset=-1' })).statusCode,
      403,
    );
  } finally {
    await app.close();
    db.close();
  }
});

test('library search, tags, likes and sorting are enforced by the server', async () => {
  const db = new Store(':memory:'),
    app = Fastify(),
    now = Math.floor(Date.now() / 1000);
  for (const id of ['alice', 'bob']) {
    const a = {
      id,
      name: id,
      email: `${id}@school.test`,
      school: 'jlu',
      password: 'unused',
      verified_at: now,
    };
    db.confirm(a.email, db.challenge(a, now), now);
  }
  registerWardrobe(app, db);
  const insert = db.db.prepare(
    'INSERT INTO wardrobe VALUES(?,?,?,?,?,?,?)',
  );
  insert.run('one', 'alice', 'Campus 100% skin', 'skin', 'a'.repeat(64), 'default', 1);
  insert.run('two', 'alice', 'Winter cape', 'cape', 'b'.repeat(64), 'default', 1);
  insert.run('draft', 'alice', 'Private', 'skin', 'c'.repeat(64), 'default', 0);
  const alice = { authorization: `Bearer ${db.mint('alice', 't', now)}` },
    bob = { authorization: `Bearer ${db.mint('bob', 't', now)}` };
  const get = async (url: string, headers?: Record<string, string>) =>
    (await app.inject({ url, headers })).json();
  try {
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/wardrobe/one',
          headers: alice,
          payload: { title: 'Campus 100% skin', published: true, tags: ['jlu', '冬季', 'jlu'] },
        })
      ).statusCode,
      200,
    );
    for (const tags of [['has space'], ['a,b'], ['x'.repeat(17)], ['1', '2', '3', '4', '5', '6']])
      assert.equal(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/wardrobe/two',
            headers: alice,
            payload: { title: 'Winter cape', published: true, tags },
          })
        ).statusCode,
        403,
      );
    assert.deepEqual((await get('/api/library')).items.map((i: { id: string }) => i.id), ['two', 'one']);
    assert.deepEqual((await get('/api/library?kind=cape')).items.map((i: { id: string }) => i.id), ['two']);
    assert.deepEqual((await get('/api/library?q=WINTER')).items.map((i: { id: string }) => i.id), ['two']);
    assert.deepEqual((await get('/api/library?q=%25')).items.map((i: { id: string }) => i.id), ['one']);
    assert.deepEqual((await get('/api/library?tag=JLU')).items.map((i: { id: string }) => i.id), ['one']);
    assert.deepEqual((await get('/api/library/tags')).tags, [
      { tag: 'jlu', count: 1 },
      { tag: '冬季', count: 1 },
    ]);
    assert.equal((await app.inject({ url: '/api/library?sort=oldest' })).statusCode, 403);

    const like = (id: string, liked: boolean, headers = bob) =>
      app.inject({ method: 'POST', url: `/api/library/${id}/like`, headers, payload: { liked } });
    assert.deepEqual((await like('one', true)).json(), { liked: true, likes: 1 });
    assert.deepEqual((await like('one', true)).json(), { liked: true, likes: 1 });
    assert.equal((await like('draft', true)).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/library/one/like', payload: { liked: true } })).statusCode, 403);
    const sorted = (await get('/api/library?sort=likes', bob)).items;
    assert.deepEqual(sorted.map((i: { id: string }) => i.id), ['one', 'two']);
    assert.equal(sorted[0].liked, true);
    assert.equal((await get('/api/library')).items[1].liked, false);
    // The uploader already owns both entries; a second account owns neither.
    assert.deepEqual((await get('/api/library', alice)).items.map((i: { owned: boolean }) => i.owned), [true, true]);
    assert.deepEqual((await get('/api/library', bob)).items.map((i: { owned: boolean }) => i.owned), [false, false]);
    assert.equal((await get('/api/library')).items[0].owned, false);
    assert.deepEqual((await like('one', false)).json(), { liked: false, likes: 0 });
    assert.equal((await get('/api/wardrobe', alice)).items.find((i: { id: string }) => i.id === 'one').tags.length, 2);
  } finally {
    await app.close();
    db.close();
  }
});
