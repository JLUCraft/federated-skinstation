import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  clubReportPolicySchema,
  reportDraftSchema,
  reportViewSchema,
  reportListSchema,
  reportPublicationListSchema,
  reportGenerationRequestSchema,
  reportCommandSchema,
  aiJobRequestSchema,
  type ClubReportPolicy,
  type ClubReport,
  type ReportDraft,
  type ReportView,
  type ReportGenerationRequest,
  type ReportCommand,
  type ReportDestination,
  type ReportPublication,
  type ActivityRecord,
} from '../shared/contracts/generated.js';
import type { Ai } from './ai.js';
import type { Office } from './office.js';
import { appendAudit, type LocalIdentity } from './permissions.js';
import { loadReport, requireReportJobCurrent } from './report-state.js';
import { loadPlan } from './planning-state.js';
import { now, requireThat, type Store } from './store.js';
import { bearer, field, record } from './validate.js';

const REPORT_PAGE_SIZE = 100;

export class Reports {
  constructor(
    private readonly store: Store,
    private readonly identity: LocalIdentity,
    private readonly office: Office,
    private readonly ai: Ai,
  ) {}

  private policy(club: string): ClubReportPolicy {
    const row = this.store.db
      .prepare('SELECT state FROM club_report_policies WHERE club=?')
      .get(club);
    requireThat(row, 'Club report policy required');
    return JSON.parse(String(row.state)) as ClubReportPolicy;
  }

  getPolicy(actor: string, club: string) {
    return this.identity.authorized(actor, `club:${club}`, 'manage', () => this.policy(club));
  }

  putPolicy(actor: string, club: string, input: ClubReportPolicy) {
    return this.identity.authorized(actor, `club:${club}`, 'manage', () => {
      this.identity.authenticate(actor);
      requireThat(input.club === club, 'Policy club must match');
      const profile = this.store.db
        .prepare('SELECT kind FROM club_planning_profiles WHERE club=?')
        .get(club);
      requireThat(
        profile && (profile.kind !== 'official' || input.annual),
        'Official club annual report destination required',
      );
      const snapshot = (destination: ReportDestination): ReportDestination => {
        requireThat(destination.recipient.trim(), 'Report recipient required');
        const source = this.office.artifactContent(actor, destination.requirements);
        requireThat(source.metadata.club === club, 'Club-owned report requirements required');
        const existing = this.store.db
          .prepare('SELECT club FROM report_policy_artifacts WHERE artifact=?')
          .get(destination.requirements);
        if (existing?.club === club) return destination;
        const requirements = this.office.storeDocument(
          actor,
          club,
          source.metadata.title,
          source.metadata.mime,
          source.content,
        );
        this.store.db
          .prepare('INSERT INTO report_policy_artifacts VALUES(?,?)')
          .run(requirements, club);
        return { ...destination, requirements };
      };
      const policy: ClubReportPolicy = {
        club,
        mua: snapshot(input.mua),
        annual: input.annual ? snapshot(input.annual) : null,
      };
      this.store.db
        .prepare(
          'INSERT INTO club_report_policies VALUES(?,?) ON CONFLICT(club) DO UPDATE SET state=excluded.state',
        )
        .run(club, JSON.stringify(policy));
      appendAudit(this.store, actor, `club:${club}`, 'report_policy', club, policy);
      return policy;
    });
  }

  private view(report: ClubReport): ReportView {
    return { report, job: report.currentJob ? this.ai.jobState(report.currentJob) : null };
  }

  private save(report: ClubReport) {
    this.store.db
      .prepare('UPDATE club_reports SET state=? WHERE id=?')
      .run(JSON.stringify(report), report.id);
  }

  private nextVersion(report: ClubReport) {
    requireThat(report.version < Number.MAX_SAFE_INTEGER, 'Report revision limit reached');
    report.version++;
  }

