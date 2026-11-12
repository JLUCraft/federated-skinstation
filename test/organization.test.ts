import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { resolveOrganization } from '../server/organization.js';
import { Rejected } from '../server/store.js';
import { site } from './helpers/site.js';

test('organization defaults and validation use configuration rejection errors', () => {
  assert.equal(resolveOrganization(undefined), 'jlucraft');
  assert.equal(resolveOrganization('acme-123'), 'acme-123');
  assert.equal(resolveOrganization('a'.repeat(64)), 'a'.repeat(64));
  for (const value of ['', 'Acme', 'acme_test', 'acme/test', 'acme\n', 'a'.repeat(65), null, 123]) {
    assert.throws(() => resolveOrganization(value as string), Rejected);
  }
});

for (const organization of [undefined, 'acme']) {
  test(`organization ${organization ?? 'default'} scopes protocol metadata and passkey cookies`, async () => {
    const host = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const s = await site(
      {
        apiRoot: 'https://mua.example.test/api/union',
        hostPublicKey: host.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      },
      undefined,
      organization,
    );
    try {
      const discovery = await s.app.inject('/.well-known/openid-configuration');
      assert.equal(discovery.statusCode, 200);
      assert.equal(
        discovery.json<{ shared_client_id: string }>().shared_client_id,
        organization ? 'acme-launcher' : 'jlucraft-launcher',
      );
      const metadata = await s.app.inject('/api/union/member/');
      assert.equal(metadata.statusCode, 200);
      assert.equal(
        metadata.json<{ yggdrasilApiVersion: string }>().yggdrasilApiVersion,
        organization ? 'acme-0.2.0' : 'jlucraft-0.2.0',
      );
      const login = await s.app.inject({
        method: 'POST',
        url: '/api/passkeys/login/options',
        headers: { origin: 'https://skin.example.test' },
        payload: {},
      });
      assert.equal(login.statusCode, 200, login.body);
      assert.equal(
        String(login.headers['set-cookie']).split('=')[0],
        organization ? 'acme_passkey' : 'jlucraft_passkey',
      );
    } finally {
      await s.close();
    }
  });
}
