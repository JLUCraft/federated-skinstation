import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { site } from './helpers/site.js';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const SCOPE =
  'openid offline_access Yggdrasil.PlayerProfiles.Select Yggdrasil.Server.Join';

const form = (values: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(values).toString(),
});

test('device flow issues verifiable id tokens, rotating refresh tokens and working access tokens', async () => {
  const s = await site();
  const raw = new DatabaseSync(join(s.dir, 'db'));
  try {
    const login = await s.enroll('Alice');
    const owner = { authorization: `Bearer ${login.accessToken}` };

    const meta = (await s.app.inject({ url: '/' })).json();
    const discovery = (
      await s.app.inject({
        url: new URL(meta.meta['feature.openid_configuration_url']).pathname,
      })
    ).json();
    assert.equal(discovery.shared_client_id, 'jlucraft-launcher');
    const jwks = (await s.app.inject({ url: '/api/oauth/jwks' })).json();
    assert.equal(jwks.keys[0].alg, 'RS256');

    const device = async (values: Record<string, string>) =>
      s.app.inject({
        method: 'POST',
        url: '/api/oauth/device',
        ...form(values),
      });
    const token = async (values: Record<string, string>) =>
      s.app.inject({
        method: 'POST',
        url: '/api/oauth/token',
        ...form({ client_id: 'jlucraft-launcher', ...values }),
      });

    assert.equal(
      (await device({ client_id: 'other', scope: SCOPE })).json().error,
      'invalid_client',
    );
    assert.equal(
      (
        await device({ client_id: 'jlucraft-launcher', scope: 'admin' })
      ).json().error,
      'invalid_scope',
    );

    const started = (
      await device({ client_id: 'jlucraft-launcher', scope: SCOPE })
    ).json();
    assert.match(started.user_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.ok(started.verification_uri_complete.endsWith(started.user_code));

    const poll = { grant_type: DEVICE_GRANT, device_code: started.device_code };
    const first = await token(poll);
    assert.equal(first.statusCode, 400);
    assert.equal(first.json().error, 'authorization_pending');
    assert.equal((await token(poll)).json().error, 'slow_down');

    const decide = (payload: object, headers = owner) =>
      s.app.inject({
        method: 'POST',
        url: '/api/oauth/device/decision',
        headers,
        payload,
      });
    assert.equal(
      (await decide({ userCode: 'ZZZZ-ZZZZ', approve: true })).statusCode,
      404,
    );
    assert.equal(
      (await decide({ userCode: started.user_code, approve: true }, {} as never))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await s.app.inject({
          url: `/api/oauth/device?user_code=${started.user_code.toLowerCase()}`,
          headers: owner,
        })
      ).json().scopes.length,
      4,
    );
    assert.equal(
      (await decide({ userCode: started.user_code, approve: true })).statusCode,
      204,
    );

    raw.exec('UPDATE oauth_devices SET polled=0');
    const issued = await token(poll);
    assert.equal(issued.statusCode, 200);
    const tokens = issued.json();
    assert.equal((await token(poll)).json().error, 'invalid_grant');

    const [header, payload, signature] = tokens.id_token.split('.');
    assert.ok(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${payload}`),
        createPublicKey({ key: jwks.keys[0], format: 'jwk' }),
        Buffer.from(signature, 'base64url'),
      ),
    );
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.equal(claims.aud, 'jlucraft-launcher');
    assert.equal(claims.selectedProfile.name, 'Alice');
    assert.equal(claims.selectedProfile.id, login.selectedProfile.id);
    assert.ok(claims.exp > claims.iat);

    assert.equal(
      (
        await s.post('/authserver/validate', {
          accessToken: tokens.access_token,
        })
      ).statusCode,
      204,
    );
    assert.equal(
      (
        await s.app.inject({
          url: '/api/me',
          headers: { authorization: `Bearer ${tokens.access_token}` },
        })
      ).json().name,
      'Alice',
    );

    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    assert.equal(refreshed.statusCode, 200);
    assert.notEqual(refreshed.json().refresh_token, tokens.refresh_token);
    assert.equal(
      (
        await token({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
        })
      ).json().error,
      'invalid_grant',
    );
    assert.equal(
      (await token({ grant_type: 'password' })).json().error,
      'unsupported_grant_type',
    );

    const refused = (
      await device({ client_id: 'jlucraft-launcher', scope: SCOPE })
    ).json();
    assert.equal(
      (await decide({ userCode: refused.user_code, approve: false })).statusCode,
      204,
    );
    assert.equal(
      (
        await token({ grant_type: DEVICE_GRANT, device_code: refused.device_code })
      ).json().error,
      'access_denied',
    );
  } finally {
    raw.close();
    await s.close();
  }
});
