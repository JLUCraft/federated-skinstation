import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  aiPricingSchema,
  aiModelListSchema,
  aiJobRequestSchema,
  aiJobSchema,
  aiJobListSchema,
  aiJobCommandSchema,
  aiGatewaySettingsSchema,
  aiReviewSchema,
  type AiPricing,
  type AiJobRequest,
  type AiJob,
  type AiAttempt,
  type AiJobCommand,
  type AiGatewaySettings,
  type AiUsage,
  type AiReview,
  type AiModel,
} from '../shared/contracts/generated.js';
import { AI_LIMITS } from '../shared/ai.js';
import { POINT_LIMIT } from '../shared/points.js';
import { AiGateway, type AiMaterial, type AiCompletion } from './ai-gateway.js';
import type { Office } from './office.js';
import { PointLedger, points } from './points.js';
import { appendAudit, type LocalIdentity } from './permissions.js';
import { now, requireThat, type Store } from './store.js';
import { bearer, field, record } from './validate.js';

type StoredJob = Omit<AiJob, 'quotePoints' | 'escrowedPoints' | 'currentAttempt'>;
const TOKENS_PER_UNIT = 1000n;
const JOB_PAGE_SIZE = 100;

export class Ai {
  constructor(
    private readonly store: Store,
    private readonly identity: LocalIdentity,
    private readonly office: Office,
    private readonly ledger: PointLedger,
    private readonly gateway: () => AiGateway | undefined,
    private readonly validateReview: (value: unknown) => boolean,
  ) {}

  private price(model: string): AiPricing {
    const row = this.store.db.prepare('SELECT pricing FROM ai_pricing WHERE model=?').get(model);
    requireThat(row, 'AI model pricing required');
    return JSON.parse(String(row.pricing)) as AiPricing;
  }

  private cost(pricing: AiPricing, input: number, output: number) {
    const variable =
      BigInt(input) * points(pricing.inputPointsPer1k) +
      BigInt(output) * points(pricing.outputPointsPer1k);
    const cost = points(pricing.basePoints) + (variable + TOKENS_PER_UNIT - 1n) / TOKENS_PER_UNIT;
    requireThat(cost <= POINT_LIMIT, 'AI quote exceeds the point limit');
    return cost;
  }

  private quote(job: StoredJob) {
    const outputTokens =
      points(job.pricing.outputPointsPer1k) > points(job.pricing.inputPointsPer1k)
        ? job.request.maxTokens
        : 0;
    return this.cost(job.pricing, job.contextTokens - outputTokens, outputTokens);
  }

  setPricing(actor: string, pricing: AiPricing) {
    return this.identity.authorized(actor, 'global', 'admin', () => {
      requireThat(
        this.gateway()
          ?.providers()
          .some((provider) => provider.models.includes(pricing.model)),
        'Configured AI model required',
      );
      const base = points(pricing.basePoints);
      const input = points(pricing.inputPointsPer1k);
      const output = points(pricing.outputPointsPer1k);
      requireThat(base + input + output > 0n, 'Positive AI pricing required');
      this.store.db
        .prepare(
          'INSERT INTO ai_pricing VALUES(?,?) ON CONFLICT(model) DO UPDATE SET pricing=excluded.pricing',
        )
        .run(pricing.model, JSON.stringify(pricing));
      appendAudit(this.store, actor, 'global', 'ai_pricing', pricing.model, pricing);
      return pricing;
    });
  }

  models(actor: string) {
    this.identity.authenticate(actor);
    const models: AiModel[] = [];
    for (const provider of this.gateway()?.providers() ?? []) {
      if (!this.identity.isActiveMember(provider.account)) continue;
      for (const model of provider.models) {
        if (!this.store.db.prepare('SELECT 1 FROM ai_pricing WHERE model=?').get(model)) continue;
        models.push({
          model,
          provider: provider.id,
          account: provider.account,
          capabilities: provider.capabilities,
          contextTokens: provider.contextTokens,
          pricing: this.price(model),
        });
      }
    }
    return { models, limits: AI_LIMITS };
  }

  private load(id: string): StoredJob {
    const row = this.store.db.prepare('SELECT state FROM ai_jobs WHERE id=?').get(id);
    requireThat(row, 'AI job not found');
    return JSON.parse(String(row.state)) as StoredJob;
  }

  private save(job: StoredJob) {
    this.store.db.prepare('UPDATE ai_jobs SET state=? WHERE id=?').run(JSON.stringify(job), job.id);
  }

