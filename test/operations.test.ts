import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, generateKeyPairSync, createHash, sign } from 'node:crypto';
import { isoCBOR, COSEALG } from '@simplewebauthn/server/helpers';
import { join } from 'node:path';
import type {
  OperationsDispatch,
  OperationsOperation,
  OperationsApproval,
  OperationsCancellation,
  OperationsLogPage,
  OperationsJob,
  OperationsSnapshot,
  OperationsTarget,
} from '../shared/contracts/generated.js';
import { streamText } from '../server/streams.js';
import { OPERATIONS_SCOPE_HEADER, OPERATIONS_CLAIM_HEADER } from '../shared/operations.js';
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
      if (url.pathname.endsWith('/backups')) {
        assert.equal(new Headers(init?.headers).get(OPERATIONS_SCOPE_HEADER), 'club:jlu');
        return Response.json({
          backups: [
            {
              id: 'archive-jlu',
              instance: 'survival',
              label: 'consistent world',
              createdAt: now(),
              bytes: 100,
              expandedBytes: 500,
              files: 2,
            },
          ],
        });
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
          ...(dispatch.approval ? { approval: dispatch.approval } : {}),
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
      const reservation = { scope: 'club:jlu', key: 'new-world' };
      await service.requestJson(
        member,
        'POST',
        '/api/operations/hosts/campus/instances',
        reservation,
        403,
      );
      const reserved = await service.requestJson<OperationsTarget>(
        admin,
        'POST',
        '/api/operations/hosts/campus/instances',
        reservation,
      );
      assert.match(reserved.instance, /^[a-f0-9-]{36}$/);
      assert.deepEqual(
        await service.requestJson(
          admin,
          'POST',
          '/api/operations/hosts/campus/instances',
          reservation,
        ),
        reserved,
      );
      await service.requestJson(
        admin,
        'POST',
        '/api/operations/hosts/campus/instances',
        { ...reservation, scope: 'global' },
        409,
      );
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
      const backups = await call('get_operations_hosts_by_host_instances_by_instance_backups', {
        path: arguments_.path,
      });
      assert.equal(
        backups.json<{ result: { structuredContent: { backups: { id: string }[] } } }>().result
          .structuredContent.backups[0]?.id,
        'archive-jlu',
      );
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
      await service.requestJson(admin, 'POST', '/api/identity/grants', {
        account: member.user.id,
        scope: 'club:jlu',
        permission: 'manage',
      });
      async function propose(
        key: string,
        operation: OperationsOperation = { action: 'kill', pid: 42 },
      ) {
        const response = await call('post_operations_hosts_by_host_instances_by_instance_jobs', {
          path: arguments_.path,
          body: { key, operation },
        });
        const review = response.json<{ result: { structuredContent: OperationsApproval } }>().result
          .structuredContent;
        assert.equal(review.status, 'pending', response.body);
        assert.equal(jobs.has(review.id), false);
        return review;
      }
      const changes = [{ path: 'server.properties', text: 'max-players=30' }];
      for (const operation of [
        { action: 'provision', profile: 'paper', autoStart: true, changes },
        { action: 'deploy_prepare', changes },
        { action: 'deploy', preparation: 'denied-stage' },
      ]) {
        await service.requestJson(
          member,
          'POST',
          '/api/operations/hosts/campus/instances/survival/jobs',
          { key: 'no-global-' + operation.action, operation },
          403,
        );
      }
      const infrastructureGrant = await service.requestJson<{ id: string }>(
        admin,
        'POST',
        '/api/identity/grants',
        {
          account: member.user.id,
          scope: 'global',
          permission: 'manage',
        },
      );
      const preparedResponse = await call(
        'post_operations_hosts_by_host_instances_by_instance_jobs',
        {
          path: arguments_.path,
          body: { key: 'prepare-deployment', operation: { action: 'deploy_prepare', changes } },
        },
      );
      const staged = preparedResponse.json<{ result: { structuredContent: OperationsJob } }>()
        .result.structuredContent;
      assert.equal(staged.intent.actor.client, agent.clientId);
      const deployment = await propose('deployment-confirmation', {
        action: 'deploy',
        preparation: staged.intent.id,
      });
      assert.deepEqual(deployment.preparation, staged.intent);
      const deploymentConfirmation = await service.app.inject({
        method: 'POST',
        url: '/api/operations/approvals/' + deployment.id + '/confirm',
        headers: {
          origin: 'https://skin.example.test',
          authorization: 'Bearer ' + member.accessToken,
        },
        payload: { password: 'password-for-contract-testing' },
      });
      assert.equal(deploymentConfirmation.statusCode, 200, deploymentConfirmation.body);
      const deploymentClaim = () =>
        service.app.inject({
          method: 'POST',
          url: '/internal/operations/campus/claim',
          headers: { [OPERATIONS_CLAIM_HEADER]: credential },
          payload: { id: deployment.id },
        });
      assert.equal((await deploymentClaim()).statusCode, 200);
      await service.requestJson(
        admin,
        'DELETE',
        '/api/identity/grants/' + infrastructureGrant.id,
        undefined,
        204,
      );
      assert.equal((await deploymentClaim()).statusCode, 403);
      const proposed = await propose('human-password', {
        action: 'restore',
        archive: 'archive-jlu',
        preparation: 'restore-stage',
      });
      await propose('instance-deletion-confirmation', { action: 'instance_delete' });
      const confirm = '/api/operations/approvals/' + proposed.id + '/confirm';
      const headers = {
        origin: 'https://skin.example.test',
        authorization: 'Bearer ' + member.accessToken,
      };
      assert.equal(
        (
          await service.app.inject({
            method: 'POST',
            url: confirm,
            headers: { ...headers, authorization: 'Bearer ' + agent.access_token },
            payload: { password: 'password-for-contract-testing' },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await service.app.inject({
            method: 'POST',
            url: confirm,
            headers,
            payload: { password: 'incorrect' },
          })
        ).statusCode,
        403,
      );
      assert.equal(jobs.has(proposed.id), false);
      const approved = await service.app.inject({
        method: 'POST',
        url: confirm,
        headers,
        payload: { password: 'password-for-contract-testing' },
      });
      assert.equal(approved.statusCode, 200, approved.body);
      assert.deepEqual(approved.json<OperationsJob>().intent, proposed.intent);
      assert.equal(approved.json<OperationsJob>().approval?.account, member.user.id);
      const claim = () =>
        service.app.inject({
          method: 'POST',
          url: '/internal/operations/campus/claim',
          headers: { [OPERATIONS_CLAIM_HEADER]: credential },
          payload: { id: proposed.id },
        });
      const claimed = await claim();
      assert.equal(claimed.statusCode, 200, claimed.body);
      const passkey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = passkey.publicKey.export({ format: 'jwk' });
      assert.ok(jwk.x && jwk.y);
      const cose = new Map<number, number | Uint8Array<ArrayBuffer>>([
        [1, 2],
        [3, COSEALG.ES256],
        [-1, 1],
        [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
        [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
      ]);
      const credentialId = randomBytes(32).toString('base64url');
      store.db
        .prepare('INSERT INTO passkeys VALUES(?,?,?,?,?,?)')
        .run(credentialId, member.user.id, isoCBOR.encode(cose), 0, 'fixture', now());
      const passkeyReview = await propose('human-passkey');
      const otherReview = await propose('another-request');
      const passkeyPath = '/api/passkeys/operations/' + passkeyReview.id;
      const options = await service.app.inject({
        method: 'POST',
        url: passkeyPath + '/options',
        headers,
        payload: {},
      });
      assert.equal(options.statusCode, 200, options.body);
      let cookie = String(options.headers['set-cookie']).split(';')[0];
      assert.equal(
        (
          await service.app.inject({
            method: 'POST',
            url: '/api/passkeys/operations/' + otherReview.id + '/verify',
            headers: { ...headers, cookie },
            payload: { response: { id: credentialId } },
          })
        ).statusCode,
        403,
      );
      const freshOptions = await service.app.inject({
        method: 'POST',
        url: passkeyPath + '/options',
        headers,
        payload: {},
      });
      assert.equal(freshOptions.statusCode, 200, freshOptions.body);
      cookie = String(freshOptions.headers['set-cookie']).split(';')[0];
      const clientData = Buffer.from(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: freshOptions.json<{ challenge: string }>().challenge,
          origin: headers.origin,
        }),
      );
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(1);
      const authenticatorData = Buffer.concat([
        createHash('sha256').update('skin.example.test').digest(),
        Buffer.from([0x05]),
        counter,
      ]);
      const signature = sign(
        'sha256',
        Buffer.concat([authenticatorData, createHash('sha256').update(clientData).digest()]),
        passkey.privateKey,
      );
      const assertion = {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientData.toString('base64url'),
          authenticatorData: authenticatorData.toString('base64url'),
          signature: signature.toString('base64url'),
          userHandle: Buffer.from(member.user.id).toString('base64url'),
        },
      };
      const verified = await service.app.inject({
        method: 'POST',
        url: passkeyPath + '/verify',
        headers: { ...headers, cookie },
        payload: { response: assertion },
      });
      assert.equal(verified.statusCode, 200, verified.body);
      assert.deepEqual(verified.json<OperationsJob>().intent, passkeyReview.intent);
      assert.equal(
        (
          await service.app.inject({
            method: 'POST',
            url: passkeyPath + '/verify',
            headers: { ...headers, cookie },
            payload: { response: assertion },
          })
        ).statusCode,
        403,
      );
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
      assert.equal((await claim()).statusCode, 403);
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
