import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store, now } from '../server/store.js';
import { PointLedger } from '../server/points.js';
import { site, type Login } from './helpers/site.js';
import type {
  ActivityDraft,
  ActivityPlan,
  ActivityRecord,
  ApprovalInstance,
  ApprovalList,
  ApprovalStage,
  AiJob,
  OfficeArtifact,
  OfficeAiTaskView,
  PointAllowanceList,
} from '../shared/contracts/generated.js';

const MODEL = 'office-model';
const OUTPUT_TOKENS = 256;
const JOB_COST = '1';
const CONSENT_IMAGE = Buffer.from(
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

async function officeSite(fetcher: typeof fetch) {
  process.env.JLU_TEST_OFFICE_AI_KEY = 'office-provider-fixture';
  const service = await site(undefined, undefined, undefined, fetcher);
  const store = new Store(join(service.dir, 'db'));
  try {
    const root = await service.enroll('Admin');
    const chair = await service.enroll('Chair');
    const provider = await service.enroll('Provider');
    const member = await service.enroll('Member');
    const stranger = await service.enroll('Stranger');
    const call = service.requestJson;
    store.db
      .prepare("INSERT INTO grants VALUES('admin','user',?,'global','admin','fixture',?,NULL,NULL)")
      .run(root.user.id, now());
    const succession = await call<{ id: string }>(root, 'POST', '/api/clubs/jlu/successions', {
      nominee: chair.user.id,
    });
    await call(chair, 'POST', `/api/identity/successions/${succession.id}/accept`, {}, 204);
    service.config.ai = {
      concurrency: 4,
      providers: [
        {
          id: 'office-provider',
          account: provider.user.id,
          protocol: 'chat_completions',
          url: 'https://ai.example.test/office',
          keyEnv: 'JLU_TEST_OFFICE_AI_KEY',
          models: [MODEL],
          capabilities: ['vision'],
          contextTokens: 4096,
        },
      ],
    };
    await service.restart();
    const ledger = new PointLedger(store);
    store.transaction(() => ledger.adjust(chair.user.id, 'jlu', 20n, 'fixture', 'opening'));
    await call(root, 'POST', '/api/ai/pricing', {
      model: MODEL,
      basePoints: JOB_COST,
      inputPointsPer1k: '0',
      outputPointsPer1k: '0',
      settlement: 'provider_reward',
    });
    await call(chair, 'PUT', '/api/clubs/jlu/planning-profile', { club: 'jlu', kind: 'official' });
    const upload = (
      title: string,
      mime: 'text/markdown' | 'image/png',
      content: Buffer,
      visibility: 'private' | 'club',
      owner: Login = chair,
    ) =>
      call<OfficeArtifact>(owner, 'POST', '/api/artifacts', {
        club: 'jlu',
        title,
        mime,
        content: content.toString('base64'),
        visibility,
      });
    const brief = await upload(
      'Meeting plan',
      'text/markdown',
      Buffer.from('Meeting agenda'),
      'club',
    );
    const consent = await upload('Original consent', 'image/png', CONSENT_IMAGE, 'private');
    const transcript = await upload(
      'Consent transcript',
      'text/markdown',
      Buffer.from('Signed private transcript'),
      'private',
    );
    const plan = async (draft: ActivityDraft, epoch: number, manager: Login = chair) => {
      const current = await call<ActivityPlan>(root, 'PUT', `/api/events/${draft.id}/plan`, {
        epoch,
        kind: 'meeting',
        candidates: [],
        clubs: [{ club: 'jlu', kind: 'official', participants: [member.user.id] }],
      });
      await call(root, 'POST', `/api/events/${draft.id}/plan/actions`, {
        action: 'rewards',
        plan: current.id,
        club: 'jlu',
        rule: { points: '5', material: null, topPlaces: null },
      });
      const original =
        manager === chair
          ? consent
          : await upload('Current consent', 'image/png', CONSENT_IMAGE, 'private', manager);
      const text =
        manager === chair
          ? transcript
          : await upload(
              'Current transcript',
              'text/markdown',
              Buffer.from('Signed current transcript'),
              'private',
              manager,
            );
      await call(manager, 'POST', `/api/events/${draft.id}/plan/actions`, {
        action: 'consent',
        plan: current.id,
        club: 'jlu',
        document: original.id,
        transcript: text.id,
      });
      return call<ActivityPlan>(root, 'POST', `/api/events/${draft.id}/plan/actions`, {
        action: 'finalize',
        plan: current.id,
        selected: [],
      });
    };
    const create = async (id: string, base: number) => {
      const draft: ActivityDraft = {
        id,
        club: 'jlu',
        title: id,
        brief: brief.id,
        coOrganizers: [],
        window: { opensMs: base - 1000, closesMs: base + 10000, startsMs: base + 20000 },
        checkinOpensMs: base + 10000,
        checkinClosesMs: base + 19000,
        endsMs: base + 30000,
      };
      await call(chair, 'POST', '/api/events', draft);
      const current = await plan(draft, 1);
      await call(chair, 'POST', '/api/points/allowances', {
        scope: `event:${id}`,
        club: 'jlu',
        budget: '10',
      });
      return { draft, plan: current };
    };
    const stage: ApprovalStage = {
      name: 'AI document review',
      approver: {
        kind: 'ai',
        model: MODEL,
        purpose: 'Review the supplied activity plan and consent evidence.',
        maxTokens: OUTPUT_TOKENS,
        maxPoints: JOB_COST,
      },
      timeoutMs: 5000,
      onTimeout: 'reject',
    };
    const workflow = async (id: string, epoch: number) => {
      await call(root, 'POST', '/api/approval-templates', {
        id: 'ai-review',
        club: 'jlu',
        name: 'AI and chair',
        active: true,
        stages: [stage],
      });
      await call(root, 'POST', `/api/events/${id}/actions`, { action: 'submit' });
      return call<ApprovalInstance>(root, 'POST', '/api/workflows', {
        event: id,
        epoch,
        template: 'ai-review',
      });
    };
    return {
      service,
      store,
      ledger,
      root,
      chair,
      provider,
      member,
      stranger,
      call,
      brief,
      consent,
      transcript,
      create,
      plan,
      stage,
      workflow,
      close: async () => {
        store.close();
        await service.close();
        delete process.env.JLU_TEST_OFFICE_AI_KEY;
      },
    };
  } catch (error) {
    store.close();
    await service.close();
    delete process.env.JLU_TEST_OFFICE_AI_KEY;
    throw error;
  }
}

await test('event documents share point escrow and private source evidence from polishing through AI and chair approval to a published summary', async (context) => {
  let completion = 'Generated public meeting brief.';
  const requests: string[] = [];
  const fixture = await officeSite(async (_url, init) => {
    assert.ok(typeof init?.body === 'string');
    requests.push(init.body);
    return response(completion);
  });
  const { service, chair, provider, member, stranger, call, ledger } = fixture;
  try {
    let time = Date.now();
    const base = time;
    context.mock.method(Date, 'now', () => time);
    const event = await fixture.create('documents', base);
    const request = {
      kind: 'polish',
      plan: event.plan.id,
      model: MODEL,
      maxTokens: OUTPUT_TOKENS,
      maxPoints: JOB_COST,
    };
    const polishing = await call<OfficeAiTaskView>(
      chair,
      'POST',
      '/api/events/documents/documents',
      request,
    );
    assert.equal(
      (await call<OfficeAiTaskView>(chair, 'POST', '/api/events/documents/documents', request)).task
        .id,
      polishing.task.id,
    );
    await call(
      chair,
      'POST',
      `/api/document-tasks/${polishing.task.id}/actions`,
      { action: 'apply' },
      403,
    );
    await call(stranger, 'GET', `/api/document-tasks/${polishing.task.id}`, undefined, 403);
    const generated = await call<AiJob>(
      provider,
      'POST',
      `/api/ai/jobs/${polishing.job.id}/actions`,
      { action: 'run' },
    );
    const generatedOutput = generated.attempts.at(-1)?.output;
    assert.ok(generatedOutput);
    await call(
      chair,
      'POST',
      '/api/events/documents/plan/actions',
      {
        action: 'polish',
        plan: event.plan.id,
        document: generatedOutput,
      },
      403,
    );
    const polished = await call<OfficeAiTaskView>(
      chair,
      'POST',
      `/api/document-tasks/${polishing.task.id}/actions`,
      { action: 'apply' },
    );
    assert.ok(polished.task.output);
    await call(chair, 'POST', `/api/document-tasks/${polishing.task.id}/actions`, {
      action: 'apply',
    });
    assert.ok(requests[0].includes(CONSENT_IMAGE.toString('base64')));
    assert.ok(requests[0].includes('Signed private transcript'));
    const download = (token: string, artifact: string) =>
      service.app.inject({
        url: `/api/artifacts/${artifact}/content`,
        headers: { authorization: `Bearer ${token}` },
      });
    assert.equal((await download(member.accessToken, polishing.task.input)).statusCode, 403);
    assert.equal((await download(member.accessToken, fixture.consent.id)).statusCode, 403);
    assert.equal(
      (await download(member.accessToken, polished.task.output)).body,
      'Generated public meeting brief.',
    );
    await call(
      chair,
      'POST',
      '/api/approval-templates',
      {
        id: 'invalid-ai',
        club: 'jlu',
        name: 'Invalid AI timeout',
        active: true,
        stages: [{ ...fixture.stage, onTimeout: 'approve' }],
      },
      403,
    );
    const workflow = await fixture.workflow('documents', 1);
    assert.equal(workflow.stages.length, 2);
    await call(
      chair,
      'POST',
      `/api/workflows/${workflow.id}/actions`,
      { action: 'approve', comment: 'Cannot impersonate the AI reviewer' },
      403,
    );
    completion = JSON.stringify({
      decision: 'approve',
      summary: 'private-review-note',
      issues: [],
    });
    const review = await call<OfficeAiTaskView>(
      chair,
      'POST',
      `/api/workflows/${workflow.id}/ai`,
      {},
    );
    await call(provider, 'POST', `/api/ai/jobs/${review.job.id}/actions`, { action: 'run' });
    await call(chair, 'POST', `/api/document-tasks/${review.task.id}/actions`, { action: 'apply' });
    await call(chair, 'POST', `/api/document-tasks/${review.task.id}/actions`, { action: 'apply' });
    const flows = await call<ApprovalList>(member, 'GET', '/api/events/documents/workflows');
    assert.equal(flows.workflows[0].current, 1);
    assert.equal(flows.workflows[0].status, 'active');
    assert.equal(JSON.stringify(flows).includes('private-review-note'), false);
    await call(chair, 'POST', `/api/workflows/${workflow.id}/actions`, { action: 'execute' }, 403);
    await call(chair, 'POST', `/api/workflows/${workflow.id}/actions`, {
      action: 'approve',
      club: 'jlu',
      comment: 'Chair consent',
    });
    await call(chair, 'POST', `/api/workflows/${workflow.id}/actions`, { action: 'execute' });
    await call(chair, 'POST', '/api/events/documents/actions', { action: 'publish' });
    await call(member, 'POST', '/api/events/documents/actions', { action: 'signup' });
    await call(chair, 'POST', '/api/events/documents/tasks', {
      id: 'hall',
      title: 'Prepare the meeting hall',
      dueMs: base + 7000,
    });
    await call(chair, 'POST', '/api/tasks/hall/actions', {
      action: 'assign',
      account: member.user.id,
    });
    time = base + 11000;
    await call(member, 'POST', '/api/events/documents/actions', { action: 'checkin' });
    await call(member, 'POST', '/api/tasks/hall/actions', { action: 'complete' });
    time = base + 20000;
    await call(chair, 'POST', '/api/events/documents/actions', { action: 'finish' });
    await call(chair, 'POST', '/api/events/documents/rewards', { plan: event.plan.id });
    completion = 'Published activity summary.';
    const summary = await call<OfficeAiTaskView>(chair, 'POST', '/api/events/documents/documents', {
      ...request,
      kind: 'summary',
    });
    const input = await download(chair.accessToken, summary.task.input);
    const evidence = input.json<{
      attendance: { account: string; checked_in_at: number }[];
      awards: { account: string; points: string }[];
      tasks: { id: string; done: number }[];
    }>();
    assert.equal(evidence.attendance[0].account, member.user.id);
    assert.equal(evidence.attendance[0].checked_in_at, base + 11000);
    assert.equal(evidence.awards[0].points, '5');
    assert.equal(evidence.tasks[0].done, 1);
    await call(provider, 'POST', `/api/ai/jobs/${summary.job.id}/actions`, { action: 'run' });
    const applied = await call<OfficeAiTaskView>(
      chair,
      'POST',
      `/api/document-tasks/${summary.task.id}/actions`,
      { action: 'apply' },
    );
    assert.ok(applied.task.output);
    assert.equal((await download(member.accessToken, applied.task.output)).statusCode, 403);
    await call(chair, 'POST', `/api/document-tasks/${summary.task.id}/actions`, {
      action: 'publish',
    });
    assert.equal(
      (await download(member.accessToken, applied.task.output)).body,
      'Published activity summary.',
    );
    assert.equal((await download(member.accessToken, summary.task.input)).statusCode, 403);
    await service.restart();
    assert.equal(
      (await call<OfficeAiTaskView>(chair, 'GET', `/api/document-tasks/${summary.task.id}`)).task
        .output,
      applied.task.output,
    );
    assert.equal(ledger.balance(chair.user.id, 'jlu'), 17n);
    assert.equal(ledger.balance(provider.user.id, 'jlu'), 3n);
    assert.equal(ledger.balance(member.user.id, 'jlu'), 5n);
    assert.equal(
      (await call<PointAllowanceList>(chair, 'GET', '/api/points/allowances')).allowances[0]
        .remaining,
      '7',
    );
  } finally {
    await fixture.close();
  }
});

await test('in-flight documents and AI review replacement preserve privacy, current authority, and requested changes', async (context) => {
  const started = deferred<void>();
  const pending = deferred<Response>();
  let fetchResponse = async () => {
    started.resolve();
    return pending.promise;
  };
  const fixture = await officeSite(async () => fetchResponse());
  const { service, store, root, chair, provider, stranger, member, call, ledger } = fixture;
  try {
    let time = Date.now();
    context.mock.method(Date, 'now', () => time);
    const event = await fixture.create('revision', time);
    const grant = await call<{ id: string }>(chair, 'POST', '/api/identity/grants', {
      account: stranger.user.id,
      scope: 'event:revision',
      permission: 'manage',
    });
    const task = await call<OfficeAiTaskView>(stranger, 'POST', '/api/events/revision/documents', {
      kind: 'polish',
      plan: event.plan.id,
      model: MODEL,
      maxTokens: OUTPUT_TOKENS,
      maxPoints: JOB_COST,
    });
    const running = call<AiJob>(stranger, 'POST', `/api/ai/jobs/${task.job.id}/actions`, {
      action: 'run',
    });
    await started.promise;
    await call(chair, 'DELETE', `/api/identity/grants/${grant.id}`, undefined, 204);
    const succession = await call<{ id: string }>(chair, 'POST', '/api/clubs/jlu/successions', {
      nominee: root.user.id,
    });
    await call(root, 'POST', `/api/identity/successions/${succession.id}/accept`, {}, 204);
    await call(
      root,
      'PUT',
      '/api/events/revision',
      { ...event.draft, brief: task.task.input },
      403,
    );
    const revised = await call<ActivityRecord>(root, 'PUT', '/api/events/revision', {
      ...event.draft,
      title: 'Revised meeting',
    });
    assert.equal(revised.epoch, 2);
    pending.resolve(response('Private source quoted in an old generated document.'));
    const completed = await running;
    assert.equal(completed.status, 'completed');
    const output = completed.attempts.at(-1)?.output;
    assert.ok(output);
    for (const account of [chair, stranger, member]) {
      await call(account, 'GET', `/api/artifacts/${output}/content`, undefined, 403);
    }
    await call(
      root,
      'POST',
      `/api/document-tasks/${task.task.id}/actions`,
      { action: 'apply' },
      403,
    );
    assert.equal(ledger.balance(chair.user.id, 'jlu'), 19n);
    const currentPlan = await fixture.plan(event.draft, 2, root);
    await call(root, 'POST', '/api/events/revision/plan/actions', {
      action: 'polish',
      plan: currentPlan.id,
      document: fixture.brief.id,
    });
    store.transaction(() => ledger.adjust(root.user.id, 'jlu', 10n, 'fixture', 'takeover'));
    await call(root, 'POST', '/api/points/allowances', {
      scope: 'event:revision',
      club: 'jlu',
      budget: '10',
    });
    const workflow = await fixture.workflow('revision', 2);
    fetchResponse = async () => response('Not a structured review.');
    const review = await call<OfficeAiTaskView>(
      root,
      'POST',
      `/api/workflows/${workflow.id}/ai`,
      {},
    );
    const failed = await call<AiJob>(root, 'POST', `/api/ai/jobs/${review.job.id}/actions`, {
      action: 'run',
    });
    assert.equal(failed.status, 'failed');
    await call(
      root,
      'POST',
      `/api/document-tasks/${review.task.id}/actions`,
      { action: 'apply' },
      403,
    );
    fetchResponse = async () =>
      response(
        JSON.stringify({
          decision: 'changes_requested',
          summary: 'Correct the agenda before chair review.',
          issues: ['A required agenda item is missing.'],
        }),
      );
    await call(root, 'POST', `/api/ai/jobs/${review.job.id}/actions`, { action: 'retry' });
    await call(root, 'POST', `/api/ai/jobs/${review.job.id}/actions`, { action: 'run' });
    await call(root, 'POST', `/api/document-tasks/${review.task.id}/actions`, { action: 'apply' });
    const flows = await call<ApprovalList>(root, 'GET', '/api/events/revision/workflows');
    assert.equal(flows.workflows[0].status, 'changes_requested');
    assert.equal(flows.workflows[0].current, 0);
    await call(root, 'POST', `/api/workflows/${workflow.id}/actions`, { action: 'execute' }, 403);
    assert.equal((await call<ActivityRecord>(root, 'GET', '/api/events/revision')).phase, 'review');
    assert.equal(ledger.balance(root.user.id, 'jlu'), 8n);
    const corrected = await call<OfficeArtifact>(root, 'POST', '/api/artifacts', {
      club: 'jlu',
      title: 'Corrected agenda',
      mime: 'text/markdown',
      content: Buffer.from('Revised agenda with the missing item.').toString('base64'),
    });
    const correctedDraft = { ...event.draft, brief: corrected.id, title: 'Corrected agenda' };
    await call(root, 'PUT', '/api/events/revision', correctedDraft);
    const correctedPlan = await fixture.plan(correctedDraft, 3, root);
    await call(root, 'POST', '/api/events/revision/plan/actions', {
      action: 'polish',
      plan: correctedPlan.id,
      document: corrected.id,
    });
    const next = await fixture.workflow('revision', 3);
    fetchResponse = async () =>
      response(
        JSON.stringify({ decision: 'approve', summary: 'Revised agenda accepted.', issues: [] }),
      );
    const accepted = await call<OfficeAiTaskView>(root, 'POST', `/api/workflows/${next.id}/ai`, {});
    await call(root, 'POST', `/api/ai/jobs/${accepted.job.id}/actions`, { action: 'run' });
    await call(root, 'POST', `/api/clubs/jlu/members/${provider.user.id}/revoke`, {}, 204);
    await call(
      root,
      'POST',
      `/api/document-tasks/${accepted.task.id}/actions`,
      { action: 'apply' },
      403,
    );
    assert.ok(service.config.ai);
    service.config.ai.providers[0].account = stranger.user.id;
    await service.restart();
    const replacement = await call<OfficeAiTaskView>(
      root,
      'POST',
      `/api/workflows/${next.id}/ai`,
      {},
    );
    assert.notEqual(replacement.task.id, accepted.task.id);
    assert.notEqual(replacement.job.id, accepted.job.id);
    assert.equal(replacement.job.providerAccount, stranger.user.id);
    assert.equal(
      (await call<OfficeAiTaskView>(root, 'POST', `/api/workflows/${next.id}/ai`, {})).task.id,
      replacement.task.id,
    );
    const replaced = await call<AiJob>(root, 'GET', `/api/ai/jobs/${accepted.job.id}`);
    const replacedOutput = replaced.attempts.at(-1)?.output;
    assert.ok(replacedOutput);
    await call(member, 'GET', `/api/artifacts/${replacedOutput}/content`, undefined, 403);
    await call(stranger, 'POST', `/api/ai/jobs/${replacement.job.id}/actions`, { action: 'run' });
    await call(
      root,
      'POST',
      `/api/document-tasks/${accepted.task.id}/actions`,
      { action: 'apply' },
      403,
    );
    await call(root, 'POST', `/api/document-tasks/${replacement.task.id}/actions`, {
      action: 'apply',
    });
    await call(root, 'POST', `/api/workflows/${next.id}/actions`, {
      action: 'approve',
      club: 'jlu',
      comment: 'Current chair consents',
    });
    await call(root, 'POST', `/api/clubs/jlu/members/${stranger.user.id}/revoke`, {}, 204);
    await call(root, 'POST', `/api/workflows/${next.id}/actions`, { action: 'execute' }, 403);
    assert.equal(ledger.balance(root.user.id, 'jlu'), 6n);
    assert.equal(ledger.balance(stranger.user.id, 'jlu'), 1n);
  } finally {
    pending.resolve(response('Cancelled fixture response.'));
    await fixture.close();
  }
});
