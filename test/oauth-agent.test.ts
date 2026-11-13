import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store, now } from '../server/store.js';
import { site } from './helpers/site.js';
import { authorizeAgent } from './helpers/oauth.js';

await test('administrator agent OAuth keeps consent, MCP scope, identity audit, rotation and revocation in one central authority', async () => {
  const service = await site();
  const store = new Store(join(service.dir, 'db'));
  try {
    const admin = await service.enroll('Administrator');
    const member = await service.enroll('Member');
    store.db
      .prepare(
        "INSERT INTO grants VALUES('site-admin','user',?,'global','admin','fixture',?,NULL,NULL)",
      )
      .run(admin.user.id, now());
    let id = 0;
    const rpc = (access: string, method = 'initialize', params: object = {}) =>
      service.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: 'Bearer ' + access },
        payload: { jsonrpc: '2.0', id: ++id, method, params },
      });
    const token = (body: object) =>
      service.app.inject({ method: 'POST', url: '/api/oauth/token', payload: body });
    const readonly = await authorizeAgent(
      service.app,
      admin.accessToken,
      'openid offline_access mcp.read',
    );
    assert.equal((await rpc(admin.accessToken)).statusCode, 401);
    const read = await rpc(readonly.access_token, 'tools/call', {
      name: 'get_identity',
      arguments: {},
    });
    assert.equal(read.statusCode, 200, read.body);
    const grant = {
      name: 'post_identity_grants',
      arguments: { body: { account: member.user.id, scope: 'club:jlu', permission: 'read' } },
    };
    const blocked = await rpc(readonly.access_token, 'tools/call', grant);
    assert.equal(blocked.statusCode, 403, blocked.body);
    assert.match(String(blocked.headers['www-authenticate']), /mcp.write/);
    assert.equal(
      (
        await service.app.inject({
          url: '/api/identity',
          headers: { authorization: 'Bearer ' + readonly.access_token },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await service.app.inject({
          method: 'POST',
          url: '/sessionserver/session/minecraft/join',
          payload: {
            accessToken: readonly.access_token,
            selectedProfile: admin.selectedProfile.id,
            serverId: 'server',
          },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await token({ ...readonly.exchange, code_verifier: 'x'.repeat(43) })).statusCode,
      400,
    );
    assert.equal((await rpc(readonly.access_token)).statusCode, 200);
    assert.equal((await token(readonly.exchange)).statusCode, 400);
    assert.equal((await rpc(readonly.access_token)).statusCode, 401);

    const writer = await authorizeAgent(service.app, admin.accessToken);
    const written = await rpc(writer.access_token, 'tools/call', grant);
    assert.equal(written.statusCode, 200, written.body);
    assert.equal(
      written.json<{ result: { isError?: boolean } }>().result.isError,
      undefined,
      written.body,
    );
    const audit = store.db
      .prepare(
        'SELECT actor,actor_client,request_id FROM audit WHERE actor_client=? ORDER BY seq DESC LIMIT 1',
      )
      .get(writer.clientId);
    assert.equal(audit?.actor, admin.user.id);
    assert.equal(audit?.actor_client, writer.clientId);
    assert.ok(audit?.request_id);
    const refresh = {
      grant_type: 'refresh_token',
      client_id: writer.clientId,
      resource: writer.resource,
      refresh_token: writer.refresh_token,
      scope: 'offline_access mcp.read',
    };
    assert.equal(
      (await token({ ...refresh, resource: 'https://elsewhere.test/mcp' })).json<{
        error: string;
      }>().error,
      'invalid_target',
    );
    const rotated = await token(refresh);
    assert.equal(rotated.statusCode, 200, rotated.body);
    const next = rotated.json<{ access_token: string; refresh_token: string }>();
    assert.notEqual(next.refresh_token, writer.refresh_token);
    assert.equal((await rpc(next.access_token)).statusCode, 200);
    assert.equal((await rpc(writer.access_token, 'tools/call', grant)).statusCode, 403);
    assert.equal((await token(refresh)).statusCode, 400);
    assert.equal((await rpc(next.access_token)).statusCode, 401);

    const delegated = await authorizeAgent(service.app, member.accessToken);
    const grants = (
      await service.app.inject({
        url: '/api/oauth/grants',
        headers: { authorization: 'Bearer ' + member.accessToken },
      })
    ).json<{ grants: { id: string }[] }>();
    assert.equal(grants.grants.length, 1);
    const revoked = await service.app.inject({
      method: 'DELETE',
      url: '/api/oauth/grants/' + grants.grants[0].id,
      headers: { authorization: 'Bearer ' + member.accessToken },
    });
    assert.equal(revoked.statusCode, 204, revoked.body);
    assert.equal((await rpc(delegated.access_token)).statusCode, 401);
    const renewed = await authorizeAgent(service.app, member.accessToken);
    await service.requestJson(
      admin,
      'POST',
      '/api/clubs/jlu/members/' + member.user.id + '/revoke',
      {},
      204,
    );
    assert.equal((await rpc(renewed.access_token)).statusCode, 401);
    assert.equal(
      (
        await token({
          grant_type: 'refresh_token',
          client_id: renewed.clientId,
          resource: renewed.resource,
          refresh_token: renewed.refresh_token,
        })
      ).statusCode,
      400,
    );
  } finally {
    store.close();
    await service.close();
  }
});
