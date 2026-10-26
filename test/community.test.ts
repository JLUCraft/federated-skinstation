import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Store, now, digest } from '../server/store.js';
import { registerWardrobe } from '../server/wardrobe.js';
import { registerCommunity } from '../server/community.js';

test('community publication, moderation, privacy, counters and ownership form one workflow', async () => {
  const db = new Store(':memory:'),
    app = Fastify();
  for (const [id, school] of [
    ['alice', 'jlu'],
    ['bob', 'other'],
    ['admin', 'jlu'],
  ]) {
    const a = {
      id,
      school,
      name: id,
      email: `${id}@school.test`,
      password: 'unused',
      verified_at: now(),
    };
    db.confirm(a.email, db.challenge(a, now()), now());
  }
  registerWardrobe(app, db, ['admin']);
  registerCommunity(app, db, ['admin']);
  const headers = (id: string) => ({
    authorization: `Bearer ${db.mint(id, 'community', now())}`,
  });
  const alice = headers('alice'),
    bob = headers('bob'),
    admin = headers('admin');
  const post = (url: string, payload: object, auth = alice) =>
    app.inject({ method: 'POST', url, headers: auth, payload });
  const get = async (url: string, auth?: typeof alice) =>
    (await app.inject({ url, headers: auth })).json();
  const patch = (id: string, payload: object, auth = alice) =>
    app.inject({
      method: 'PATCH',
      url: `/api/wardrobe/${id}`,
      headers: auth,
      payload,
    });
  const review = (state: string) =>
    post(
      '/api/admin/reviews/skin',
      {
        state,
        reason: 'Human review',
        submission: db.db
          .prepare("SELECT submission FROM texture_reviews WHERE item='skin'")
          .get()!.submission,
      },
      admin,
    );
  db.db
    .prepare('INSERT INTO wardrobe VALUES(?,?,?,?,?,?,?)')
    .run('skin', 'alice', 'Campus', 'skin', 'a'.repeat(64), 'default', 0);
  try {
    assert.equal(
      (
        await patch('skin', {
          title: 'Campus',
          published: true,
          source: 'original',
          license: 'CC BY 4.0',
        })
      ).statusCode,
      200,
    );
    assert.equal((await get('/api/library')).items.length, 0);
    assert.equal(
      (await app.inject({ url: '/api/library/skin' })).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url: '/api/library/skin/download' })).statusCode,
      403,
    );
    assert.equal((await review('invalid')).statusCode, 403);
    assert.equal(
      (
        await post(
          '/api/admin/reviews/skin',
          { state: 'approved', reason: 'Denied' },
          bob,
        )
      ).statusCode,
      403,
    );
    assert.equal((await review('approved')).statusCode, 200);
    const detail = await get('/api/library/skin');
    assert.equal(detail.source, 'original');
    assert.equal(detail.authorName, 'alice');
    assert.equal(detail.reviewReason, undefined);
    assert.equal((await get('/api/library')).items[0].reviewReason, undefined);
    assert.equal(
      (await get('/api/wardrobe', alice)).items[0].reviewReason,
      'Human review',
    );
    const user = await get('/api/users/alice');
    assert.equal(user.email, undefined);
    assert.equal(user.profiles, undefined);
    assert.equal(user.items.length, 1);
    assert.equal(user.items[0].reviewReason, undefined);
    assert.equal(
      (await get('/api/library?school=other&sort=downloads')).items.length,
      0,
    );
    assert.equal(
      (await get('/api/library?school=jlu&sort=saves')).items.length,
      1,
    );
    for (let i = 0; i < 2; i++) {
      assert.equal(
        (
          await app.inject({
            url: '/api/library/skin/download',
            remoteAddress: '10.0.0.1',
          })
        ).headers.location,
        '/textures/' + 'a'.repeat(64),
      );
    }
    await app.inject({
      url: '/api/library/skin/download',
      remoteAddress: '10.0.0.2',
    });
    assert.equal((await get('/api/library/skin')).downloads, 2);
    assert.equal(
      (await patch('skin', { title: 'Campus', published: true, tags: 5 }))
        .statusCode,
      403,
    );
    db.db.exec(
      "CREATE TRIGGER fail_like_notice BEFORE INSERT ON notifications WHEN NEW.kind='like' BEGIN SELECT RAISE(ABORT,'forced notice failure'); END;",
    );
    assert.equal(
      (await post('/api/library/skin/like', { liked: true }, bob)).statusCode,
      500,
    );
    assert.equal((await get('/api/library/skin')).likes, 0);
    db.db.exec('DROP TRIGGER fail_like_notice');
    for (let i = 0; i < 2; i++) {
      await post('/api/library/skin/save', {}, bob);
      await post('/api/library/skin/like', { liked: true }, bob);
    }
    assert.equal((await get('/api/library/skin')).saves, 1);
    assert.equal(
      (await get('/api/notifications', alice)).items.filter(
        (n: { kind: string }) => n.kind === 'like',
      ).length,
      1,
    );
    const copy = (await get('/api/wardrobe', bob)).items[0];
    assert.equal(copy.source, 'original');
    assert.equal(
      (await patch(copy.id, { title: 'Mine', published: true }, bob))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/me/avatar',
          headers: bob,
          payload: { item: copy.id },
        })
      ).statusCode,
      200,
    );
    assert.equal((await get('/api/users/bob')).avatar, 'a'.repeat(64));
    assert.equal(
      (
        await post(
          '/api/library/skin/report',
          { reason: 'Suspected infringement' },
          bob,
        )
      ).statusCode,
      200,
    );
    assert.equal((await get('/api/admin/reviews', admin)).reports.length, 1);
    assert.equal((await review('rejected')).statusCode, 200);
    assert.equal((await get('/api/library')).items.length, 0);
    assert.equal((await get('/api/users/alice')).items.length, 0);
    // Review controls public discovery, while existing role textures remain usable.
    assert.equal(
      (await post(`/api/wardrobe/${copy.id}/apply`, {}, bob)).statusCode,
      200,
    );
    assert.equal(db.textures(db.account('id', 'bob')!)[0].hash, 'a'.repeat(64));
    assert.equal((await get('/api/admin/reviews', admin)).reports.length, 0);
    assert.equal(
      (
        await patch('skin', {
          title: 'Corrected',
          published: true,
          source: 'derivative',
          license: 'Author credit',
        })
      ).statusCode,
      200,
    );
    assert.equal((await get('/api/wardrobe', alice)).items[0].state, 'pending');
    const staleSubmission = db.db
      .prepare("SELECT submission FROM texture_reviews WHERE item='skin'")
      .get()!.submission;
    await patch('skin', { title: 'Another correction', published: true });
    assert.equal(
      (
        await post(
          '/api/admin/reviews/skin',
          {
            state: 'approved',
            reason: 'Stale decision',
            submission: staleSubmission,
          },
          admin,
        )
      ).statusCode,
      403,
    );
    assert.equal((await get('/api/library')).items.length, 0);
    assert.equal(
      (
        await post(
          '/api/admin/announcements',
          {
            title: 'Holiday',
            content: '<script>plain text</script>',
            severity: 'warning',
            priority: 10,
            expand: true,
          },
          bob,
        )
      ).statusCode,
      403,
    );
    const announcement = await post(
      '/api/admin/announcements',
      {
        title: 'Holiday',
        content: 'Maintenance',
        severity: 'warning',
        priority: 10,
        expand: true,
      },
      admin,
    );
    assert.equal(announcement.statusCode, 200);
    assert.equal((await get('/api/announcements')).announcements[0].expand, 1);
    for (let index = 0; index < 40; index++) {
      assert.equal(
        (
          await post(
            '/api/admin/announcements',
            {
              title: `Notice ${index}`,
              content: 'Pagination fixture',
              severity: 'info',
              priority: 20,
              expand: false,
            },
            admin,
          )
        ).statusCode,
        200,
      );
    }
    assert.equal(
      (await get('/api/admin/announcements?offset=40', admin)).announcements[0]
        .title,
      'Holiday',
    );
    assert.equal(
      (await app.inject({ url: '/api/admin/announcements', headers: bob }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/admin/announcements?offset=-1',
          headers: admin,
        })
      ).statusCode,
      403,
    );
    const notice = (await get('/api/notifications', alice)).items[0];
    await post('/api/notifications/read', { id: notice.id }, bob);
    assert.equal(
      (await get('/api/notifications', alice)).items[0].read_at,
      null,
    );
    await post('/api/notifications/read', { id: notice.id }, alice);
    assert.ok((await get('/api/notifications', alice)).items[0].read_at);
    await app.inject({
      method: 'DELETE',
      url: '/api/wardrobe/skin',
      headers: alice,
    });
    assert.equal(
      (await post(`/api/wardrobe/${copy.id}/apply`, {}, bob)).statusCode,
      200,
    );
    assert.equal(
      (await patch(copy.id, { title: 'Mine', published: true }, bob))
        .statusCode,
      403,
    );
  } finally {
    await app.close();
    db.close();
  }
});

