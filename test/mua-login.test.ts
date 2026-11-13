import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LightMyRequestResponse } from 'fastify';
import { join } from 'node:path';
import { now, Store } from '../server/store.js';
import type { Authentication } from '../shared/http.js';
import type { MuaAdmission } from '../shared/contracts/generated.js';
import { site } from './helpers/site.js';
import { authorizeAgent } from './helpers/oauth.js';

function responseCookie(response: LightMyRequestResponse, name: string) {
  const value = response.headers['set-cookie'];
  const cookies = Array.isArray(value) ? value : [String(value)];
  const found = cookies.find((entry) => entry.startsWith(name + '='));
  assert.ok(found, response.body);
  return found.split(';')[0];
}

await test('MUA identities enroll through local proof, authenticate central OAuth, and retain revocation across unlink and sign-in', async () => {
  process.env.JLU_TEST_MUA_LOGIN_SECRET = 'fixture-confidential-client-secret';
  let subject = 'MUA:123';
  let exchanges = 0;
  const service = await site(
    {
      apiRoot: 'https://skin.mualliance.ltd/api/union',
      oauth: { clientId: 'jlucraft-fixture', clientSecretEnv: 'JLU_TEST_MUA_LOGIN_SECRET' },
    },
    async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      assert.equal(init?.redirect, 'error');
      exchanges++;
      if (url.endsWith('/oauth2/token')) {
        assert.ok(init?.body instanceof URLSearchParams);
        assert.equal(init.body.get('grant_type'), 'authorization_code');
        assert.equal(init.body.get('redirect_uri'), 'https://skin.example.test/api/mua/callback');
        assert.equal(init.body.get('client_secret'), process.env.JLU_TEST_MUA_LOGIN_SECRET);
        return Response.json({ access_token: 'upstream-token' });
      }
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer upstream-token');
      return Response.json({
        sub: subject,
        nickname: 'Upstream nickname',
        email: 'same@school.test',
      });
    },
  );
  const store = new Store(join(service.dir, 'db'));
  const origin = 'https://skin.example.test';
  const post = (url: string, payload: object, cookie?: string, token?: string) =>
    service.app.inject({
      method: 'POST',
      url,
      payload,
      headers: {
        origin,
        ...(cookie ? { cookie } : {}),
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
    });
  async function begin(token?: string) {
    const response = await post(token ? '/api/mua/link' : '/api/mua/login', {}, undefined, token);
    assert.equal(response.statusCode, 200, response.body);
    const destination = new URL(response.json<{ url: string }>().url);
    assert.equal(destination.origin, 'https://skin.mualliance.ltd');
    assert.equal(destination.searchParams.get('response_type'), 'code');
    return {
      url:
        '/api/mua/callback?' +
        new URLSearchParams({
          state: destination.searchParams.get('state') ?? '',
          code: 'fixture-code',
        }),
      cookie: responseCookie(response, 'mua_state'),
    };
  }
  async function callback(flow: Awaited<ReturnType<typeof begin>>, status = 302) {
    const response = await service.app.inject({ url: flow.url, headers: { cookie: flow.cookie } });
    assert.equal(response.statusCode, status, response.body);
    return response;
  }
  async function login() {
    const returned = await callback(await begin());
    const cookie = responseCookie(returned, 'mua_admission');
    const response = await post('/api/mua/session', {}, cookie);
    assert.equal(response.statusCode, 200, response.body);
    return response.json<Authentication>();
  }
  try {
    const flow = await begin();
    assert.equal((await service.app.inject(flow.url)).statusCode, 403);
    assert.equal(exchanges, 0);
    const returned = await callback(flow);
    assert.equal(returned.headers.location, '/portal/?mua=login');
    assert.equal(exchanges, 2);
    await callback(flow, 403);
    const cookie = responseCookie(returned, 'mua_admission');
    const review = (
      await service.app.inject({ url: '/api/mua/session', headers: { cookie } })
    ).json<MuaAdmission>();
    assert.equal(review.status, 'enrollment');
    assert.equal(review.subject, subject);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM accounts').get()?.n, 0);
    assert.equal((await post('/api/mua/session', {}, cookie)).statusCode, 403);
    const enrollment = await post(
      '/api/mua/enrollment/start',
      { email: 'verified@school.test', school: 'jlu', name: 'MuaStudent' },
      cookie,
    );
    assert.equal(enrollment.statusCode, 202, enrollment.body);
    const confirmation = { code: service.verificationCode() };
    assert.equal((await post('/api/mua/enrollment/confirm', confirmation)).statusCode, 403);
    const confirmed = await post('/api/mua/enrollment/confirm', confirmation, cookie);
    assert.equal(confirmed.statusCode, 204, confirmed.body);
    const session = await post('/api/mua/session', {}, cookie);
    assert.equal(session.statusCode, 200, session.body);
    const signedIn = session.json<Authentication>();
    assert.ok(signedIn.user);
    const account = store.account('id', signedIn.user.id);
    assert.equal(account?.password, null);
    assert.equal(account?.email, 'verified@school.test');
    assert.equal(account?.name, 'MuaStudent');
    assert.equal((await post('/api/mua/session', {}, cookie)).statusCode, 403);
    const agent = await authorizeAgent(service.app, signedIn.accessToken);
    assert.equal(store.oauthSession(agent.access_token)?.account, account?.id);
    const deviceStart = await post('/api/oauth/device', {
      client_id: 'jlucraft-launcher',
      scope: 'openid offline_access Yggdrasil.PlayerProfiles.Select Yggdrasil.Server.Join',
    });
    assert.equal(deviceStart.statusCode, 200, deviceStart.body);
    const device = deviceStart.json<{ user_code: string; device_code: string }>();
    const deviceDecision = await post(
      '/api/oauth/device/decision',
      { userCode: device.user_code, approve: true },
      undefined,
      signedIn.accessToken,
    );
    assert.equal(deviceDecision.statusCode, 204, deviceDecision.body);
    const gameTokens = await post('/api/oauth/token', {
      client_id: 'jlucraft-launcher',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
    });
    assert.equal(gameTokens.statusCode, 200, gameTokens.body);
    const gameToken = gameTokens.json<{ access_token: string }>().access_token;
    assert.equal(store.token(gameToken, undefined, now()).id, account?.id);
    assert.equal((await post('/api/mua/link', {}, undefined, gameToken)).statusCode, 403);
    const blockedUnlink = await service.app.inject({
      method: 'DELETE',
      url: '/api/mua/link',
      headers: { origin, authorization: 'Bearer ' + signedIn.accessToken },
    });
    assert.equal(blockedUnlink.statusCode, 403);
    subject = 'SJMC:123';
    const other = await callback(await begin());
    const otherCookie = responseCookie(other, 'mua_admission');
    assert.equal(
      (
        await post(
          '/api/mua/enrollment/start',
          { email: 'verified@school.test', school: 'jlu', name: 'AnotherStudent' },
          otherCookie,
        )
      ).statusCode,
      409,
    );
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM accounts').get()?.n, 1);
    subject = 'MUA:123';
    assert.equal((await login()).user?.id, account?.id);
    await post('/api/password/start', { email: 'verified@school.test' });
    const reset = await post('/api/password/confirm', {
      email: 'verified@school.test',
      code: service.verificationCode(),
      password: 'a-local-recovery-password',
    });
    assert.equal(reset.statusCode, 204, reset.body);
    const fresh = await login();
    const delegated = await authorizeAgent(service.app, fresh.accessToken);
    const unlink = await service.app.inject({
      method: 'DELETE',
      url: '/api/mua/link',
      headers: { origin, authorization: 'Bearer ' + fresh.accessToken },
    });
    assert.equal(unlink.statusCode, 204, unlink.body);
    assert.equal(store.oauthSession(delegated.access_token), undefined);
    await callback(await begin(), 403);
    const local = await post('/authserver/authenticate', {
      username: 'verified@school.test',
      password: 'a-local-recovery-password',
      requestUser: true,
    });
    assert.equal(local.statusCode, 200, local.body);
    const reconnected = await callback(await begin(local.json<Authentication>().accessToken));
    const restored = await post(
      '/api/mua/session',
      {},
      responseCookie(reconnected, 'mua_admission'),
    );
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json<Authentication>().user?.id, account?.id);
    const administrator = await service.enroll('Administrator');
    store.db
      .prepare(
        "INSERT INTO grants VALUES('mua-login-admin','user',?,'global','admin','fixture',?,NULL,NULL)",
      )
      .run(administrator.user.id, now());
    await service.requestJson(
      administrator,
      'POST',
      '/api/clubs/jlu/members/' + signedIn.user.id + '/revoke',
      {},
      204,
    );
    await callback(await begin(), 403);
    assert.equal(
      store.db
        .prepare("SELECT status FROM memberships WHERE account=? AND club='jlu'")
        .get(signedIn.user.id)?.status,
      'revoked',
    );
  } finally {
    store.close();
    await service.close();
    delete process.env.JLU_TEST_MUA_LOGIN_SECRET;
  }
});
