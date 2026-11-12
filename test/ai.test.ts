import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store, now } from '../server/store.js';
import { ACTIVITY_LIMITS } from '../shared/points.js';
import { AI_LIMITS } from '../shared/ai.js';
import { site } from './helpers/site.js';
import type {
  AiJob,
  AiProviderConfig,
  AiPricing,
  MemberPoints,
  OfficeArtifact,
  PointAllowanceList,
} from '../shared/contracts/generated.js';

async function aiSite(
  fetcher: typeof fetch,
  protocols: AiProviderConfig['protocol'][],
  settlement: AiPricing['settlement'],
) {
  process.env.JLU_TEST_AI_KEY = 'fixture-provider-key';
  const service = await site(undefined, undefined, undefined, fetcher);
  const store = new Store(join(service.dir, 'db'));
  try {
    const root = await service.enroll('Admin');
    const host = await service.enroll('Host');
    const member = await service.enroll('Member');
    const stranger = await service.enroll('Stranger');
    store.db
      .prepare("INSERT INTO grants VALUES('admin','user',?,'global','admin','fixture',?,NULL,NULL)")
      .run(root.user.id, now());
    service.config.ai = {
      concurrency: 2,
      providers: protocols.map((protocol) => ({
        id: protocol,
        protocol,
        account: host.user.id,
        url: `https://ai.example.test/${protocol}`,
        keyEnv: 'JLU_TEST_AI_KEY',
        models: ['test-model'],
        capabilities: ['vision', 'pdf'],
        contextTokens: 4096,
      })),
    };
    await service.restart();
    const call = service.requestJson;
    await call(
      root,
      'POST',
      '/api/game-resources',
      {
        id: 'world',
        club: 'jlu',
        title: 'World',
        address: 'game.example.test:25565',
        host: host.user.id,
        scorer: host.user.id,
        automaticTeams: false,
        rules: { crossClub: true, seats: 4, reconnectMinMs: 100, reconnectMaxMs: 1000 },
      },
      204,
    );
    await call(root, 'POST', '/api/points/policy', { dailyMemberCap: '1000' });
    await call(root, 'POST', '/api/activity-sources', {
      id: 'world',
      title: 'World',
      club: 'jlu',
      account: host.user.id,
      resource: 'world',
      weightBps: ACTIVITY_LIMITS.weightDenominator,
      pointsPerSlice: '50',
      maxBonusPerSlice: '0',
      dailySourceCap: '1000',
      enabled: true,
    });
    const evidence = await call<OfficeArtifact>(host, 'POST', '/api/artifacts', {
      club: 'jlu',
      title: 'Telemetry',
      mime: 'application/json',
      content: Buffer.from('{}').toString('base64'),
    });
    const end = Math.floor(Date.now() / ACTIVITY_LIMITS.sliceMs) * ACTIVITY_LIMITS.sliceMs;
    await call(host, 'POST', '/api/points/activity', {
      source: 'world',
      windowStartMs: end - ACTIVITY_LIMITS.sliceMs,
      windowEndMs: end,
      evidence: evidence.id,
      players: { [member.user.id]: { activeSlices: 1, afkSlices: 0, bonusPoints: '0' } },
    });
    const pricing: AiPricing = {
      model: 'test-model',
      basePoints: '2',
      inputPointsPer1k: '3',
      outputPointsPer1k: '5',
      settlement,
    };
    await call(root, 'POST', '/api/ai/pricing', pricing);
    const input = await call<OfficeArtifact>(member, 'POST', '/api/artifacts', {
      club: 'jlu',
      title: 'Private task material',
      mime: 'text/plain',
      content: Buffer.from('Meeting notes from an approved fixture').toString('base64'),
      visibility: 'private',
    });
    const request = {
      input: input.id,
      club: 'jlu',
      model: 'test-model',
      mode: 'generate',
      purpose: 'Summarize this document',
      maxTokens: 1000,
      maxPoints: '17',
    };
    return {
      service,
      store,
      root,
      host,
      member,
      stranger,
      call,
      pricing,
      input,
      request,
      close: async () => {
        store.close();
        await service.close();
        delete process.env.JLU_TEST_AI_KEY;
      },
    };
  } catch (error) {
    store.close();
    await service.close();
    delete process.env.JLU_TEST_AI_KEY;
    throw error;
  }
}

