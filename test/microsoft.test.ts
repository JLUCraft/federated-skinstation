import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Store } from '../server/store.js';
import { registerMicrosoft } from '../server/microsoft.js';

const microsoftConfig = {
  clientId: 'fixture-client',
  clientSecretEnv: 'JLUC_TEST_MICROSOFT_SECRET',
};
const profileId = '0123456789abcdef0123456789abcdef';
test('Microsoft binding and login verify Java ownership, bind browser state, and consume grants once', async () => {
  process.env.JLUC_TEST_MICROSOFT_SECRET = 'fixture-secret';
  const db = new Store(':memory:');
  const app = Fastify();
  const time = Math.floor(Date.now() / 1000);
  const account = {
    id: 'local-member',
    name: 'Member',
    email: 'member@school.test',
    school: 'jlu',
    password: 'unused',
    verified_at: time,
  };
  db.confirm(account.email, db.challenge(account, time), time);
  const token = db.mint(account.id, 'test', time);
  let owns = true;
  let exchanges = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    exchanges++;
    const path = String(url);
    if (path.endsWith('/token')) {
      const form = init?.body as URLSearchParams;
      assert.equal(form.get('client_id'), 'fixture-client');
      assert.equal(form.get('code_verifier')?.length, 64);
      assert.equal(
        form.get('redirect_uri'),
        'https://skin.test/api/microsoft/callback',
      );
      return Response.json({ access_token: 'microsoft-token' });
    }
    if (path.includes('user.auth.xboxlive.com'))
      return Response.json({ Token: 'user-token' });
    if (path.includes('xsts.auth.xboxlive.com'))
      return Response.json({
        Token: 'xsts-token',
        DisplayClaims: { xui: [{ uhs: 'user-hash' }] },
      });
    if (path.endsWith('/login_with_xbox'))
      return Response.json({ access_token: 'minecraft-token' });
    if (path.endsWith('/mcstore'))
      return Response.json({ items: owns ? [{ name: 'game_minecraft' }] : [] });
    if (path.endsWith('/minecraft/profile'))
      return Response.json({ id: profileId, name: 'VerifiedPlayer' });
    throw new Error(`Unexpected upstream ${path}`);
  }) as typeof fetch;
  await registerMicrosoft(
    app,
    db,
    microsoftConfig,
    'https://skin.test',
    async (a) => assert.equal(a.id, account.id),
    fetcher,
  );
  const start = async (mode: 'link' | 'login') => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/microsoft/start',
      headers: { authorization: `Bearer ${token}` },
      payload: { mode },
    });
    assert.equal(response.statusCode, 200);
    const url = new URL(response.json().url);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    return {
      state: url.searchParams.get('state')!,
      cookie: response.cookies[0].name + '=' + response.cookies[0].value,
    };
  };
  const callback = (
    flow: { state: string; cookie: string },
    cookie = flow.cookie,
  ) =>
    app.inject({
      method: 'GET',
      url: `/api/microsoft/callback?code=fixture&state=${flow.state}`,
      headers: { cookie },
    });
  try {
    const flow = await start('link');
    assert.equal(
      (await callback(flow, 'microsoft_state=wrong')).statusCode,
      403,
    );
    assert.equal(exchanges, 0);
    const bound = await callback(flow);
    assert.equal(bound.statusCode, 302);
    assert.equal(
      bound.headers.location,
      'https://skin.test/portal/?microsoft=complete',
    );
    assert.equal((await callback(flow)).statusCode, 403);
    const resultCookie = bound.cookies.find(
      (c) => c.name === 'microsoft_result',
    )!;
    const completed = await app.inject({
      method: 'POST',
      url: '/api/microsoft/complete',
      headers: { cookie: `${resultCookie.name}=${resultCookie.value}` },
    });
    assert.equal(completed.statusCode, 200);
    assert.equal(
      db.token(completed.json().accessToken, undefined, time).id,
      account.id,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/microsoft/complete',
          headers: { cookie: `${resultCookie.name}=${resultCookie.value}` },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        db.db.prepare('SELECT name FROM microsoft_links').get() as {
          name: string;
        }
      ).name,
      'VerifiedPlayer',
    );
    assert.equal(db.profileId(account), account.id);
    const login = await callback(await start('login'));
    assert.equal(login.statusCode, 302);
    const grant = login.cookies.find((c) => c.name === 'microsoft_result')!;
    await app.inject({
      method: 'DELETE',
      url: '/api/microsoft/link',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/microsoft/complete',
          headers: { cookie: `${grant.name}=${grant.value}` },
        })
      ).statusCode,
      403,
    );
    owns = false;
    assert.equal(
      (await callback(await start('link'))).headers.location,
      'https://skin.test/portal/?microsoft=failed',
    );
    assert.equal(
      db.db.prepare('SELECT 1 FROM microsoft_links').get(),
      undefined,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/microsoft/start',
          headers: { origin: 'https://attacker.test' },
          payload: { mode: 'login' },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
    db.close();
    delete process.env.JLUC_TEST_MICROSOFT_SECRET;
  }
});
