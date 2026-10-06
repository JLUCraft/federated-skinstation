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