  private evidence(actor: string, input: ReportDraft) {
    const sources: string[] = [];
    const documents = new Map<
      string,
      { id: string; mime: string; text: string | null; attachment: string | null }
    >();
    const document = (artifact: string) => {
      const previous = documents.get(artifact);
      if (previous) return previous;
      const source = this.office.artifactContent(actor, artifact);
      const text = ['text/plain', 'text/markdown', 'application/json'].includes(
        source.metadata.mime,
      );
      const attachment = text
        ? null
        : this.office.storeDocument(
            actor,
            input.club,
            source.metadata.title,
            source.metadata.mime,
            source.content,
          );
      if (attachment) sources.push(attachment);
      const snapshot = {
        id: artifact,
        mime: source.metadata.mime,
        text: text ? source.content.toString('utf8') : null,
        attachment,
      };
      documents.set(artifact, snapshot);
      return snapshot;
    };
    const activities = this.store.db
      .prepare('SELECT state FROM activities ORDER BY id')
      .all()
      .map((row) => JSON.parse(String(row.state)) as ActivityRecord)
      .filter(
        (event) =>
          (event.club === input.club || event.coOrganizers.includes(input.club)) &&
          (event.phase === 'open' || event.phase === 'done') &&
          event.window.startsMs >= input.periodStartMs &&
          event.window.startsMs < input.periodEndMs,
      )
      .map((event) => {
        const summary = this.store.db
          .prepare('SELECT output FROM event_summaries WHERE event=? AND published_at IS NOT NULL')
          .get(event.id);
        return {
          id: event.id,
          title: event.title,
          phase: event.phase,
          startsMs: event.window.startsMs,
          endsMs: event.endsMs,
          brief: document(loadPlan(this.store, event.id)?.polished ?? event.brief),
          summary: summary ? document(String(summary.output)) : null,
          attendance: this.store.db
            .prepare(
              'SELECT account,signed_up_at,checked_in_at FROM event_attendance WHERE event=? AND club=? ORDER BY account',
            )
            .all(event.id, input.club),
          awards: this.store.db
            .prepare(
              'SELECT account,rank,points,material,delivered_by,received_at FROM event_awards WHERE event=? AND club=? ORDER BY rank,account',
            )
            .all(event.id, input.club),
          tasks: this.store.db
            .prepare(
              'SELECT id,title,done FROM activity_tasks WHERE event=? AND assignee_club=? ORDER BY id',
            )
            .all(event.id, input.club),
        };
      });
    requireThat(
      sources.length < aiJobRequestSchema.properties.attachments.maxItems,
      'Report source count exceeds the limit',
    );
    const evidence = this.office.storeSnapshot(actor, input.club, 'Club report evidence', {
      club: input.club,
      kind: input.kind,
      periodStartMs: input.periodStartMs,
      periodEndMs: input.periodEndMs,
      activities,
    });
    return { evidence, sources };
  }

  create(actor: string, input: ReportDraft) {
    return this.identity.authorized(actor, `club:${input.club}`, 'manage', () => {
      this.identity.authenticate(actor);
      requireThat(
        input.periodStartMs < input.periodEndMs && input.periodEndMs <= Date.now(),
        'Closed report period required',
      );
      requireThat(
        !this.store.db.prepare('SELECT 1 FROM club_reports WHERE id=?').get(input.id),
        'Report already exists',
      );
      const policy = this.policy(input.club);
      const profile = this.store.db
        .prepare('SELECT kind FROM club_planning_profiles WHERE club=?')
        .get(input.club);
      requireThat(profile, 'Club planning profile required');
      requireThat(
        input.kind !== 'club_annual_review' || profile.kind === 'official',
        'Official club required for annual review',
      );
      const destination = input.kind === 'mua_annual' ? policy.mua : policy.annual;
      requireThat(destination, 'Report destination required');
      const evidence = this.evidence(actor, input);
      const report: ClubReport = {
        ...input,
        creator: actor,
        ...destination,
        ...evidence,
        output: null,
        status: 'draft',
        version: 1,
        currentJob: null,
        createdAt: Date.now(),
      };
      this.store.db
        .prepare('INSERT INTO club_reports VALUES(?,?,?)')
        .run(report.id, report.club, JSON.stringify(report));
      for (const artifact of [report.evidence, report.requirements, ...report.sources])
        this.store.db.prepare('INSERT INTO report_artifacts VALUES(?,?)').run(artifact, report.id);
      appendAudit(this.store, actor, `report:${report.id}`, 'create_report', report.id, input);
      return this.view(report);
    });
  }

