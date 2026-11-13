import { authorizeAgent } from './helpers/oauth.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store, now } from '../server/store.js';
import { site, type Login } from './helpers/site.js';
import type {
  ClubReportPolicy,
  IdentitySnapshot,
  OfficeArtifact,
  GrantList,
  ReportPublicationList,
  ReportView,
} from '../shared/contracts/generated.js';

await test('MCP derives its tools from central contracts and completes delegated club reporting through the existing authority', async () => {
  const service = await site();
  const store = new Store(join(service.dir, 'db'));
  try {
    const root = await service.enroll('Admin');
    const chair = await service.enroll('Chair');
    const member = await service.enroll('Member');
    store.db
      .prepare("INSERT INTO grants VALUES('admin','user',?,'global','admin','fixture',?,NULL,NULL)")
      .run(root.user.id, now());
    let id = 0;
    const agentTokens = new Map<Login, string>();
    const rpc = async (login: Login, method: string, params: object = {}) => {
      let access = agentTokens.get(login);
      if (!access) {
        access = (await authorizeAgent(service.app, login.accessToken)).access_token;
        agentTokens.set(login, access);
      }
      return service.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${access}` },
        payload: { jsonrpc: '2.0', id: ++id, method, params },
      });
    };
    const call = async <Result = unknown>(
      login: Login,
      name: string,
      args: object = {},
      isError = false,
    ): Promise<Result> => {
      const response = await rpc(login, 'tools/call', { name, arguments: args });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json<{
        result: { structuredContent: Result; isError?: boolean };
      }>();
      assert.equal(body.result.isError ?? false, isError, response.body);
      return body.result.structuredContent;
    };
    const initialize = await rpc(member, 'initialize', {
      protocolVersion: '2025-11-25',
      clientInfo: { name: 'reporting-agent', version: '1' },
      capabilities: {},
    });
    assert.equal(initialize.statusCode, 200);
    assert.equal(
      initialize.json<{ result: { protocolVersion: string } }>().result.protocolVersion,
      '2025-11-25',
    );
    const listing = await rpc(member, 'tools/list');
    const tools = listing.json<{
      result: { tools: { name: string; inputSchema: object }[] };
    }>().result.tools;
    assert.ok(tools.some((tool) => tool.name === 'post_reports_by_id_actions'));
    assert.ok(tools.some((tool) => tool.name === 'post_events_by_id_games'));
    assert.ok(tools.some((tool) => tool.name === 'post_ai_jobs_by_id_actions'));
    assert.equal(
      tools.some((tool) => /password|recovery_confirm|mcp/.test(tool.name)),
      false,
    );
    const reportTool = tools.find((tool) => tool.name === 'post_reports_by_id_actions')!;
    assert.equal(JSON.stringify(reportTool.inputSchema).includes('$ref'), false);
    const nomination = await call<{ id: string }>(root, 'post_clubs_by_club_successions', {
      path: { club: 'jlu' },
      body: { nominee: chair.user.id },
    });
    await call(chair, 'post_identity_successions_by_id_accept', { path: { id: nomination.id } });
    await call(chair, 'put_clubs_by_id_planning_profile', {
      path: { id: 'jlu' },
      body: { club: 'jlu', kind: 'independent' },
    });
    const artifact = await call<OfficeArtifact>(chair, 'post_artifacts', {
      body: {
        club: 'jlu',
        title: 'MUA annual requirements',
        mime: 'text/markdown',
        content: Buffer.from('Describe club activities.').toString('base64'),
        visibility: 'private',
      },
    });
    await call<ClubReportPolicy>(chair, 'put_clubs_by_id_report_policy', {
      path: { id: 'jlu' },
      body: {
        club: 'jlu',
        mua: { requirements: artifact.id, recipient: 'MUA' },
        annual: null,
      },
    });
    const created = await call<ReportView>(chair, 'post_reports', {
      body: {
        id: 'mcp-report',
        club: 'jlu',
        kind: 'mua_annual',
        periodStartMs: 0,
        periodEndMs: Date.now(),
      },
    });
    await call(member, 'get_reports_by_id', { path: { id: created.report.id } }, true);
    const grant = await call<{ id: string }>(chair, 'post_identity_grants', {
      body: { account: member.user.id, scope: 'report:mcp-report', permission: 'manage' },
    });
    const identity = await call<IdentitySnapshot>(member, 'get_identity');
    assert.ok(identity.grants.some((entry) => entry.scope === 'report:mcp-report'));
    const grants = await call<GrantList>(chair, 'get_identity_grants', {
      query: { scope: 'report:mcp-report' },
    });
    assert.ok(grants.grants.some((entry) => entry.id === grant.id));
    const revised = await call<ReportView>(member, 'post_reports_by_id_actions', {
      path: { id: 'mcp-report' },
      body: { action: 'revise', version: 1, content: 'Annual report from the delegated agent.' },
    });
    assert.equal(revised.report.version, 2);
    await call(member, 'post_reports_by_id_actions', {
      path: { id: 'mcp-report' },
      body: { action: 'publish', version: 2 },
    });
    const published = await call<ReportPublicationList>(root, 'get_reports_public');
    assert.equal(published.reports[0].output, revised.report.output);
    await call(chair, 'delete_identity_grants_by_id', { path: { id: grant.id } });
    await call(
      member,
      'post_reports_by_id_actions',
      {
        path: { id: 'mcp-report' },
        body: { action: 'revise', version: 2, content: 'No longer authorized.' },
      },
      true,
    );
    await call(
      member,
      'get_artifacts_by_id_content',
      { path: { id: created.report.evidence } },
      true,
    );
    const content = await rpc(member, 'tools/call', {
      name: 'get_artifacts_by_id_content',
      arguments: { path: { id: revised.report.output } },
    });
    assert.equal(
      content.json<{ result: { content: { text: string }[] } }>().result.content[0].text,
      'Annual report from the delegated agent.',
    );
    await service.restart();
    assert.equal(
      (await call<ReportView>(chair, 'get_reports_by_id', { path: { id: 'mcp-report' } })).report
        .version,
      2,
    );
    await call(chair, 'post_clubs_by_club_members_by_account_revoke', {
      path: { club: 'jlu', account: member.user.id },
    });
    const revoked = await rpc(member, 'tools/list');
    assert.equal(revoked.statusCode, 401);
    assert.ok(revoked.headers['www-authenticate']);
  } finally {
    store.close();
    await service.close();
  }
});

await test('MCP authenticates notifications and rejects malformed calls and foreign origins before business mutations', async () => {
  const service = await site();
  try {
    const member = await service.enroll('Member');
    const agent = await authorizeAgent(service.app, member.accessToken);
    const inject = (
      payload: unknown,
      authorization = `Bearer ${agent.access_token}`,
      origin?: string,
    ) =>
      service.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization,
          'content-type': 'application/json',
          ...(origin ? { origin } : {}),
        },
        payload: JSON.stringify(payload),
      });
    const message = { jsonrpc: '2.0', id: 1, method: 'ping' };
    assert.equal((await inject(message, '')).statusCode, 401);
    assert.equal((await inject(message, 'Bearer revoked-token')).statusCode, 401);
    assert.equal(
      (await inject(message, undefined, 'https://foreign.example.test')).statusCode,
      403,
    );
    assert.equal((await inject(message, undefined, service.config.origin)).statusCode, 200);
    assert.equal(
      (await inject({ jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode,
      202,
    );
    const notification = await inject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'post_seasons',
        arguments: { body: { id: 'ignored', club: 'jlu', title: 'Ignored' } },
      },
    });
    assert.equal(notification.statusCode, 202);
    const invalidArgs = await inject({
      ...message,
      method: 'tools/call',
      params: {
        name: 'post_reports_by_id_actions',
        arguments: {
          path: { id: 'missing' },
          body: { action: 'revise', version: 1 },
        },
      },
    });
    assert.equal(invalidArgs.statusCode, 200);
    assert.equal(invalidArgs.json<{ error: { code: number } }>().error.code, -32602);
    const unknown = await inject({
      ...message,
      method: 'tools/call',
      params: { name: 'post_mcp' },
    });
    assert.equal(unknown.json<{ error: { code: number } }>().error.code, -32602);
    const method = await inject({ ...message, method: 'resources/list' });
    assert.equal(method.json<{ error: { code: number } }>().error.code, -32601);
    assert.equal((await inject([message, message])).statusCode, 400);
    const seasons = await service.requestJson<{ seasons: unknown[] }>(
      member,
      'GET',
      '/api/seasons',
    );
    assert.deepEqual(seasons.seasons, []);
    assert.equal(
      (
        await service.app.inject({
          method: 'GET',
          url: '/mcp',
          headers: { authorization: `Bearer ${agent.access_token}` },
        })
      ).statusCode,
      405,
    );
  } finally {
    await service.close();
  }
});
