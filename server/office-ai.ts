import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  aiJobRequestSchema,
  officeAiRequestSchema,
  officeAiTaskViewSchema,
  officeAiTaskListSchema,
  officeAiCommandSchema,
  type OfficeAiRequest,
  type OfficeAiTask,
  type OfficeAiTaskView,
  type OfficeAiCommand,
  type ActivityPlan,
  type ActivityRecord,
  type ApprovalInstance,
  type AiJobRequest,
  type Competition,
} from '../shared/contracts/generated.js';
import type { Ai } from './ai.js';
import type { Office } from './office.js';
import { appendAudit, type LocalIdentity } from './permissions.js';
import { loadOfficeAiTask, officeAiTaskCurrent } from './office-ai-state.js';
import { loadPlan, setPolishedPlan } from './planning-state.js';
import { now, requireThat, type Store } from './store.js';
import { bearer, field, record } from './validate.js';

const DOCUMENT_PURPOSES = {
  polish:
    'Write a publishable activity brief from this finalized plan. Use the supplied records and source documents. Exclude private consent, personal contact information, and private administrative discussion.',
  summary:
    'Summarize this completed activity using the supplied attendance, league results, rewards, and tasks. Describe recorded outcomes and open actions. Exclude private consent and personal contact information.',
};

export class OfficeAi {
  constructor(
    private readonly store: Store,
    private readonly identity: LocalIdentity,
    private readonly office: Office,
    private readonly ai: Ai,
  ) {}

  private view(task: OfficeAiTask): OfficeAiTaskView {
    return { task, job: this.ai.jobState(task.job) };
  }

  private save(task: OfficeAiTask) {
    this.store.db
      .prepare('UPDATE office_ai_tasks SET state=? WHERE id=?')
      .run(JSON.stringify(task), task.id);
  }

  private sourceFiles(plan: ActivityPlan) {
    return [
      ...new Set([
        ...plan.opinions.map((opinion) => opinion.document),
        ...plan.consents.flatMap((consent) =>
          consent.transcript ? [consent.document, consent.transcript] : [consent.document],
        ),
      ]),
    ];
  }

  private evidence(
    actor: string,
    event: ActivityRecord,
    plan: ActivityPlan,
    kind: OfficeAiTask['kind'],
    workflow: ApprovalInstance | null,
  ) {
    requireThat(plan.evidence, 'Finalized planning evidence required');
    if (kind === 'polish') return plan.evidence;
    const games = this.store.db
      .prepare(
        'SELECT g.resource,l.state FROM event_games g JOIN leagues l ON l.id=g.league WHERE g.event=? ORDER BY g.resource',
      )
      .all(event.id)
      .map((row) => ({
        resource: String(row.resource),
        competition: JSON.parse(String(row.state)) as Competition,
      }));
    const attendance = this.store.db
      .prepare(
        'SELECT account,club,signed_up_at,checked_in_at FROM event_attendance WHERE event=? ORDER BY account',
      )
      .all(event.id);
    const awards = this.store.db
      .prepare(
        'SELECT account,club,rank,points,material,delivered_by,received_at FROM event_awards WHERE event=? ORDER BY rank,account',
      )
      .all(event.id);
    const tasks = this.store.db
      .prepare('SELECT id,title,due_ms,assignee,done FROM activity_tasks WHERE event=? ORDER BY id')
      .all(event.id);
    return this.office.storeSnapshot(actor, event.club, event.title, {
      event,
      plan,
      workflow,
      attendance,
      games,
      awards,
      tasks,
      planningEvidence: plan.evidence,
    });
  }