  get(actor: string, id: string) {
    return this.identity.authorized(actor, `report:${id}`, 'manage', () => {
      this.identity.authenticate(actor);
      return this.view(loadReport(this.store, id));
    });
  }

  list(actor: string) {
    return this.store.transaction(() => {
      this.identity.authenticate(actor);
      return this.store.db
        .prepare('SELECT state FROM club_reports ORDER BY rowid DESC')
        .all()
        .map((row) => JSON.parse(String(row.state)) as ClubReport)
        .filter((report) => this.identity.decide(actor, `report:${report.id}`, 'manage'))
        .slice(0, REPORT_PAGE_SIZE);
    });
  }

  publications(actor: string) {
    this.identity.authenticate(actor);
    return this.store.db
      .prepare('SELECT state FROM report_publications ORDER BY rowid DESC LIMIT ?')
      .all(REPORT_PAGE_SIZE)
      .map((row) => JSON.parse(String(row.state)) as ReportPublication);
  }

  generate(actor: string, id: string, input: ReportGenerationRequest) {
    return this.identity.authorized(actor, `report:${id}`, 'manage', () => {
      this.identity.authenticate(actor);
      const report = loadReport(this.store, id);
      requireThat(report.version === input.version, 'Current report version required');
      if (report.currentJob && report.status === 'generating') {
        const job = this.ai.jobState(report.currentJob);
        if (
          job.status === 'queued' ||
          job.status === 'running' ||
          (job.status === 'completed' && !job.attempts.at(-1)?.truncated)
        ) {
          requireThat(
            job.request.model === input.model &&
              job.request.provider === input.provider &&
              job.request.maxTokens === input.maxTokens &&
              job.request.maxPoints === input.maxPoints,
            'Pending report generation has different settings',
          );
          return this.view(report);
        }
      }
      if (report.output !== null) this.nextVersion(report);
      const job = this.ai.prepareRequest(actor, {
        club: report.club,
        scope: `report:${id}`,
        input: report.evidence,
        attachments: [report.requirements, ...report.sources],
        model: input.model,
        provider: input.provider,
        maxTokens: input.maxTokens,
        maxPoints: input.maxPoints,
        mode: 'generate',
        purpose: `Write the ${report.kind} report for ${report.recipient} using this closed period's recorded club activities and the attached requirements. Exclude private consent, account identifiers, and unnecessary personal information.`,
      })();
      report.currentJob = job.id;
      report.output = null;
      report.status = 'generating';
      this.save(report);
      this.store.db
        .prepare('INSERT INTO report_ai_jobs VALUES(?,?,?)')
        .run(job.id, id, report.version);
      appendAudit(this.store, actor, `report:${id}`, 'generate_report', id, {
        job: job.id,
        version: report.version,
      });
      return this.view(report);
    });
  }

