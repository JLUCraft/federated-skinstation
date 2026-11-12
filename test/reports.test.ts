import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store, now } from '../server/store.js';
import { PointLedger } from '../server/points.js';
import { site, type Login } from './helpers/site.js';
import type {
  ActivityDraft,
  ActivityPlan,
  ApprovalInstance,
  AiJob,
  ClubReportPolicy,
  OfficeArtifact,
  OfficeAiTaskView,
  PointAllowanceList,
  ReportView,
  ReportPublicationList,
  ReportGenerationRequest,
} from '../shared/contracts/generated.js';

const MODEL = 'report-model';
const REQUIREMENTS_IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
  'base64',
);

function response(content: string) {
  return Response.json({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function reportingSite(fetcher: typeof fetch) {
  process.env.JLU_TEST_REPORT_KEY = 'report-provider-fixture';
  const service = await site(undefined, undefined, undefined, fetcher);
  const store = new Store(join(service.dir, 'db'));
  try {
    const root = await service.enroll('Admin');
    const chair = await service.enroll('Chair');
    const provider = await service.enroll('Provider');
    const member = await service.enroll('Member');
    const coChair = await service.enroll('OtherChair');
    const call = service.requestJson;
    store.db
      .prepare("INSERT INTO grants VALUES('admin','user',?,'global','admin','fixture',?,NULL,NULL)")
      .run(root.user.id, now());
    store.db.prepare("INSERT INTO clubs VALUES('other','Other','school','other')").run();
    store.db
      .prepare("UPDATE memberships SET status='revoked',revoked_at=? WHERE account=?")
      .run(now(), coChair.user.id);
    store.db
      .prepare("INSERT INTO memberships VALUES(?,'other','active','import','[]',?,NULL)")
      .run(coChair.user.id, now());
    for (const [club, manager] of [
      ['jlu', chair],
      ['other', coChair],
    ] as const) {
      const succession = await call<{ id: string }>(
        root,
        'POST',
        `/api/clubs/${club}/successions`,
        { nominee: manager.user.id },
      );
      await call(manager, 'POST', `/api/identity/successions/${succession.id}/accept`, {}, 204);
      await call(manager, 'PUT', `/api/clubs/${club}/planning-profile`, { club, kind: 'official' });
    }
    service.config.ai = {
      concurrency: 4,
      providers: [
        {
          id: 'reports',
          account: provider.user.id,
          protocol: 'chat_completions',
          url: 'https://ai.example.test/reports',
          keyEnv: 'JLU_TEST_REPORT_KEY',
          models: [MODEL],
          capabilities: ['vision'],
          contextTokens: 4096,
        },
      ],
    };
    await service.restart();
    await call(root, 'POST', '/api/ai/pricing', {
      model: MODEL,
      basePoints: '1',
      inputPointsPer1k: '0',
      outputPointsPer1k: '0',
      settlement: 'provider_reward',
    });
    const ledger = new PointLedger(store);
    store.transaction(() => {
      ledger.adjust(chair.user.id, 'jlu', 30n, 'fixture', 'chair');
      ledger.adjust(root.user.id, 'jlu', 10n, 'fixture', 'root');
    });
    const upload = (
      login: Login,
      club: string,
      title: string,
      visibility: 'private' | 'club' = 'private',
    ) =>
      call<OfficeArtifact>(login, 'POST', '/api/artifacts', {
        club,
        title,
        mime: 'text/markdown',
        content: Buffer.from(title).toString('base64'),
        visibility,
      });
    const image = await call<OfficeArtifact>(chair, 'POST', '/api/artifacts', {
      club: 'jlu',
      title: 'MUA requirements',
      mime: 'image/png',
      content: REQUIREMENTS_IMAGE.toString('base64'),
      visibility: 'private',
    });
    const annual = await upload(chair, 'jlu', 'School annual requirements');
    const policy = await call<ClubReportPolicy>(chair, 'PUT', '/api/clubs/jlu/report-policy', {
      club: 'jlu',
      mua: { requirements: image.id, recipient: 'MUA' },
      annual: { requirements: annual.id, recipient: 'Jilin University' },
    });
    return {
      service,
      store,
      call,
      root,
      chair,
      provider,
      member,
      coChair,
      ledger,
      upload,
      policy,
      image,
      close: async () => {
        store.close();
        await service.close();
        delete process.env.JLU_TEST_REPORT_KEY;
      },
    };
  } catch (error) {
    store.close();
    await service.close();
    delete process.env.JLU_TEST_REPORT_KEY;
    throw error;
  }
}

test('annual reporting freezes public activity evidence and own-club outcomes, then generates, revises and publishes independent report versions', async (context) => {
  let completion = 'Public activity summary.';
  const requests: string[] = [];
  const fixture = await reportingSite(async (_url, init) => {
    assert.ok(typeof init?.body === 'string');
    requests.push(init.body);
    return response(completion);
  });
  const { service, call, root, chair, provider, member, coChair, ledger, upload, policy } = fixture;
  try {
    let time = Date.now();
    const base = time;
    context.mock.method(Date, 'now', () => time);
    assert.notEqual(policy.mua.requirements, fixture.image.id);
    await call(member, 'GET', '/api/clubs/jlu/report-policy', undefined, 403);
    const brief = await upload(chair, 'jlu', 'Original meeting agenda', 'club');
    const draft: ActivityDraft = {
      id: 'reported-meeting',
      club: 'jlu',
      title: 'Joint meeting',
      brief: brief.id,
      coOrganizers: ['other'],
      window: { opensMs: base - 1000, closesMs: base + 10000, startsMs: base + 20000 },
      checkinOpensMs: base + 10000,
      checkinClosesMs: base + 19000,
      endsMs: base + 30000,
    };
    await call(chair, 'POST', '/api/events', draft);
    const plan = await call<ActivityPlan>(chair, 'PUT', `/api/events/${draft.id}/plan`, {
      epoch: 1,
      kind: 'meeting',
      candidates: [],
      clubs: [
        { club: 'jlu', kind: 'official', participants: [member.user.id] },
        { club: 'other', kind: 'official', participants: [coChair.user.id] },
      ],
    });
    for (const [club, manager] of [
      ['jlu', chair],
      ['other', coChair],
    ] as const) {
      const opinion = await upload(manager, club, `${club}-private-opinion`);
      const consent = await upload(manager, club, `${club}-private-consent`);
      await call(manager, 'POST', `/api/events/${draft.id}/plan/actions`, {
        action: 'opinion',
        plan: plan.id,
        club,
        document: opinion.id,
        games: [],
      });
      await call(manager, 'POST', `/api/events/${draft.id}/plan/actions`, {
        action: 'consent',
        plan: plan.id,
        club,
        document: consent.id,
        transcript: null,
      });
      await call(manager, 'POST', `/api/events/${draft.id}/plan/actions`, {
        action: 'rewards',
        plan: plan.id,
        club,
        rule: { points: '2', material: null, topPlaces: null },
      });
    }
    await call(chair, 'POST', `/api/events/${draft.id}/plan/actions`, {
      action: 'finalize',
      plan: plan.id,
      selected: [],
    });
    const polished = await upload(chair, 'jlu', 'Approved public agenda', 'club');
    await call(chair, 'POST', `/api/events/${draft.id}/plan/actions`, {
      action: 'polish',
      plan: plan.id,
      document: polished.id,
    });
    await call(chair, 'POST', `/api/events/${draft.id}/actions`, { action: 'submit' });
    const workflow = await call<ApprovalInstance>(chair, 'POST', '/api/workflows', {
      event: draft.id,
      epoch: 1,
    });
    for (const [club, manager] of [
      ['jlu', chair],
      ['other', coChair],
    ] as const)
      await call(manager, 'POST', `/api/workflows/${workflow.id}/actions`, {
        action: 'approve',
        club,
        comment: 'Club consent',
      });
    await call(chair, 'POST', `/api/workflows/${workflow.id}/actions`, { action: 'execute' });
    await call(chair, 'POST', `/api/events/${draft.id}/actions`, { action: 'publish' });
    for (const login of [member, coChair])
      await call(login, 'POST', `/api/events/${draft.id}/actions`, { action: 'signup' });
    await call(chair, 'POST', `/api/events/${draft.id}/tasks`, {
      id: 'minutes',
      title: 'Write minutes',
      dueMs: base + 25000,
    });
    await call(chair, 'POST', '/api/tasks/minutes/actions', {
      action: 'assign',
      account: member.user.id,
    });
    for (const [id, assignee] of [
      ['organizing', chair],
      ['other-club-task', coChair],
    ] as const) {
      await call(chair, 'POST', `/api/events/${draft.id}/tasks`, { id, title: id, dueMs: null });
      await call(chair, 'POST', `/api/tasks/${id}/actions`, {
        action: 'assign',
        account: assignee.user.id,
      });
      await call(assignee, 'POST', `/api/tasks/${id}/actions`, { action: 'complete' });
    }
    time = base + 11000;
    for (const login of [member, coChair])
      await call(login, 'POST', `/api/events/${draft.id}/actions`, { action: 'checkin' });
    await call(member, 'POST', '/api/tasks/minutes/actions', { action: 'complete' });
    time = base + 40000;
    await call(chair, 'POST', `/api/events/${draft.id}/actions`, { action: 'finish' });
    await call(chair, 'POST', `/api/events/${draft.id}/rewards`, { plan: plan.id });
    await call(chair, 'POST', '/api/points/allowances', {
      scope: `event:${draft.id}`,
      club: 'jlu',
      budget: '5',
    });
    const summary = await call<OfficeAiTaskView>(
      chair,
      'POST',
      `/api/events/${draft.id}/documents`,
      {
        kind: 'summary',
        plan: plan.id,
        model: MODEL,
        maxTokens: 256,
        maxPoints: '1',
      },
    );
    await call(provider, 'POST', `/api/ai/jobs/${summary.job.id}/actions`, { action: 'run' });
    await call(chair, 'POST', `/api/document-tasks/${summary.task.id}/actions`, {
      action: 'apply',
    });
    const reportInput = { club: 'jlu', kind: 'mua_annual', periodStartMs: base, periodEndMs: time };
    const before = await call<ReportView>(chair, 'POST', '/api/reports', {
      ...reportInput,
      id: 'before-publication',
    });
    const download = (login: Login, artifact: string) =>
      service.app.inject({
        url: `/api/artifacts/${artifact}/content`,
        headers: { authorization: `Bearer ${login.accessToken}` },
      });
    assert.equal(
      (await download(chair, before.report.evidence)).json<{ activities: { summary: unknown }[] }>()
        .activities[0].summary,
      null,
    );
    await call(chair, 'POST', `/api/document-tasks/${summary.task.id}/actions`, {
      action: 'publish',
    });
    const created = await call<ReportView>(chair, 'POST', '/api/reports', {
      ...reportInput,
      id: 'mua-report',
    });
    const evidence = (await download(chair, created.report.evidence)).json<{
      activities: {
        brief: { text: string };
        summary: { text: string };
        attendance: { account: string }[];
        awards: { points: string }[];
        tasks: { id: string; done: number }[];
      }[];
    }>();
    assert.equal(evidence.activities[0].brief.text, 'Approved public agenda');
    assert.equal(evidence.activities[0].summary.text, 'Public activity summary.');
    assert.deepEqual(
      evidence.activities[0].attendance.map((entry) => entry.account),
      [member.user.id],
    );
    assert.equal(evidence.activities[0].awards[0].points, '2');
    assert.equal(evidence.activities[0].tasks[0].done, 1);
    assert.deepEqual(
      evidence.activities[0].tasks.map((task) => task.id),
      ['minutes', 'organizing'],
    );
    assert.equal(JSON.stringify(evidence).includes(coChair.user.id), false);
    assert.equal(JSON.stringify(evidence).includes('private-consent'), false);
    assert.equal(JSON.stringify(evidence).includes('private-opinion'), false);
    await call(coChair, 'GET', '/api/reports/mua-report', undefined, 403);
    assert.equal((await download(member, created.report.evidence)).statusCode, 403);
    const generation: ReportGenerationRequest = {
      version: 1,
      model: MODEL,
      maxTokens: 256,
      maxPoints: '1',
    };
    await call(chair, 'POST', '/api/points/allowances', {
      scope: 'report:mua-report',
      club: 'jlu',
      budget: '5',
    });
    completion = 'First published MUA report.';
    const generating = await call<ReportView>(
      chair,
      'POST',
      '/api/reports/mua-report/generate',
      generation,
    );
    assert.ok(generating.job);
    assert.equal(
      (await call<ReportView>(chair, 'POST', '/api/reports/mua-report/generate', generation)).job
        ?.id,
      generating.job.id,
    );
    await call(provider, 'POST', `/api/ai/jobs/${generating.job.id}/actions`, { action: 'run' });
    assert.ok(requests[1].includes(REQUIREMENTS_IMAGE.toString('base64')));
    assert.equal(requests[1].includes('Approved public agenda'), true);
    assert.equal(requests[1].includes('private-consent'), false);
    const applied = await call<ReportView>(chair, 'POST', '/api/reports/mua-report/actions', {
      action: 'apply',
      version: 1,
    });
    assert.ok(applied.report.output);
    assert.equal((await download(member, applied.report.output)).statusCode, 403);
    assert.deepEqual(
      (await call<ReportPublicationList>(member, 'GET', '/api/reports/public')).reports,
      [],
    );
    await call(chair, 'POST', '/api/reports/mua-report/actions', { action: 'publish', version: 1 });
    await call(chair, 'POST', '/api/reports/mua-report/actions', { action: 'publish', version: 1 });
    assert.equal((await download(coChair, applied.report.output)).body, completion);
    const revised = await call<ReportView>(chair, 'POST', '/api/reports/mua-report/actions', {
      action: 'revise',
      version: 1,
      content: 'Revised MUA report.',
    });
    assert.equal(revised.report.version, 2);
    assert.ok(revised.report.output);
    assert.equal((await download(member, revised.report.output)).statusCode, 403);
    assert.equal((await download(member, applied.report.output)).body, completion);
    await call(
      chair,
      'POST',
      '/api/reports/mua-report/actions',
      { action: 'publish', version: 1 },
      403,
    );
    await call(chair, 'POST', '/api/reports/mua-report/actions', { action: 'publish', version: 2 });
    const publications = await call<ReportPublicationList>(member, 'GET', '/api/reports/public');
    assert.deepEqual(
      publications.reports.map((report) => report.version),
      [2, 1],
    );
    assert.equal(JSON.stringify(publications).includes(created.report.evidence), false);
    await call(root, 'POST', '/api/reports', {
      ...reportInput,
      id: 'school-review',
      kind: 'club_annual_review',
    });
    await service.restart();
    assert.equal(
      (await call<ReportView>(chair, 'GET', '/api/reports/mua-report')).report.version,
      2,
    );
    assert.equal(ledger.balance(chair.user.id, 'jlu'), 28n);
    assert.equal(ledger.balance(provider.user.id, 'jlu'), 2n);
    assert.equal(ledger.balance(member.user.id, 'jlu'), 2n);
    const allowances = await call<PointAllowanceList>(chair, 'GET', '/api/points/allowances');
    assert.equal(
      allowances.allowances.find((allowance) => allowance.scope === 'report:mua-report')?.remaining,
      '4',
    );
  } finally {
    await fixture.close();
  }
});

test('report revisions supersede running and queued jobs while current managers retain budget control and private evidence access', async (context) => {
  const started = deferred<void>();
  const pending = deferred<Response>();
  const fixture = await reportingSite(async () => {
    started.resolve();
    return pending.promise;
  });
  const { service, store, call, root, chair, provider, member, ledger } = fixture;
  try {
    const time = Date.now();
    context.mock.method(Date, 'now', () => time);
    await call(chair, 'PUT', '/api/clubs/jlu/planning-profile', {
      club: 'jlu',
      kind: 'independent',
    });
    const draft = {
      id: 'revision',
      club: 'jlu',
      kind: 'mua_annual',
      periodStartMs: time - 1000,
      periodEndMs: time,
    };
    await call(
      chair,
      'POST',
      '/api/reports',
      { ...draft, id: 'forbidden-school', kind: 'club_annual_review' },
      403,
    );
    const created = await call<ReportView>(chair, 'POST', '/api/reports', draft);
    const grant = await call<{ id: string }>(chair, 'POST', '/api/identity/grants', {
      account: member.user.id,
      scope: 'report:revision',
      permission: 'manage',
    });
    await call(chair, 'POST', '/api/points/allowances', {
      scope: 'report:revision',
      club: 'jlu',
      budget: '5',
    });
    const generated = await call<ReportView>(member, 'POST', '/api/reports/revision/generate', {
      version: 1,
      model: MODEL,
      maxTokens: 256,
      maxPoints: '1',
    });
    assert.ok(generated.job);
    const running = call<AiJob>(provider, 'POST', `/api/ai/jobs/${generated.job.id}/actions`, {
      action: 'run',
    });
    await started.promise;
    await call(chair, 'DELETE', `/api/identity/grants/${grant.id}`, undefined, 204);
    const succession = await call<{ id: string }>(chair, 'POST', '/api/clubs/jlu/successions', {
      nominee: root.user.id,
    });
    await call(root, 'POST', `/api/identity/successions/${succession.id}/accept`, {}, 204);
    await call(root, 'POST', '/api/points/allowances', {
      scope: 'report:revision',
      club: 'jlu',
      budget: '5',
    });
    const revised = await call<ReportView>(root, 'POST', '/api/reports/revision/actions', {
      action: 'revise',
      version: 1,
      content: 'Human report supersedes in-flight generation.',
    });
    assert.equal(revised.report.version, 2);
    await call(root, 'POST', '/api/reports/revision/actions', { action: 'publish', version: 2 });
    pending.resolve(response('Obsolete private generated text.'));
    const completed = await running;
    assert.equal(completed.status, 'completed');
    const output = completed.attempts.at(-1)?.output;
    assert.ok(output);
    for (const login of [chair, member]) {
      await call(login, 'GET', `/api/artifacts/${output}/content`, undefined, 403);
      await call(login, 'GET', `/api/artifacts/${created.report.evidence}/content`, undefined, 403);
    }
    await call(root, 'POST', '/api/reports/revision/actions', { action: 'apply', version: 1 }, 403);
    assert.equal(
      (await call<ReportView>(root, 'GET', '/api/reports/revision')).report.output,
      revised.report.output,
    );
    assert.equal(ledger.balance(chair.user.id, 'jlu'), 29n);
    assert.equal(ledger.balance(provider.user.id, 'jlu'), 1n);
    const queued = await call<ReportView>(root, 'POST', '/api/reports/revision/generate', {
      version: 2,
      model: MODEL,
      maxTokens: 256,
      maxPoints: '1',
    });
    assert.equal(queued.report.version, 3);
    assert.ok(queued.job);
    await call(root, 'POST', '/api/reports/revision/actions', {
      action: 'revise',
      version: 3,
      content: 'Latest human revision.',
    });
    await call(provider, 'POST', `/api/ai/jobs/${queued.job.id}/actions`, { action: 'run' }, 403);
    await call(root, 'POST', `/api/ai/jobs/${queued.job.id}/actions`, { action: 'cancel' });
    assert.equal(ledger.balance(root.user.id, 'jlu'), 10n);
    assert.equal(
      (await call<PointAllowanceList>(root, 'GET', '/api/points/allowances')).allowances[0]
        .remaining,
      '5',
    );
    const delegated = await call<{ id: string }>(root, 'POST', '/api/identity/grants', {
      account: member.user.id,
      scope: 'report:revision',
      permission: 'manage',
    });
    await call(root, 'POST', `/api/clubs/jlu/members/${member.user.id}/revoke`, {}, 204);
    assert.ok(
      store.db.prepare('SELECT revoked_at FROM grants WHERE id=?').get(delegated.id)?.revoked_at,
    );
    await service.restart();
    assert.equal((await call<ReportView>(root, 'GET', '/api/reports/revision')).report.version, 4);
  } finally {
    pending.resolve(response('Fixture complete.'));
    await fixture.close();
  }
});