  private escrow(id: string) {
    const row = this.store.db.prepare('SELECT amount FROM point_escrows WHERE job=?').get(id);
    return BigInt(String(row?.amount ?? '0'));
  }

  private snapshot(job: StoredJob): AiJob {
    return {
      ...job,
      currentAttempt: job.attempts.length - 1,
      quotePoints: this.quote(job).toString(),
      escrowedPoints: this.escrow(job.id).toString(),
    };
  }

  private materials(actor: string, input: AiJobRequest): AiMaterial[] {
    return [...new Set([input.input, ...(input.attachments ?? [])])].map((id) => {
      const artifact = this.office.artifactContent(actor, id);
      return {
        name: artifact.metadata.title,
        mime: artifact.metadata.mime,
        content: artifact.content,
      };
    });
  }

  private availableGateway() {
    const gateway = this.gateway();
    requireThat(gateway, 'AI gateway is not configured');
    return gateway;
  }

  private executionGateway(job: StoredJob, materials: AiMaterial[]) {
    const gateway = this.availableGateway();
    const provider = gateway.select({ ...job.request, provider: job.provider }, materials);
    requireThat(
      provider.account === job.providerAccount && provider.contextTokens <= job.contextTokens,
      'Current AI provider within reserved context required',
    );
    return gateway;
  }

  private providerCurrent(job: StoredJob, actor: string) {
    return (
      actor === job.providerAccount &&
      this.identity.isActiveMember(actor, job.providerClub) &&
      !!this.gateway()
        ?.providers()
        .some((provider) => provider.id === job.provider && provider.account === actor)
    );
  }

  private canRead(actor: string, job: StoredJob) {
    return (
      actor === job.payer ||
      actor === job.proposer ||
      this.providerCurrent(job, actor) ||
      this.identity.isGlobalAdministrator(actor) ||
      (job.allowance?.scope.startsWith('event:') &&
        this.identity.decide(actor, job.allowance.scope, 'manage'))
    );
  }

  private spendingAuthority(job: StoredJob) {
    this.identity.requireMembership(job.payer, job.club);
    this.identity.authenticate(job.proposer);
    if (job.allowance?.scope.startsWith('event:')) {
      requireThat(
        this.identity.decide(job.payer, job.allowance.scope, 'manage') &&
          this.identity.decide(job.proposer, job.allowance.scope, 'manage'),
        'Current AI event authority required',
      );
    }
  }

  private reference(job: StoredJob) {
    return `${job.id}:${job.attempts.length - 1}`;
  }

  private reserve(job: StoredJob) {
    const quote = this.quote(job);
    requireThat(quote <= points(job.request.maxPoints), 'AI quote exceeds the spending limit');
    if (job.allowance) {
      const allowance = this.store.db
        .prepare('SELECT * FROM point_allowances WHERE scope=?')
        .get(job.allowance.scope);
      requireThat(
        allowance &&
          allowance.epoch === job.allowance.epoch &&
          allowance.account === job.payer &&
          allowance.club === job.club,
        'Current AI spending authorization required',
      );
      const remaining = points(String(allowance.remaining));
      requireThat(remaining >= quote, 'AI budget exhausted');
      this.store.db
        .prepare('UPDATE point_allowances SET remaining=? WHERE scope=?')
        .run((remaining - quote).toString(), job.allowance.scope);
    }
    this.ledger.adjust(job.payer, job.club, -quote, 'ai_reserve', this.reference(job));
    this.store.db
      .prepare('INSERT INTO point_escrows VALUES(?,?,?,?)')
      .run(job.id, job.payer, job.club, quote.toString());
  }

  private emptyAttempt(attempt: number): AiAttempt {
    return {
      attempt,
      startedAt: null,
      finishedAt: null,
      output: null,
      error: null,
      usage: null,
      chargedPoints: '0',
      refundedPoints: '0',
      truncated: false,
    };
  }