function communityFixture(admins: string[]) {
  const db = new Store(':memory:');
  const app = Fastify();
  for (const id of ['alice', 'bob', 'admin']) {
    const account = {
      id,
      school: 'jlu',
      name: id,
      email: `${id}@school.test`,
      password: 'unused',
      verified_at: now(),
    };
    db.confirm(account.email, db.challenge(account, now()), now());
  }
  registerWardrobe(app, db, admins);
  registerCommunity(app, db, admins);
  const headers = (id: string) => ({
    authorization: `Bearer ${db.mint(id, 'community-regression', now())}`,
  });
  const insert = (id: string, published: boolean) =>
    db.db
      .prepare('INSERT INTO wardrobe VALUES(?,?,?,?,?,?,?)')
      .run(id, 'alice', id, 'skin', digest(id), 'default', published ? 1 : 0);
  return { db, app, headers, insert };
}

test('published entries without a review are pending until an administrator decides', async () => {
  const { db, app, headers, insert } = communityFixture(['admin']);
  insert('unreviewed', true);
  db.db
    .prepare('INSERT INTO wardrobe VALUES(?,?,?,?,?,?,?)')
    .run('private', 'alice', 'Private', 'cape', 'b'.repeat(64), 'default', 0);
  const get = async (url: string) =>
    (await app.inject({ url, headers: headers('admin') })).json();
  const review = (id: string, state: string) =>
    app.inject({
      method: 'POST',
      url: `/api/admin/reviews/${id}`,
      headers: headers('admin'),
      payload: { state, reason: 'Human review', submission: null },
    });
  try {
    assert.equal((await get('/api/library')).items.length, 0);
    const queue = (await get('/api/admin/reviews')).items;
    assert.deepEqual(queue.map((item: { id: string }) => item.id), ['unreviewed']);
    assert.equal(queue[0].state, 'pending');
    assert.equal(queue[0].submission, null);
    assert.equal((await get('/api/admin/reviews?state=approved')).items.length, 0);
    assert.equal(db.db.prepare('SELECT count(*) AS n FROM texture_reviews').get()!.n, 0);
    assert.equal((await review('private', 'approved')).statusCode, 403);
    assert.equal((await review('unreviewed', 'approved')).statusCode, 200);
    assert.equal((await get('/api/library')).items[0].id, 'unreviewed');
    assert.equal((await get('/api/admin/reviews')).items.length, 0);
    assert.equal((await get('/api/admin/reviews?state=approved')).items.length, 1);
    assert.equal((await review('unreviewed', 'rejected')).statusCode, 403);
    assert.equal((await get('/api/library')).items.length, 1);
    insert('changed', true);
    await app.inject({
      method: 'PATCH', url: '/api/wardrobe/changed', headers: headers('alice'),
      payload: { title: 'Changed after listing', published: true },
    });
    assert.equal((await review('changed', 'approved')).statusCode, 403);
    insert('rejected', true);
    assert.equal((await review('rejected', 'rejected')).statusCode, 200);
    assert.equal((await get('/api/admin/reviews?state=rejected')).items[0].id, 'rejected');
    assert.equal((await app.inject('/api/library/rejected')).statusCode, 403);
  } finally {
    await app.close();
    db.close();
  }
});