  private create(
    actor: string,
    event: ActivityRecord,
    plan: ActivityPlan,
    kind: OfficeAiTask['kind'],
    settings: Pick<AiJobRequest, 'model' | 'provider' | 'maxTokens' | 'maxPoints' | 'purpose'>,
    workflow: ApprovalInstance | null,
  ) {
    const stage = workflow?.current ?? null;
    const previous = this.store.db
      .prepare('SELECT state FROM office_ai_tasks WHERE event=? ORDER BY rowid DESC')
      .all(event.id)
      .map((row) => JSON.parse(String(row.state)) as OfficeAiTask)
      .find(
        (task) =>
          task.plan === plan.id &&
          task.kind === kind &&
          task.workflow === (workflow?.id ?? null) &&
          task.stage === stage &&
          task.appliedAt === null,
      );
    if (previous) {
      const job = this.ai.jobState(previous.job);
      const attempt = job.attempts.at(-1);
      if (
        job.status === 'queued' ||
        job.status === 'running' ||
        (job.status === 'completed' &&
          !attempt?.truncated &&
          (kind !== 'review' ||
            this.identity.isActiveMember(job.providerAccount, job.providerClub)))
      ) {
        requireThat(
          job.request.model === settings.model &&
            job.request.provider === settings.provider &&
            job.request.maxTokens === settings.maxTokens &&
            job.request.maxPoints === settings.maxPoints &&
            job.request.purpose === settings.purpose,
          'Pending document task has different settings',
        );
        return this.view(previous);
      }
    }
    const input = this.evidence(actor, event, plan, kind, workflow);
    const attachments = [
      ...new Set([
        event.brief,
        ...this.sourceFiles(plan),
        ...(kind === 'polish' || !plan.polished ? [] : [plan.polished]),
      ]),
    ].filter((id) => id !== input);
    requireThat(
      attachments.length <= aiJobRequestSchema.properties.attachments.maxItems,
      'Document source count exceeds the limit',
    );
    const job = this.ai.prepareRequest(actor, {
      ...settings,
      club: event.club,
      scope: `event:${event.id}`,
      input,
      attachments,
      mode: kind === 'review' ? 'review' : 'generate',
    })();
    const task: OfficeAiTask = {
      id: randomUUID(),
      event: event.id,
      plan: plan.id,
      epoch: event.epoch,
      kind,
      workflow: workflow?.id ?? null,
      stage,
      input,
      attachments,
      job: job.id,
      output: null,
      appliedAt: null,
    };
    this.store.db
      .prepare('INSERT INTO office_ai_tasks VALUES(?,?,?,?)')
      .run(task.id, event.id, job.id, JSON.stringify(task));
    this.store.db.prepare('INSERT INTO office_ai_artifacts VALUES(?,?)').run(input, task.id);
    appendAudit(this.store, actor, `event:${event.id}`, `request_${kind}`, task.id, task);
    return this.view(task);
  }

  request(actor: string, eventId: string, input: OfficeAiRequest) {
    return this.identity.authorized(actor, `event:${eventId}`, 'manage', () => {
      this.identity.authenticate(actor);
      const event = this.office.load(eventId);
      const plan = loadPlan(this.store, eventId);
      requireThat(
        plan?.id === input.plan && plan.epoch === event.epoch && plan.finalized,
        'Current finalized plan required',
      );
      const target = {
        event: eventId,
        plan: plan.id,
        epoch: event.epoch,
        kind: input.kind,
        workflow: null,
        stage: null,
      };
      requireThat(officeAiTaskCurrent(this.store, target), 'Current document target required');
      return this.create(
        actor,
        event,
        plan,
        input.kind,
        {
          model: input.model,
          provider: input.provider,
          maxTokens: input.maxTokens,
          maxPoints: input.maxPoints,
          purpose: DOCUMENT_PURPOSES[input.kind],
        },
        null,
      );
    });
  }

  requestReview(actor: string, id: string) {
    return this.identity.action(actor, `workflow:${id}`, 'request_ai_stage', () => {
      this.identity.authenticate(actor);
      const workflow = this.office.loadWorkflow(id);
      requireThat(
        this.identity.decide(actor, `event:${workflow.event}`, 'manage'),
        'Event review management required',
      );
      const event = this.office.load(workflow.event);
      const plan = loadPlan(this.store, event.id);
      const stage = workflow.stages[workflow.current];
      requireThat(
        plan?.epoch === event.epoch &&
          plan.finalized &&
          workflow.epoch === event.epoch &&
          event.phase === 'review' &&
          workflow.status === 'active' &&
          stage?.approver.kind === 'ai' &&
          (workflow.deadlineMs === null || Date.now() < workflow.deadlineMs),
        'Current AI review stage required',
      );
      const approver = stage.approver;
      return () =>
        this.create(
          actor,
          event,
          plan,
          'review',
          {
            model: approver.model,
            provider: approver.provider,
            maxTokens: approver.maxTokens,
            maxPoints: approver.maxPoints,
            purpose: approver.purpose,
          },
          workflow,
        );
    });
  }

  get(actor: string, id: string) {
    const task = loadOfficeAiTask(this.store, id);
    return this.identity.authorized(actor, `event:${task.event}`, 'manage', () => {
      this.identity.authenticate(actor);
      return this.view(loadOfficeAiTask(this.store, id));
    });
  }

  list(actor: string, event: string) {
    return this.identity.authorized(actor, `event:${event}`, 'manage', () => {
      this.identity.authenticate(actor);
      return this.store.db
        .prepare('SELECT state FROM office_ai_tasks WHERE event=? ORDER BY rowid')
        .all(event)
        .map((row) => this.view(JSON.parse(String(row.state)) as OfficeAiTask));
    });
  }

