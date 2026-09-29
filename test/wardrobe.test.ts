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

test('federated library verifies pinned signatures and file digests before importing', async () => {
  const { generateKeyPairSync, createHash } = await import('node:crypto');
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = pair.publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const origin = 'https://source.test',
    bytes = Buffer.from('fixture-content'),
    hash = createHash('sha256').update(bytes).digest('hex');
  const sourceDb = new Store(':memory:'),
    targetDb = new Store(':memory:'),
    source = Fastify(),
    target = Fastify(),
    now = Math.floor(Date.now() / 1000);
  for (const db of [sourceDb, targetDb]) {
    const a = {
      id: 'member',
      name: 'Member',
      email: 'member@school.test',
      school: 'jlu',
      password: 'unused',
      verified_at: now,
    };
    db.confirm(a.email, db.challenge(a, now), now);
  }
  let saved = 0,
    corrupt = false,
    tamper = false;
  registerWardrobe(source, sourceDb, {
    origin,
    peers: [],
    key: pair.privateKey,
    save: async () => {
      throw new Error('unused');
    },
  });
  sourceDb.db
    .prepare('INSERT INTO wardrobe VALUES(?,?,?,?,?,?,?)')
    .run('texture', 'member', 'Shared skin', 'skin', hash, 'default', 1);
  const fetcher = (async (url: string | URL | Request) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, origin);
    if (parsed.pathname.startsWith('/textures/'))
      return new Response(corrupt ? Buffer.from('altered') : bytes);
    const response = await source.inject({
      url: parsed.pathname + parsed.search,
    });
    const body = response.json();
    if (tamper) body.signature = 'invalid';
    return Response.json(body, { status: response.statusCode });
  }) as typeof fetch;
  registerWardrobe(target, targetDb, {
    origin: 'https://target.test',
    peers: [{ origin, publicKey }],
    key: pair.privateKey,
    fetcher,
    save: async (_account, item, input) => {
      assert.equal(item.hash, hash);
      assert.deepEqual(input, bytes);
      saved++;
    },
  });
  const headers = {
    authorization: `Bearer ${targetDb.mint('member', 'test', now)}`,
  };
  try {
    const catalog = (await target.inject({ url: '/api/library' })).json();
    assert.equal(catalog.items[0].source, origin);
    assert.equal(catalog.unavailableSources, 0);
    assert.equal(
      (
        await target.inject({
          method: 'POST',
          url: '/api/library/texture/save',
          headers,
          payload: { source: origin },
        })
      ).statusCode,
      200,
    );
    assert.equal(saved, 1);
    corrupt = true;
    assert.equal(
      (
        await target.inject({
          method: 'POST',
          url: '/api/library/texture/save',
          headers,
          payload: { source: origin },
        })
      ).statusCode,
      403,
    );
    assert.equal(saved, 1);
    tamper = true;
    const invalid = (await target.inject({ url: '/api/library' })).json();
    assert.equal(invalid.items.length, 0);
    assert.equal(invalid.unavailableSources, 1);
    assert.equal(
      (
        await target.inject({
          method: 'POST',
          url: '/api/library/texture/save',
          headers,
          payload: { source: 'https://attacker.test' },
        })
      ).statusCode,
      403,
    );
  } finally {
    await source.close();
    await target.close();
    sourceDb.close();
    targetDb.close();
  }
});