  request(actor: string, input: AiJobRequest) {
    return this.identity.action(actor, input.scope ?? `club:${input.club}`, 'request_ai', () => {
      this.identity.authenticate(actor);
      requireThat(input.purpose.trim(), 'AI task purpose required');
      points(input.maxPoints);
      const materials = this.materials(actor, input);
      const provider = this.availableGateway().select(input, materials);
      const pricing = this.price(input.model);
      let payer = actor;
      let allowance: StoredJob['allowance'] = null;
      if (input.scope) {
        const current = this.store.db
          .prepare('SELECT * FROM point_allowances WHERE scope=?')
          .get(input.scope);
        requireThat(current && current.club === input.club, 'AI spending authorization required');
        payer = String(current.account);
        requireThat(
          (input.scope === `member:${actor}` && payer === actor) ||
            (input.scope.startsWith('event:') &&
              this.identity.decide(actor, input.scope, 'manage')),
          'AI budget scope authority required',
        );
        allowance = { scope: input.scope, epoch: Number(current.epoch) };
      }
      const time = Date.now();
      const job: StoredJob = {
        id: randomUUID(),
        request: input,
        proposer: actor,
        payer,
        club: input.club,
        provider: provider.id,
        providerAccount: provider.account,
        providerClub: this.identity.affiliation(provider.account),
        contextTokens: provider.contextTokens,
        pricing,
        allowance,
        status: 'queued',
        startedAt: time,
        deadlineMs: time + AI_LIMITS.jobTimeoutMs,
        attempts: [this.emptyAttempt(0)],
      };
      this.spendingAuthority(job);
      this.quote(job);
      return () => {
        this.store.db
          .prepare('INSERT INTO ai_jobs VALUES(?,?,?,?,?)')
          .run(job.id, payer, job.club, allowance?.scope ?? null, JSON.stringify(job));
        this.reserve(job);
        appendAudit(
          this.store,
          actor,
          input.scope ?? `club:${input.club}`,
          'request_ai',
          job.id,
          this.snapshot(job),
        );
        return this.snapshot(job);
      };
    });
  }

  get(actor: string, id: string) {
    return this.identity.action(actor, 'global', 'read_ai_job', () => {
      this.identity.authenticate(actor);
      const job = this.load(id);
      requireThat(this.canRead(actor, job), 'AI job access required');
      return () => this.snapshot(job);
    });
  }

  list(actor: string) {
    return this.store.transaction(() => {
      this.identity.authenticate(actor);
      return this.store.db
        .prepare(
          "SELECT state FROM ai_jobs ORDER BY json_extract(state,'$.startedAt') DESC,id DESC",
        )
        .all()
        .map((row) => JSON.parse(String(row.state)) as StoredJob)
        .filter((job) => this.canRead(actor, job))
        .slice(0, JOB_PAGE_SIZE)
        .map((job) => this.snapshot(job));
    });
  }

  private refundAllowance(job: StoredJob, amount: bigint) {
    if (!job.allowance || amount === 0n) return;
    const current = this.store.db
      .prepare('SELECT * FROM point_allowances WHERE scope=?')
      .get(job.allowance.scope);
    if (
      !current ||
      current.epoch !== job.allowance.epoch ||
      current.account !== job.payer ||
      current.club !== job.club
    )
      return;
    const remaining = points(String(current.remaining)) + amount;
    requireThat(remaining <= POINT_LIMIT, 'AI authorization refund overflow');
    this.store.db
      .prepare('UPDATE point_allowances SET remaining=? WHERE scope=?')
      .run(remaining.toString(), job.allowance.scope);
  }

  private release(
    job: StoredJob,
    measured: AiUsage | null,
    output: string | null,
    error: string | null,
    truncated: boolean,
    status: StoredJob['status'],
  ) {
    const escrow = this.escrow(job.id);
    const charged = measured
      ? this.cost(job.pricing, measured.inputTokens, measured.outputTokens)
      : 0n;
    requireThat(charged <= escrow, 'AI usage exceeds reserved points');
    const refund = escrow - charged;
    this.store.db.prepare('DELETE FROM point_escrows WHERE job=?').run(job.id);
    this.ledger.adjust(job.payer, job.club, refund, 'ai_refund', this.reference(job));
    this.refundAllowance(job, refund);
    if (charged > 0n) {
      if (job.pricing.settlement === 'provider_reward') {
        this.ledger.adjust(
          job.providerAccount,
          job.providerClub,
          charged,
          'ai_provider_reward',
          this.reference(job),
        );
      } else {
        const row = this.store.db.prepare('SELECT burned FROM ai_totals WHERE id=1').get()!;
        const burned = BigInt(String(row.burned)) + charged;
        requireThat(burned <= POINT_LIMIT, 'AI settlement overflow');
        this.store.db.prepare('UPDATE ai_totals SET burned=? WHERE id=1').run(burned.toString());
      }
    }
    const attempt = job.attempts[job.attempts.length - 1];
    attempt.finishedAt = Date.now();
    attempt.output = output;
    attempt.error = error;
    attempt.usage = measured;
    attempt.chargedPoints = charged.toString();
    attempt.refundedPoints = refund.toString();
    attempt.truncated = truncated;
    job.status = status;
    this.save(job);
    appendAudit(
      this.store,
      'ai-gateway',
      job.allowance?.scope ?? `club:${job.club}`,
      'settle_ai',
      job.id,
      {
        attempt,
        settlement: job.pricing.settlement,
        provider: job.providerAccount,
      },
      'system',
    );
    return this.snapshot(job);
  }