  action(actor: string, id: string, action: OfficeAiCommand['action']) {
    const target = loadOfficeAiTask(this.store, id);
    return this.identity.authorized(actor, `event:${target.event}`, 'manage', () => {
      this.identity.authenticate(actor);
      const task = loadOfficeAiTask(this.store, id);
      const event = this.office.load(task.event);
      const plan = loadPlan(this.store, event.id);
      requireThat(
        plan?.id === task.plan && event.epoch === task.epoch,
        'Current document target required',
      );
      if (action === 'publish') {
        requireThat(
          task.kind === 'summary' &&
            task.appliedAt !== null &&
            task.output &&
            event.phase === 'done',
          'Applied activity summary required',
        );
        const summary = this.store.db
          .prepare('SELECT output FROM event_summaries WHERE event=? AND plan=?')
          .get(event.id, plan.id);
        requireThat(summary?.output === task.output, 'Current activity summary required');
        this.store.db
          .prepare('UPDATE event_summaries SET published_at=COALESCE(published_at,?) WHERE event=?')
          .run(Date.now(), event.id);
        this.store.db
          .prepare('INSERT OR IGNORE INTO event_artifacts VALUES(?,?)')
          .run(event.id, task.output);
        appendAudit(this.store, actor, `event:${event.id}`, 'publish_summary', task.id, {
          output: task.output,
        });
        return this.view(task);
      }
      if (task.appliedAt !== null) return this.view(task);
      requireThat(officeAiTaskCurrent(this.store, task), 'Current document task required');
      const job = this.ai.jobState(task.job);
      const attempt = job.attempts.at(-1);
      requireThat(
        job.status === 'completed' &&
          attempt?.output &&
          !attempt.truncated &&
          attempt.error === null,
        'Completed document output required',
      );
      requireThat(
        job.request.input === task.input &&
          job.request.scope === `event:${event.id}` &&
          job.request.mode === (task.kind === 'review' ? 'review' : 'generate'),
        'Bound document job required',
      );
      const artifact = this.office.artifactContent(actor, attempt.output);
      task.output = attempt.output;
      task.appliedAt = Date.now();
      this.save(task);
      if (task.kind === 'review')
        this.office.applyAiReview(
          task,
          job,
          this.ai.reviewOutput(artifact.content.toString('utf8')),
        );
      else {
        requireThat(
          artifact.metadata.mime === 'text/markdown' && artifact.content.toString('utf8').trim(),
          'Generated document text required',
        );
        if (task.kind === 'polish') setPolishedPlan(this.store, event, plan, task.output);
        else
          this.store.db
            .prepare('INSERT INTO event_summaries VALUES(?,?,?,?,NULL)')
            .run(event.id, plan.id, task.output, Date.now());
      }
      appendAudit(this.store, actor, `event:${event.id}`, `apply_${task.kind}`, task.id, {
        output: task.output,
        job: job.id,
      });
      return this.view(task);
    });
  }
}

export function registerOfficeAi(
  app: FastifyInstance,
  store: Store,
  identity: LocalIdentity,
  office: Office,
  ai: Ai,
) {
  const service = new OfficeAi(store, identity, office, ai);
  const actor = (request: FastifyRequest) =>
    store.token(bearer(request.headers.authorization), undefined, now()).id;
  const id = (request: FastifyRequest) => field(record(request.params).id, 128);
  app.post<{ Body: OfficeAiRequest }>(
    '/api/events/:id/documents',
    {
      schema: { body: officeAiRequestSchema, response: { 200: officeAiTaskViewSchema } },
    },
    async (request) => service.request(actor(request), id(request), request.body),
  );
  app.get(
    '/api/events/:id/documents',
    { schema: { response: { 200: officeAiTaskListSchema } } },
    async (request) => ({ tasks: service.list(actor(request), id(request)) }),
  );
  app.post(
    '/api/workflows/:id/ai',
    { schema: { response: { 200: officeAiTaskViewSchema } } },
    async (request) => service.requestReview(actor(request), id(request)),
  );
  app.get(
    '/api/document-tasks/:id',
    { schema: { response: { 200: officeAiTaskViewSchema } } },
    async (request) => service.get(actor(request), id(request)),
  );
  app.post<{ Body: OfficeAiCommand }>(
    '/api/document-tasks/:id/actions',
    {
      schema: { body: officeAiCommandSchema, response: { 200: officeAiTaskViewSchema } },
    },
    async (request) => service.action(actor(request), id(request), request.body.action),
  );
  return service;
}