test('an empty administrator list rejects publication without hiding approved entries', async () => {
  const { db, app, headers, insert } = communityFixture([]);
  insert('approved', true);
  insert('draft', false);
  db.db.prepare("INSERT INTO texture_reviews VALUES(?,'approved','Reviewed','admin',?,'approved-submission')")
    .run('approved', now());
  const patch = (id: string, published: boolean) => app.inject({
    method: 'PATCH', url: `/api/wardrobe/${id}`, headers: headers('alice'),
    payload: { title: 'Edited', published },
  });
  try {
    assert.equal((await app.inject('/api/library/approved')).statusCode, 200);
    const response = await patch('draft', true);
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().message, 'Publication requires a site administrator');
    const draft = db.db.prepare("SELECT title,published FROM wardrobe WHERE id='draft'").get()!;
    assert.equal(draft.title, 'draft');
    assert.equal(draft.published, 0);
    assert.equal(db.db.prepare('SELECT count(*) AS n FROM texture_reviews').get()!.n, 1);
    assert.equal((await patch('draft', false)).statusCode, 200);
    assert.equal((await patch('approved', false)).statusCode, 200);
    assert.equal((await app.inject('/api/library')).json().items.length, 0);
  } finally {
    await app.close();
    db.close();
  }
});

test('deleting a collected copy updates author counts and preserves event notices and likes', async () => {
  const { db, app, headers, insert } = communityFixture(['admin']);
  insert('original', true);
  db.db.prepare("INSERT INTO texture_reviews VALUES(?,'approved','Reviewed','admin',?,'approved-submission')")
    .run('original', now());
  const save = () => app.inject({
    method: 'POST', url: '/api/library/original/save', headers: headers('bob'),
  });
  const detail = async () => (await app.inject('/api/library/original')).json();
  try {
    assert.equal((await save()).statusCode, 200);
    await app.inject({
      method: 'POST', url: '/api/library/original/like', headers: headers('bob'),
      payload: { liked: true },
    });
    assert.equal((await detail()).saves, 1);
    const copy = (await app.inject({ url: '/api/wardrobe', headers: headers('bob') })).json().items[0];
    db.db.exec("CREATE TRIGGER fail_copy_delete BEFORE DELETE ON wardrobe WHEN OLD.account='bob' BEGIN SELECT RAISE(ABORT,'forced deletion failure'); END;");
    const remove = () => app.inject({ method: 'DELETE', url: `/api/wardrobe/${copy.id}`, headers: headers('bob') });
    assert.equal((await remove()).statusCode, 500);
    assert.equal((await detail()).saves, 1);
    db.db.exec('DROP TRIGGER fail_copy_delete');
    assert.equal((await remove()).statusCode, 204);
    assert.equal((await detail()).saves, 0);
    assert.equal((await detail()).likes, 1);
    assert.equal((await app.inject('/api/users/alice')).json().saves, 0);
    assert.equal(db.db.prepare("SELECT count(*) AS n FROM notifications WHERE kind='save'").get()!.n, 1);
    assert.equal((await save()).statusCode, 200);
    assert.equal((await detail()).saves, 1);
  } finally {
    await app.close();
    db.close();
  }
});

test('community routes initialize their schema without wardrobe route registration', async () => {
  const db = new Store(':memory:');
  const app = Fastify();
  registerCommunity(app, db, []);
  try {
    assert.equal((await app.inject('/api/announcements')).statusCode, 200);
    assert.deepEqual((await app.inject('/api/announcements')).json(), { announcements: [] });
  } finally {
    await app.close();
    db.close();
  }
});

test('texture detail rejects a row removed after its initial lookup', async () => {
  const { db, app, headers, insert } = communityFixture(['admin']);
  const prepare = db.db.prepare.bind(db.db);
  Object.defineProperty(db.db, 'prepare', {
    configurable: true,
    value(sql: string) {
      if (sql.includes('CASE WHEN'))
        prepare("DELETE FROM wardrobe WHERE id='removed'").run();
      return prepare(sql);
    },
  });
  try {
    for (const url of ['/api/library/removed', '/api/wardrobe']) {
      insert('removed', true);
      prepare("INSERT INTO texture_reviews VALUES(?,'approved','Reviewed','admin',?,'approved-submission')")
        .run('removed', now());
      const response = await app.inject({ url, headers: headers('alice') });
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().message, 'Texture not found');
    }
  } finally {
    await app.close();
    db.close();
  }
});