  private review(content: string): AiReview {
    const value: unknown = JSON.parse(content);
    requireThat(this.validateReview(value), 'Invalid AI review output');
    const review = value as AiReview;
    requireThat(
      review.summary.trim() &&
        review.issues.every((issue) => issue.trim()) &&
        (review.decision === 'approve' || review.issues.length),
      'Invalid AI review output',
    );
    return review;
  }

  private finish(id: string, attempt: number, completion: AiCompletion | undefined) {
    return this.store.transaction(() => {
      const job = this.load(id);
      const cancelling = job.status === 'cancelled' && this.escrow(id) > 0n;
      if ((job.status !== 'running' && !cancelling) || job.attempts.length - 1 !== attempt)
        return this.snapshot(job);
      if (Date.now() >= job.deadlineMs)
        return this.release(
          job,
          null,
          null,
          'AI job timed out',
          false,
          cancelling ? 'cancelled' : 'failed',
        );
      if (cancelling)
        return this.release(
          job,
          completion?.usage ?? null,
          null,
          'AI job cancelled',
          false,
          'cancelled',
        );
      if (!completion)
        return this.release(job, null, null, 'AI provider request failed', false, 'failed');
      let content = completion.content;
      if (job.request.mode === 'review') {
        try {
          requireThat(!completion.truncated, 'Incomplete AI review output');
          content = JSON.stringify(this.review(content));
        } catch {
          return this.release(
            job,
            completion.usage,
            null,
            'Invalid AI review output',
            completion.truncated,
            'failed',
          );
        }
      }
      const output = randomUUID();
      this.store.db
        .prepare(
          "INSERT INTO office_artifacts(id,club,owner,title,mime,content,parent,created_at,visibility) VALUES(?,?,?,?,?,?,NULL,?,'private')",
        )
        .run(
          output,
          job.club,
          job.payer,
          'AI output',
          job.request.mode === 'review' ? 'application/json' : 'text/markdown',
          Buffer.from(content),
          Date.now(),
        );
      this.store.db.prepare('INSERT INTO artifact_readers VALUES(?,?)').run(output, job.proposer);
      return this.release(job, completion.usage, output, null, completion.truncated, 'completed');
    });
  }

  async run(actor: string, id: string) {
    const execution = this.identity.action(actor, 'global', 'run_ai', () => {
      this.identity.authenticate(actor);
      const job = this.load(id);
      requireThat(
        this.canRead(actor, job) && job.status === 'queued' && Date.now() < job.deadlineMs,
        'Current queued AI job required',
      );
      this.spendingAuthority(job);
      this.identity.requireMembership(job.providerAccount, job.providerClub);
      const materials = this.materials(job.proposer, job.request);
      const gateway = this.executionGateway(job, materials);
      return () => {
        job.status = 'running';
        const attempt = job.attempts.length - 1;
        job.attempts[attempt].startedAt = Date.now();
        this.save(job);
        appendAudit(this.store, actor, job.allowance?.scope ?? `club:${job.club}`, 'run_ai', id, {
          attempt,
        });
        return { job, materials, gateway, attempt };
      };
    });
    let completion: AiCompletion | undefined;
    try {
      completion = await execution.gateway.complete(
        execution.job.provider,
        execution.job.providerAccount,
        execution.job.request,
        execution.materials,
      );
    } catch {
      completion = undefined;
    }
    try {
      return this.finish(id, execution.attempt, completion);
    } catch {
      return this.store.transaction(() => {
        const job = this.load(id);
        const cancelling = job.status === 'cancelled' && this.escrow(id) > 0n;
        if (
          (job.status !== 'running' && !cancelling) ||
          job.attempts.length - 1 !== execution.attempt
        )
          return this.snapshot(job);
        return this.release(
          job,
          null,
          null,
          'AI settlement failed',
          false,
          cancelling ? 'cancelled' : 'failed',
        );
      });
    }
  }