test('AI escrow uses snapshotted pricing and measured usage while keeping private task material private', async () => {
  const requests: { url: string; headers: Headers; body: unknown }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.ok(typeof init?.body === 'string');
    const body: unknown = JSON.parse(init.body);
    requests.push({
      url: url instanceof Request ? url.url : url.toString(),
      headers: new Headers(init?.headers),
      body,
    });
    return Response.json({
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'A summary of the fixture meeting notes.' }],
        },
      ],
      usage: { input_tokens: 3000, output_tokens: 1000, total_tokens: 4000 },
    });
  };
  const fixture = await aiSite(fetcher, ['responses'], 'provider_reward');
  const { service, store, root, host, member, stranger, call, pricing, input, request } = fixture;
  try {
    await call(
      member,
      'POST',
      '/api/ai/jobs',
      { ...request, provider: 'responses', maxPoints: '10' },
      403,
    );
    const job = await call<AiJob>(member, 'POST', '/api/ai/jobs', {
      ...request,
      provider: 'responses',
    });
    assert.equal(job.contextTokens, 4096);
    assert.equal(job.quotePoints, '17');
    assert.equal(job.escrowedPoints, '17');
    const reserved = await call<MemberPoints>(member, 'GET', '/api/points/me');
    assert.equal(reserved.balances[0].available, '33');
    assert.equal(reserved.balances[0].frozen, '17');
    await call(root, 'POST', '/api/ai/pricing', { ...pricing, basePoints: '9' });
    const completed = await call<AiJob>(host, 'POST', `/api/ai/jobs/${job.id}/actions`, {
      action: 'run',
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.escrowedPoints, '0');
    assert.equal(completed.attempts[0].chargedPoints, '16');
    assert.equal(completed.attempts[0].refundedPoints, '1');
    assert.deepEqual(completed.attempts[0].usage, {
      inputTokens: 3000,
      outputTokens: 1000,
      totalTokens: 4000,
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.get('authorization'), 'Bearer fixture-provider-key');
    const responseBody = requests[0].body;
    assert.ok(responseBody !== null && typeof responseBody === 'object' && 'store' in responseBody);
    assert.equal(responseBody.store, false);
    const final = await call<MemberPoints>(member, 'GET', '/api/points/me');
    const provider = await call<MemberPoints>(host, 'GET', '/api/points/me');
    assert.equal(final.balances[0].available, '34');
    assert.equal(final.balances[0].frozen, '0');
    assert.equal(provider.balances[0].available, '16');
    assert.equal(store.db.prepare('SELECT burned FROM ai_totals WHERE id=1').get()!.burned, '0');
    const output = await service.app.inject({
      url: `/api/artifacts/${completed.attempts[0].output}/content`,
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    assert.equal(output.statusCode, 200);
    assert.equal(output.body, 'A summary of the fixture meeting notes.');
    await call(stranger, 'GET', `/api/ai/jobs/${job.id}`, undefined, 403);
    await call(stranger, 'GET', `/api/artifacts/${input.id}/content`, undefined, 403);
    await call(
      stranger,
      'GET',
      `/api/artifacts/${completed.attempts[0].output}/content`,
      undefined,
      403,
    );
    const revision = await call<OfficeArtifact>(member, 'POST', '/api/artifacts', {
      club: 'jlu',
      title: 'Updated private notes',
      mime: 'text/plain',
      content: Buffer.from('Updated private material').toString('base64'),
      parent: input.id,
    });
    assert.equal(revision.visibility, 'private');
    await call(stranger, 'GET', `/api/artifacts/${revision.id}/content`, undefined, 403);
  } finally {
    await fixture.close();
  }
});

test('AI cancellation fences late output, preserves revoked budgets, and explicit timeouts refund held points', async (context) => {
  let begin!: () => void;
  let respond!: (response: Response) => void;
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const pending = new Promise<Response>((resolve) => {
    respond = resolve;
  });
  const requests: { url: string; headers: Headers; body: unknown }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const address = url instanceof Request ? url.url : url.toString();
    assert.ok(typeof init?.body === 'string');
    const body: unknown = JSON.parse(init.body);
    requests.push({
      url: address,
      headers: new Headers(init?.headers),
      body,
    });
    if (address.endsWith('/messages')) {
      begin();
      return pending;
    }
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              decision: 'approve',
              summary: 'Fixture reviewed',
              issues: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });
  };
  const fixture = await aiSite(fetcher, ['messages', 'chat_completions'], 'burn');
  const { store, root, member, call, request } = fixture;
  try {
    const time = Date.now();
    await call(root, 'POST', '/api/events', {
      id: 'meeting',
      club: 'jlu',
      title: 'Meeting',
      brief: (
        await call<OfficeArtifact>(root, 'POST', '/api/artifacts', {
          club: 'jlu',
          title: 'Event brief',
          mime: 'text/plain',
          content: Buffer.from('Event brief').toString('base64'),
        })
      ).id,
      coOrganizers: [],
      window: { opensMs: time - 1000, closesMs: time + 10000, startsMs: time + 20000 },
      checkinOpensMs: time + 10000,
      checkinClosesMs: time + 19000,
      endsMs: time + 30000,
    });
    await call(root, 'POST', '/api/identity/grants', {
      account: member.user.id,
      scope: 'event:meeting',
      permission: 'manage',
    });
    await call(member, 'POST', '/api/points/allowances', {
      scope: 'event:meeting',
      club: 'jlu',
      budget: '20',
    });
    const pdf = await call<OfficeArtifact>(member, 'POST', '/api/artifacts', {
      club: 'jlu',
      title: 'Evidence PDF',
      mime: 'application/pdf',
      content: Buffer.from('%PDF fixture evidence').toString('base64'),
      visibility: 'private',
    });
    const job = await call<AiJob>(member, 'POST', '/api/ai/jobs', {
      ...request,
      provider: 'messages',
      attachments: [pdf.id],
      scope: 'event:meeting',
    });
    const running = call<AiJob>(member, 'POST', `/api/ai/jobs/${job.id}/actions`, {
      action: 'run',
    });
    await Promise.race([
      started,
      running.then(() => assert.fail('AI execution completed before the provider replied')),
    ]);
    await call(member, 'POST', '/api/points/allowances', {
      scope: 'event:meeting',
      club: 'jlu',
      budget: '0',
    });
    const cancelled = await call<AiJob>(member, 'POST', `/api/ai/jobs/${job.id}/actions`, {
      action: 'cancel',
    });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.escrowedPoints, '17');
    respond(
      Response.json({
        content: [{ type: 'text', text: 'A late fixture output' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    );
    const late = await running;
    assert.equal(late.status, 'cancelled');
    assert.equal(late.attempts[0].output, null);
    assert.equal(late.attempts[0].chargedPoints, '3');
    assert.equal(late.attempts[0].refundedPoints, '14');
    assert.equal(
      (await call<PointAllowanceList>(member, 'GET', '/api/points/allowances')).allowances[0]
        .remaining,
      '0',
    );
    assert.equal(requests[0].headers.get('x-api-key'), 'fixture-provider-key');
    const messageBody = requests[0].body;
    assert.ok(messageBody !== null && typeof messageBody === 'object' && 'messages' in messageBody);
    const messages = messageBody.messages as {
      content: { type: string; source?: { media_type: string } }[];
    }[];
    assert.equal(
      messages[0].content.find((block) => block.type === 'document')?.source?.media_type,
      'application/pdf',
    );
    const review = await call<AiJob>(member, 'POST', '/api/ai/jobs', {
      ...request,
      provider: 'chat_completions',
      mode: 'review',
    });
    const reviewed = await call<AiJob>(member, 'POST', `/api/ai/jobs/${review.id}/actions`, {
      action: 'run',
    });
    assert.equal(reviewed.status, 'completed');
    assert.equal(reviewed.attempts[0].chargedPoints, '3');
    assert.equal(store.db.prepare('SELECT burned FROM ai_totals WHERE id=1').get()!.burned, '6');
    let currentTime = Date.now();
    context.mock.method(Date, 'now', () => currentTime);
    await call(member, 'POST', '/api/points/allowances', {
      scope: 'event:meeting',
      club: 'jlu',
      budget: '20',
    });
    const timed = await call<AiJob>(member, 'POST', '/api/ai/jobs', {
      ...request,
      provider: 'chat_completions',
      scope: 'event:meeting',
    });
    await call(member, 'POST', '/api/points/allowances', {
      scope: 'event:meeting',
      club: 'jlu',
      budget: '0',
    });
    currentTime += AI_LIMITS.jobTimeoutMs + 1;
    const expired = await call<AiJob>(member, 'POST', `/api/ai/jobs/${timed.id}/actions`, {
      action: 'poke',
    });
    assert.equal(expired.status, 'failed');
    assert.equal(expired.escrowedPoints, '0');
    await call(member, 'POST', `/api/ai/jobs/${timed.id}/actions`, { action: 'retry' }, 403);
    assert.equal((await call<AiJob>(member, 'GET', `/api/ai/jobs/${timed.id}`)).attempts.length, 1);
    const overview = await call<MemberPoints>(member, 'GET', '/api/points/me');
    assert.equal(overview.balances[0].available, '44');
    assert.equal(overview.balances[0].frozen, '0');
    assert.equal(
      (await call<PointAllowanceList>(member, 'GET', '/api/points/allowances')).allowances[0]
        .remaining,
      '0',
    );
    assert.equal(requests.length, 2);
  } finally {
    await fixture.close();
  }
});
