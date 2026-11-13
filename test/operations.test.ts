import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type {
  OperationsDispatch,
  OperationsCancellation,
  OperationsLogPage,
  OperationsJob,
  OperationsSnapshot,
} from '../shared/contracts/generated.js';
import { streamText } from '../server/streams.js';
import { OPERATIONS_SCOPE_HEADER } from '../shared/operations.js';
import { Store, now } from '../server/store.js';
import { site } from './helpers/site.js';
import { authorizeAgent } from './helpers/oauth.js';

await test(
  'central MCP authorizes instance jobs, preserves caller identity and reuses durable requests after restart',
  { timeout: 30_000 },
  async () => {
    const credential = randomBytes(32).toString('hex');
    process.env.JLU_TEST_OPERATIONS_CREDENTIAL = credential;
    const jobs = new Map<string, OperationsJob>();
    let finishImmediately = true;
    let holdWatch = false;
    let latestAbort = Promise.resolve();
    let heldController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let heldOpen = false;
    const logPage: OperationsLogPage = {
      entries: [{ sequence: '1', at: now(), data: 'server output\n', clipped: false }],
      cursor: '1',
      truncated: false,
    };
    const snapshot: OperationsSnapshot = {
      instances: [
        { id: 'survival', state: 'stopped', pid: null, acceptsConsole: true },
        { id: 'gateway', state: 'stopped', pid: null, acceptsConsole: true },
      ],
    };
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + credential);
      if (url.pathname === '/snapshot') return Response.json(snapshot);
      if (url.pathname.endsWith('/logs/watch')) {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode('event: logs\ndata: ' + JSON.stringify(logPage) + '\n\n'),
              );
              if (!holdWatch) {
                controller.enqueue(
                  encoder.encode(
                    'event: done\ndata: ' + JSON.stringify({ ...logPage, entries: [] }) + '\n\n',
                  ),
                );
                controller.close();
              }
              heldController = controller;
              heldOpen = holdWatch;
              latestAbort = new Promise<void>((resolve) => {
                const stopped = () => {
                  if (heldController === controller) heldOpen = false;
                  resolve();
                  controller.error(new Error('watch aborted'));
                };
                if (init?.signal?.aborted) stopped();
                else init?.signal?.addEventListener('abort', stopped, { once: true });
              });
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      if (url.pathname.endsWith('/logs')) return Response.json(logPage);
      if (url.pathname.startsWith('/instances/') && url.pathname.endsWith('/jobs')) {
        const scope = new Headers(init?.headers).get(OPERATIONS_SCOPE_HEADER);
        return Response.json({
          jobs: [...jobs.values()].filter((job) => job.intent.scope === scope),
          cursor: null,
        });
      }
      if (url.pathname.endsWith('/cancel')) {
        assert.ok(init && typeof init.body === 'string');
        const cancellation = JSON.parse(init.body) as OperationsCancellation;
        const job = jobs.get(url.pathname.split('/')[2]);
        assert.ok(job);
        if (job.state !== 'queued') return new Response(null, { status: 409 });
        job.state = 'cancelled';
        job.cancelledBy = cancellation.actor;
        return Response.json(job);
      }
      if (init?.method === 'POST') {
        assert.ok(typeof init.body === 'string');
        const dispatch = JSON.parse(init.body) as OperationsDispatch;
        assert.ok(dispatch.expiresAt > now());
        const intent = dispatch.intent;
        const previous = jobs.get(intent.id);
        if (previous) return Response.json(previous);
        const job: OperationsJob = {
          intent,
          state: finishImmediately ? 'succeeded' : 'queued',
          createdAt: now(),
          updatedAt: now(),
          expiresAt: dispatch.expiresAt,
        };
        jobs.set(intent.id, job);
        return Response.json(job, { status: 202 });
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
        { key: 'no-authority', operation: { action: 'start' } },
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
        body: { key: 'start-survival', operation: { action: 'start' } },
      };
      const started = await call(
        'post_operations_hosts_by_host_instances_by_instance_jobs',
        arguments_,
      );
      assert.equal(started.statusCode, 200, started.body);
      assert.equal(started.json<{ id: number }>().id, id);
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
        body: { ...arguments_.body, operation: { action: 'stop' } },
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
      const consoleResult = await call('post_operations_hosts_by_host_instances_by_instance_jobs', {
        ...arguments_,
        body: { key: 'console', operation: { action: 'console', input: 'say private-message' } },
      });
      assert.equal(
        consoleResult.json<{ result: { structuredContent: OperationsJob } }>().result
          .structuredContent.state,
        'succeeded',
      );
      assert.equal(
        JSON.stringify(
          store.db.prepare("SELECT * FROM audit WHERE action='operations.job.submit'").all(),
        ).includes('private-message'),
        false,
      );
      finishImmediately = false;
      const pending = await call('post_operations_hosts_by_host_instances_by_instance_jobs', {
        ...arguments_,
        body: { key: 'pending', operation: { action: 'start' } },
      });
      const pendingId = pending.json<{ result: { structuredContent: OperationsJob } }>().result
        .structuredContent.intent.id;
      const cancelled = await call('post_operations_jobs_by_id_cancel', {
        path: { id: pendingId },
      });
      const cancelledJob = cancelled.json<{ result: { structuredContent: OperationsJob } }>().result
        .structuredContent;
      assert.equal(cancelledJob.state, 'cancelled');
      assert.equal(cancelledJob.cancelledBy?.client, agent.clientId);
      const history = await call('get_operations_hosts_by_host_instances_by_instance_jobs', {
        path: arguments_.path,
        query: {},
      });
      assert.equal(
        history.json<{ result: { structuredContent: { jobs: OperationsJob[] } } }>().result
          .structuredContent.jobs.length,
        3,
      );
      const authorizationCount = () =>
        Number(store.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='authorize'").get()?.n);
      const auditedBeforeWatch = authorizationCount();
      const streamed = await call('get_operations_hosts_by_host_instances_by_instance_logs_watch', {
        path: arguments_.path,
        query: {},
      });
      assert.match(streamed.body, /structuredContent/);
      assert.match(streamed.body, /server output/);
      assert.equal(authorizationCount() - auditedBeforeWatch, 1);
      holdWatch = true;
      const streamId = ++id;
      const streaming = await service.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: 'Bearer ' + agent.access_token },
        payloadAsStream: true,
        payload: {
          jsonrpc: '2.0',
          id: streamId,
          method: 'tools/call',
          params: {
            name: 'get_operations_hosts_by_host_instances_by_instance_logs_watch',
            arguments: { path: arguments_.path, query: {} },
            _meta: { progressToken: 'live-logs' },
          },
        },
      });
      const output = streamText(streaming.stream(), 1024 * 1024);
      await service.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: 'Bearer ' + agent.access_token },
        payload: {
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: streamId },
        },
      });
      assert.match(await output, /Request cancelled/);
      await latestAbort;
      const revokedStreamId = ++id;
      const revoking = await service.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: 'Bearer ' + agent.access_token },
        payloadAsStream: true,
        payload: {
          jsonrpc: '2.0',
          id: revokedStreamId,
          method: 'tools/call',
          params: {
            name: 'get_operations_hosts_by_host_instances_by_instance_logs_watch',
            arguments: { path: arguments_.path, query: {} },
            _meta: { progressToken: 'revoking-logs' },
          },
        },
      });
      const revokedOutput = streamText(revoking.stream(), 1024 * 1024);
      await service.requestJson(
        admin,
        'POST',
        '/api/clubs/jlu/members/' + member.user.id + '/revoke',
        {},
        204,
      );
      if (heldOpen) heldController?.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
      assert.match(await revokedOutput, /"isError":true/);
      await latestAbort;
      assert.equal(
        (await call('get_operations_jobs_by_id', { path: { id: intent.id } })).statusCode,
        401,
      );
    } finally {
      store.close();
      await service.close();
      delete process.env.JLU_TEST_OPERATIONS_CREDENTIAL;
    }
  },
);