  action(actor: string, id: string, action: 'cancel' | 'poke' | 'retry') {
    return this.identity.action(actor, 'global', `${action}_ai`, () => {
      this.identity.authenticate(actor);
      const job = this.load(id);
      requireThat(
        actor === job.payer ||
          actor === job.proposer ||
          this.identity.isGlobalAdministrator(actor) ||
          (job.allowance?.scope.startsWith('event:') &&
            this.identity.decide(actor, job.allowance.scope, 'manage')),
        'AI job control authority required',
      );
      if (action === 'retry') {
        requireThat(
          job.status === 'failed' && job.attempts.length < AI_LIMITS.maxAttempts,
          'Retryable AI job required',
        );
        this.spendingAuthority(job);
        this.identity.requireMembership(job.providerAccount, job.providerClub);
        const materials = this.materials(job.proposer, job.request);
        this.executionGateway(job, materials);
        return () => {
          job.attempts.push(this.emptyAttempt(job.attempts.length));
          job.status = 'queued';
          job.deadlineMs = Date.now() + AI_LIMITS.jobTimeoutMs;
          this.reserve(job);
          this.save(job);
          appendAudit(
            this.store,
            actor,
            job.allowance?.scope ?? `club:${job.club}`,
            'retry_ai',
            id,
            {},
          );
          return this.snapshot(job);
        };
      }
      if (action === 'cancel' && job.status === 'cancelled') return () => this.snapshot(job);
      requireThat(
        job.status === 'queued' ||
          job.status === 'running' ||
          (job.status === 'cancelled' && this.escrow(id) > 0n),
        'Pending AI job required',
      );
      requireThat(action !== 'poke' || Date.now() >= job.deadlineMs, 'AI deadline has not elapsed');
      return () => {
        if (action === 'cancel' && job.status === 'running') {
          job.status = 'cancelled';
          this.save(job);
          appendAudit(
            this.store,
            actor,
            job.allowance?.scope ?? `club:${job.club}`,
            'cancel_ai',
            id,
            {},
          );
          return this.snapshot(job);
        }
        return this.release(
          job,
          null,
          null,
          action === 'poke' ? 'AI job timed out' : 'AI job cancelled',
          false,
          action === 'poke' && job.status !== 'cancelled' ? 'failed' : 'cancelled',
        );
      };
    });
  }
}

export function registerAi(
  app: FastifyInstance,
  store: Store,
  identity: LocalIdentity,
  office: Office,
  ledger: PointLedger,
  settings: AiGatewaySettings | undefined,
  fetcher: typeof fetch,
) {
  let gateway: AiGateway | undefined;
  let validateReview: (value: unknown) => boolean = () => false;
  app.addHook('onReady', async () => {
    const compiler = app.validatorCompiler;
    requireThat(compiler, 'Schema compiler required');
    const review = compiler({
      schema: aiReviewSchema,
      method: 'POST',
      url: '/api/ai/jobs',
      httpPart: 'body',
    });
    validateReview = (value) => review(value) === true;
    if (settings) {
      const validate = compiler({
        schema: aiGatewaySettingsSchema,
        method: 'POST',
        url: '/api/ai/models',
        httpPart: 'body',
      });
      requireThat(validate(settings) === true, 'Invalid AI gateway settings');
      gateway = await AiGateway.create(settings, fetcher);
    }
  });
  const service = new Ai(
    store,
    identity,
    office,
    ledger,
    () => gateway,
    (value) => validateReview(value),
  );
  const actor = (request: FastifyRequest) =>
    store.token(bearer(request.headers.authorization), undefined, now()).id;
  const id = (request: FastifyRequest) => field(record(request.params).id, 128);
  app.get('/api/ai/models', { schema: { response: { 200: aiModelListSchema } } }, async (request) =>
    service.models(actor(request)),
  );
  app.post<{ Body: AiPricing }>(
    '/api/ai/pricing',
    {
      schema: { body: aiPricingSchema, response: { 200: aiPricingSchema } },
    },
    async (request) => service.setPricing(actor(request), request.body),
  );
  app.post<{ Body: AiJobRequest }>(
    '/api/ai/jobs',
    {
      schema: { body: aiJobRequestSchema, response: { 200: aiJobSchema } },
    },
    async (request) => service.request(actor(request), request.body),
  );
  app.get('/api/ai/jobs', { schema: { response: { 200: aiJobListSchema } } }, async (request) => ({
    jobs: service.list(actor(request)),
  }));
  app.get('/api/ai/jobs/:id', { schema: { response: { 200: aiJobSchema } } }, async (request) =>
    service.get(actor(request), id(request)),
  );
  app.post<{ Body: AiJobCommand }>(
    '/api/ai/jobs/:id/actions',
    {
      schema: { body: aiJobCommandSchema, response: { 200: aiJobSchema } },
    },
    async (request) =>
      request.body.action === 'run'
        ? service.run(actor(request), id(request))
        : service.action(actor(request), id(request), request.body.action),
  );
  return service;
}
