import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type {
  OperationsDispatch,
  OperationsJob,
  OperationsSnapshot,
} from '../shared/contracts/generated.js';
import { Store, now } from '../server/store.js';
import { site } from './helpers/site.js';
import { authorizeAgent } from './helpers/oauth.js';

await test('central MCP authorizes instance jobs, preserves caller identity and reuses durable requests after restart', async () => {
  const credential = randomBytes(32).toString('hex');
  process.env.JLU_TEST_OPERATIONS_CREDENTIAL = credential;
  const jobs = new Map<string, OperationsJob>();
  const snapshot: OperationsSnapshot = {
    instances: [
      { id: 'survival', state: 'stopped', pid: null },
      { id: 'gateway', state: 'stopped', pid: null },
    ],
  };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + credential);
    if (url.pathname === '/snapshot') return Response.json(snapshot);
    if (init?.method === 'POST') {
      assert.ok(typeof init.body === 'string');
      const dispatch = JSON.parse(init.body) as OperationsDispatch;
      assert.ok(dispatch.expiresAt > now());
      const intent = dispatch.intent;
      const previous = jobs.get(intent.id);
      if (previous) return Response.json(previous);
      const value: OperationsJob = {
        intent,
        state: 'succeeded',
        createdAt: now(),
        updatedAt: now(),
        expiresAt: dispatch.expiresAt,
      };
      jobs.set(intent.id, value);
      return Response.json(value, { status: 202 });
    }
    const found = jobs.get(url.pathname.slice('/jobs/'.length));
    return found ? Response.json(found) : new Response(null, { status: 404 });
  };
  const service = await site(undefined, undefined, undefined, undefined, {
    settings: {
      hosts: {
        campus: {
          endpoint: 'https://ops.example.test',
          credentialEnv: 'JLU_TEST_OPERATIONS_CREDENTIAL',
        },
      },
    },
    transport,
  });
  const store = new Store(join(service.dir, 'db'));
  try {
    const admin = await service.enroll('Administrator');
    const member = await service.enroll('Member');
    store.db
      .prepare(
        "INSERT INTO grants VALUES('operations-admin','user',?,'global','admin','fixture',?,NULL,NULL)",
      )
      .run(admin.user.id, now());
    const binding = { host: 'campus', instance: 'survival', scope: 'club:jlu' };
    await service.requestJson(admin, 'POST', '/api/operations/targets', binding, 204);
    await service.requestJson(member, 'POST', '/api/operations/targets', binding, 403);
    await service.requestJson(
      member,
      'POST',
      '/api/operations/hosts/campus/instances/survival/jobs',
      { key: 'no-authority', action: 'start' },
      403,
    );
    await service.requestJson(admin, 'POST', '/api/identity/grants', {
      account: member.user.id,
      scope: 'club:jlu',
      permission: 'write',
    });
    await service.requestJson(admin, 'POST', '/api/identity/grants', {
      account: member.user.id,
      scope: 'club:jlu',
      permission: 'read',
    });
    const agent = await authorizeAgent(service.app, member.accessToken);
    let id = 0;
    const call = (name: string, args: object) =>
      service.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: 'Bearer ' + agent.access_token },
        payload: {
          jsonrpc: '2.0',
          id: ++id,
          method: 'tools/call',
          params: { name, arguments: args },
        },
      });
    const arguments_ = {
      path: { host: 'campus', instance: 'survival' },
      body: { key: 'start-survival', action: 'start' },
    };
    const started = await call(
      'post_operations_hosts_by_host_instances_by_instance_jobs',
      arguments_,
    );
    assert.equal(started.statusCode, 200, started.body);
    const result = started.json<{
      result: { structuredContent: OperationsJob; isError?: boolean };
    }>().result;
    assert.equal(result.isError, undefined, started.body);
    const intent = result.structuredContent.intent;
    assert.equal(intent.actor.account, member.user.id);
    assert.equal(intent.actor.client, agent.clientId);
    assert.equal(intent.scope, binding.scope);
    assert.equal(result.structuredContent.state, 'succeeded');
    const repeated = await call(
      'post_operations_hosts_by_host_instances_by_instance_jobs',
      arguments_,
    );
    assert.equal(
      repeated.json<{ result: { structuredContent: OperationsJob } }>().result.structuredContent
        .intent.id,
      intent.id,
    );
    assert.equal(jobs.size, 1);
    const conflict = await call('post_operations_hosts_by_host_instances_by_instance_jobs', {
      ...arguments_,
      body: { ...arguments_.body, action: 'stop' },
    });
    assert.equal(conflict.json<{ result: { isError: boolean } }>().result.isError, true);
    const audit = store.db
      .prepare(
        "SELECT actor,actor_client,request_id FROM audit WHERE action='operations.job.submit'",
      )
      .get();
    assert.equal(audit?.actor, member.user.id);
    assert.equal(audit.actor_client, agent.clientId);
    assert.equal(audit.request_id, intent.actor.request);
    await service.restart();
    const recorded = await call('get_operations_jobs_by_id', { path: { id: intent.id } });
    assert.equal(
      recorded.json<{ result: { structuredContent: OperationsJob } }>().result.structuredContent
        .state,
      'succeeded',
    );
    await service.requestJson(
      admin,
      'POST',
      '/api/clubs/jlu/members/' + member.user.id + '/revoke',
      {},
      204,
    );
    assert.equal(
      (await call('get_operations_jobs_by_id', { path: { id: intent.id } })).statusCode,
      401,
    );
  } finally {
    store.close();
    await service.close();
    delete process.env.JLU_TEST_OPERATIONS_CREDENTIAL;
  }
});
