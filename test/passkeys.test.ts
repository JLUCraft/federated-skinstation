import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site } from './helpers/site.js';
const origin = 'https://skin.example.test';
test('passkey challenges require same origin, account password, browser cookie and live session', async () => {
  const s = await site();
  try {
    const a = await s.enroll('Passkey');
    const request = (
      url: string,
      payload: object,
      options: { cookie?: string; token?: string; origin?: string } = {},
    ) =>
      s.app.inject({
        method: 'POST',
        url,
        payload,
        headers: {
          origin: options.origin ?? origin,
          ...(options.token
            ? { authorization: `Bearer ${options.token}` }
            : {}),
          ...(options.cookie ? { cookie: options.cookie } : {}),
        },
      });
    assert.equal(
      (
        await request(
          '/api/passkeys/register/options',
          { password: 'incorrect' },
          { token: a.accessToken },
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await request(
          '/api/passkeys/register/options',
          { password: 'password-for-contract-testing' },
          { token: a.accessToken, origin: 'https://foreign.test' },
        )
      ).statusCode,
      403,
    );
    const begin = await request(
      '/api/passkeys/register/options',
      { password: 'password-for-contract-testing' },
      { token: a.accessToken },
    );
    assert.equal(begin.statusCode, 200, begin.body);
    assert.equal(
      begin.json().authenticatorSelection.userVerification,
      'required',
    );
    const cookie = String(begin.headers['set-cookie']).split(';')[0];
    assert.match(String(begin.headers['set-cookie']), /HttpOnly/);
    const forged = { name: 'forged', response: { id: 'invalid' } };
    assert.equal(
      (
        await request('/api/passkeys/register/verify', forged, {
          token: a.accessToken,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await request('/api/passkeys/register/verify', forged, {
          token: a.accessToken,
          cookie,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await request('/api/passkeys/register/verify', forged, {
          token: a.accessToken,
          cookie,
        })
      ).statusCode,
      403,
    );
    const fresh = await request(
      '/api/passkeys/register/options',
      { password: 'password-for-contract-testing' },
      { token: a.accessToken },
    );
    await s.post('/authserver/invalidate', { accessToken: a.accessToken });
    assert.equal(
      (
        await request('/api/passkeys/register/verify', forged, {
          token: a.accessToken,
          cookie: String(fresh.headers['set-cookie']).split(';')[0],
        })
      ).statusCode,
      403,
    );
    const login = await request('/api/passkeys/login/options', {});
    assert.equal(login.statusCode, 200);
    assert.equal(login.json().userVerification, 'required');
    assert.equal(
      (
        await request(
          '/api/passkeys/login/verify',
          { response: { id: 'unknown' } },
          { cookie: String(login.headers['set-cookie']).split(';')[0] },
        )
      ).statusCode,
      403,
    );
  } finally {
    await s.close();
  }
});