  action(actor: string, id: string, input: ReportCommand) {
    return this.identity.authorized(actor, `report:${id}`, 'manage', () => {
      this.identity.authenticate(actor);
      const report = loadReport(this.store, id);
      requireThat(report.version === input.version, 'Current report version required');
      if (input.action === 'revise') {
        requireThat(input.content.trim(), 'Report text required');
        this.nextVersion(report);
        report.output = this.office.storeDocument(
          actor,
          report.club,
          'Club report',
          'text/markdown',
          Buffer.from(input.content),
        );
        report.currentJob = null;
        report.status = 'draft';
        this.store.db.prepare('INSERT INTO report_artifacts VALUES(?,?)').run(report.output, id);
      } else if (input.action === 'apply') {
        requireThat(report.currentJob, 'Report generation required');
        const job = this.ai.jobState(report.currentJob);
        const attempt = job.attempts.at(-1);
        requireThat(
          job.status === 'completed' &&
            attempt?.output &&
            !attempt.truncated &&
            attempt.error === null,
          'Completed report output required',
        );
        if (report.status === 'draft' && report.output === attempt.output) return this.view(report);
        requireReportJobCurrent(this.store, job.id);
        requireThat(
          job.request.input === report.evidence &&
            job.request.scope === `report:${id}` &&
            job.request.mode === 'generate',
          'Bound report job required',
        );
        const artifact = this.office.artifactContent(actor, attempt.output);
        requireThat(
          artifact.metadata.mime === 'text/markdown' && artifact.content.toString('utf8').trim(),
          'Report text required',
        );
        report.output = attempt.output;
        report.status = 'draft';
      } else {
        if (report.status === 'published') return this.view(report);
        requireThat(report.status === 'draft' && report.output, 'Draft report output required');
        const publication: ReportPublication = {
          id,
          club: report.club,
          kind: report.kind,
          periodStartMs: report.periodStartMs,
          periodEndMs: report.periodEndMs,
          recipient: report.recipient,
          version: report.version,
          output: report.output,
          publishedAt: Date.now(),
        };
        this.store.db
          .prepare('INSERT INTO report_publications VALUES(?,?,?,?)')
          .run(id, report.version, report.output, JSON.stringify(publication));
        report.status = 'published';
      }
      this.save(report);
      appendAudit(this.store, actor, `report:${id}`, `${input.action}_report`, id, {
        version: report.version,
        output: report.output,
      });
      return this.view(report);
    });
  }
}

export function registerReports(
  app: FastifyInstance,
  store: Store,
  identity: LocalIdentity,
  office: Office,
  ai: Ai,
) {
  const service = new Reports(store, identity, office, ai);
  const actor = (request: FastifyRequest) =>
    store.token(bearer(request.headers.authorization), undefined, now()).id;
  const id = (request: FastifyRequest) => field(record(request.params).id, 128);
  app.get(
    '/api/clubs/:id/report-policy',
    { schema: { response: { 200: clubReportPolicySchema } } },
    async (request) => service.getPolicy(actor(request), id(request)),
  );
  app.put<{ Body: ClubReportPolicy }>(
    '/api/clubs/:id/report-policy',
    { schema: { body: clubReportPolicySchema, response: { 200: clubReportPolicySchema } } },
    async (request) => service.putPolicy(actor(request), id(request), request.body),
  );
  app.post<{ Body: ReportDraft }>(
    '/api/reports',
    { schema: { body: reportDraftSchema, response: { 200: reportViewSchema } } },
    async (request) => service.create(actor(request), request.body),
  );
  app.get('/api/reports', { schema: { response: { 200: reportListSchema } } }, async (request) => ({
    reports: service.list(actor(request)),
  }));
  app.get(
    '/api/reports/public',
    { schema: { response: { 200: reportPublicationListSchema } } },
    async (request) => ({ reports: service.publications(actor(request)) }),
  );
  app.get(
    '/api/reports/:id',
    { schema: { response: { 200: reportViewSchema } } },
    async (request) => service.get(actor(request), id(request)),
  );
  app.post<{ Body: ReportGenerationRequest }>(
    '/api/reports/:id/generate',
    { schema: { body: reportGenerationRequestSchema, response: { 200: reportViewSchema } } },
    async (request) => service.generate(actor(request), id(request), request.body),
  );
  app.post<{ Body: ReportCommand }>(
    '/api/reports/:id/actions',
    { schema: { body: reportCommandSchema, response: { 200: reportViewSchema } } },
    async (request) => service.action(actor(request), id(request), request.body),
  );
  return service;
}
