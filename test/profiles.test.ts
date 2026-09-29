import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site } from './helpers/site.js';
import { PNG } from 'pngjs';
test('multiple profiles isolate ownership, textures, launcher selection and join sessions', async () => {
  const s = await site();
  try {
    const a = await s.enroll('MainRole'),
      b = await s.enroll('OtherRole');
    const request = (
      method: 'POST' | 'PATCH' | 'DELETE' | 'GET',
      url: string,
      payload?: object,
      token = a.accessToken,
    ) =>
      s.app.inject({
        method,
        url,
        payload,
        headers: { authorization: `Bearer ${token}` },
      });
    const created = await request('POST', '/api/players', { name: 'Builder' });
    assert.equal(created.statusCode, 200, created.body);
    const p = created.json();
    assert.equal(
      (
        await request(
          'POST',
          '/api/players',
          { name: 'builder' },
          b.accessToken,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await request(
          'PATCH',
          `/api/players/${p.id}`,
          { name: 'Stolen' },
          b.accessToken,
        )
      ).statusCode,
      403,
    );
    const png = PNG.sync.write(new PNG({ width: 64, height: 64 }));
    const boundary = 'roles';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skin.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await s.app.inject({
      method: 'PUT',
      url: `/api/user/profile/${p.id}/skin`,
      payload,
      headers: {
        authorization: `Bearer ${a.accessToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });
    assert.equal(upload.statusCode, 204, upload.body);
    const me = (await request('GET', '/api/me')).json();
    assert.equal(me.profiles.length, 2);
    assert.equal(me.textures.length, 0);
    assert.equal(
      me.profiles.find((x: any) => x.id === p.id).textures.length,
      1,
    );
    const wardrobe = (await request('GET', '/api/wardrobe')).json().items;
    const item = wardrobe[0];
    assert.equal(item.applied, 0);
    assert.equal(
      (await request('GET', `/api/wardrobe?profileId=${p.id}`)).json().items[0]
        .applied,
      1,
    );
    assert.equal(
      (await request('GET', `/api/wardrobe?profileId=${b.selectedProfile.id}`))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await request('POST', `/api/wardrobe/${item.id}/apply`, {
          profileId: b.selectedProfile.id,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await request('POST', `/api/wardrobe/${item.id}/apply`, {
          profileId: a.selectedProfile.id,
        })
      ).statusCode,
      200,
    );
    assert.equal((await request('GET', '/api/me')).json().textures.length, 1);
    const profile = (
      await s.app.inject(
        '/sessionserver/session/minecraft/profile/' + p.id + '?unsigned=false',
      )
    ).json();
    assert.equal(profile.name, 'Builder');
    assert.ok(
      JSON.parse(
        Buffer.from(
          profile.properties.find((x: any) => x.name === 'textures').value,
          'base64',
        ).toString(),
      ).textures.SKIN,
    );
    const login = (
      await s.post('/authserver/authenticate', {
        username: 'mainrole@school.test',
        password: 'password-for-contract-testing',
      })
    ).json();
    assert.equal(login.selectedProfile, undefined);
    assert.equal(login.availableProfiles.length, 2);
    assert.equal(
      (
        await s.post('/sessionserver/session/minecraft/join', {
          accessToken: login.accessToken,
          selectedProfile: p.id,
          serverId: 'unselected',
        })
      ).statusCode,
      403,
    );
    const foreign = await s.post('/authserver/refresh', {
      accessToken: login.accessToken,
      selectedProfile: b.selectedProfile,
    });
    assert.equal(foreign.statusCode, 403);
    assert.equal(
      (await s.post('/authserver/validate', { accessToken: login.accessToken }))
        .statusCode,
      204,
    );
    const choose = await s.post('/authserver/refresh', {
      accessToken: login.accessToken,
      selectedProfile: { id: p.id, name: p.name },
    });
    assert.equal(choose.statusCode, 200, choose.body);
    const selected = choose.json();
    assert.equal(selected.selectedProfile.id, p.id);
    assert.equal(
      (
        await s.post('/sessionserver/session/minecraft/join', {
          accessToken: selected.accessToken,
          selectedProfile: a.selectedProfile.id,
          serverId: 'wrong',
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await s.post('/sessionserver/session/minecraft/join', {
          accessToken: selected.accessToken,
          selectedProfile: p.id,
          serverId: 'builder-session',
        })
      ).statusCode,
      204,
    );
    assert.equal(
      (
        await s.app.inject(
          '/sessionserver/session/minecraft/hasJoined?username=Builder&serverId=builder-session',
        )
      ).json().id,
      p.id,
    );
    assert.equal(
      (await request('PATCH', `/api/players/${p.id}`, { name: 'Architect' }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await s.post('/authserver/validate', {
          accessToken: selected.accessToken,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await s.app.inject('/api/users/profiles/minecraft/Builder')).statusCode,
      204,
    );
    assert.equal(
      (await s.app.inject('/api/users/profiles/minecraft/Architect')).json().id,
      p.id,
    );
    assert.equal(
      (
        await request(
          'DELETE',
          `/api/players/${p.id}`,
          undefined,
          b.accessToken,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (await request('DELETE', `/api/players/${a.selectedProfile.id}`))
        .statusCode,
      403,
    );
    assert.equal(
      (await request('DELETE', `/api/players/${p.id}`)).statusCode,
      200,
    );
    assert.equal(
      (await s.app.inject('/sessionserver/session/minecraft/profile/' + p.id))
        .statusCode,
      204,
    );
  } finally {
    await s.close();
  }
});

test('extra profile remapping preserves textures, rejects collisions and revokes sessions', async () => {
  const { Store } = await import('../server/store.js');
  const db = new Store(':memory:');
  const now = Math.floor(Date.now() / 1000);
  try {
    const account = {
      id: 'a'.repeat(32),
      name: 'Main',
      email: 'main@school.test',
      school: 'jlu',
      password: 'unused',
      verified_at: now,
    };
    db.confirm(account.email, db.challenge(account, now), now);
    const first = db.createProfile(account, 'Builder');
    const second = db.createProfile(account, 'Explorer');
    db.setTexture(account, first.id, 'skin', 'f'.repeat(64), 'slim');
    const token = db.mint(account.id, 'client', now);
    const next = 'b'.repeat(32);
    assert.throws(() => db.remapProfiles({ [first.id]: second.id }));
    assert.throws(() =>
      db.remapProfiles({ [first.id]: next, [second.id]: account.id }),
    );
    assert.equal(db.ownProfile(account, first.id).name, 'Builder');
    assert.equal(db.profile(next), undefined);
    db.remapProfiles({ [first.id]: next });
    assert.equal(db.profile(first.id), undefined);
    assert.equal(db.ownProfile(account, next).name, 'Builder');
    assert.equal(db.textures(account, next)[0].hash, 'f'.repeat(64));
    assert.equal(db.textures(account).length, 0);
    assert.throws(() => db.token(token, undefined, now));
    db.remapProfiles({ [first.id]: next });
    assert.equal(db.profiles(account).length, 3);
  } finally {
    db.db.close();
  }
});
