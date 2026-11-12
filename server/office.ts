import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  activityDraftSchema,
  activityRecordSchema,
  activityListSchema,
  activityCommandSchema,
  activityTaskCreateSchema,
  activityTaskSchema,
  activityTaskListSchema,
  activityTaskCommandSchema,
  activityAttendanceSchema,
  activityNoticeListSchema,
  officeArtifactUploadSchema,
  officeArtifactSchema,
  approvalTemplateSchema,
  approvalTemplateListSchema,
  approvalStartSchema,
  approvalInstanceSchema,
  approvalListSchema,
  approvalCommandSchema,
  type ActivityDraft,
  type ActivityRecord,
  type ActivityCommand,
  type ActivityTaskCreate,
  type ActivityTaskCommand,
  type ActivityTask,
  type ActivityAttendance,
  type ActivityNoticeList,
  type OfficeArtifactUpload,
  type OfficeArtifact,
  type ApprovalTemplate,
  type ApprovalStart,
  type ApprovalInstance,
  type ApprovalStage,
  type ApprovalRecord,
  type ApprovalApprover,
  type ApprovalCommand,
} from '../shared/contracts/generated.js';
import { appendAudit, type LocalIdentity } from './permissions.js';
import {
  loadPlan,
  planDocumentsReadable,
  releasePlanResources,
  requirePlanReady,
} from './planning-state.js';
import { now, requireThat, type Store } from './store.js';
import { bearer, field, record } from './validate.js';

const MAX_ARTIFACT_BYTES = officeArtifactSchema.properties.size.maximum;
const MAX_ARTIFACT_REQUEST_BYTES = officeArtifactUploadSchema.properties.content.maxLength + 4096;

export class Office {
  constructor(
    private readonly store: Store,
    private readonly identity: LocalIdentity,
  ) {}

  private active(account: string, club?: string) {
    return this.identity.isActiveMember(account, club);
  }

  private chair(account: string, club: string) {
    return (
      this.active(account, club) &&
      !!this.store.db.prepare('SELECT 1 FROM chairs WHERE account=? AND club=?').get(account, club)
    );
  }

  load(id: string): ActivityRecord {
    const row = this.store.db.prepare('SELECT state FROM activities WHERE id=?').get(id);
    requireThat(row, 'Event not found');
    return JSON.parse(String(row.state)) as ActivityRecord;
  }

  private save(event: ActivityRecord) {
    this.store.db
      .prepare('UPDATE activities SET state=? WHERE id=?')
      .run(JSON.stringify(event), event.id);
  }

  private clubs(event: ActivityRecord) {
    return [event.club, ...event.coOrganizers];
  }

  private visible(actor: string, event: ActivityRecord) {
    return (
      event.phase === 'open' ||
      event.phase === 'done' ||
      this.clubs(event).some((club) => this.active(actor, club)) ||
      this.identity.isGlobalAdministrator(actor) ||
      this.store.db
        .prepare("SELECT state FROM workflows WHERE event=? AND json_extract(state,'$.epoch')=?")
        .all(event.id, event.epoch)
        .some((row) =>
          this.workflowReadable(actor, JSON.parse(String(row.state)) as ApprovalInstance),
        )
    );
  }

  private mutable(event: ActivityRecord) {
    requireThat(event.phase !== 'done' && event.phase !== 'cancelled', 'Active event required');
  }

  private validateDraft(actor: string, draft: ActivityDraft) {
    const time = Date.now();
    requireThat(
      draft.title.trim() &&
        draft.window.opensMs < draft.window.closesMs &&
        draft.window.closesMs <= draft.window.startsMs &&
        draft.window.closesMs > time &&
        draft.checkinOpensMs < draft.checkinClosesMs &&
        draft.checkinClosesMs <= draft.window.startsMs &&
        draft.window.startsMs < draft.endsMs,
      'Invalid event window',
    );
    requireThat(
      !draft.coOrganizers.includes(draft.club) &&
        draft.coOrganizers.every((club) =>
          this.store.db.prepare('SELECT 1 FROM clubs WHERE id=?').get(club),
        ),
      'Known co-organizers required',
    );
    requireThat(this.readableArtifact(actor, draft.brief), 'Readable event brief required');
    requireThat(
      !this.store.db.prepare('SELECT 1 FROM planning_documents WHERE artifact=?').get(draft.brief),
      'Private planning evidence cannot be an event brief',
    );
  }

  private cancelWorkflows(event: string) {
    for (const row of this.store.db
      .prepare('SELECT state FROM workflows WHERE event=?')
      .all(event)) {
      const workflow = JSON.parse(String(row.state)) as ApprovalInstance;
      if (workflow.status !== 'active' && workflow.status !== 'approved') continue;
      workflow.status = 'cancelled';
      workflow.deadlineMs = null;
      this.saveWorkflow(workflow);
    }
  }

  private artifact(id: string) {
    const row = this.store.db.prepare('SELECT * FROM office_artifacts WHERE id=?').get(id);
    requireThat(row, 'Artifact not found');
    return row;
  }

  private metadata(id: string): OfficeArtifact {
    const row = this.artifact(id);
    return {
      id,
      club: String(row.club),
      owner: String(row.owner),
      title: String(row.title),
      mime: String(row.mime),
      size: (row.content as Uint8Array).byteLength,
      parent: row.parent === null ? null : String(row.parent),
      visibility: row.visibility as OfficeArtifact['visibility'],
      createdAt: Number(row.created_at),
    };
  }

  private readableArtifact(actor: string, id: string) {
    const row = this.artifact(id);
    if (
      this.store.db
        .prepare("SELECT 1 FROM planning_documents WHERE artifact=? AND audience='event'")
        .get(id)
    )
      return (
        this.identity.isGlobalAdministrator(actor) ||
        planDocumentsReadable(this.store, this.identity, actor, id)
      );
    return (
      row.owner === actor ||
      (row.visibility === 'club' && this.active(actor, String(row.club))) ||
      !!this.store.db
        .prepare('SELECT 1 FROM artifact_readers WHERE artifact=? AND account=?')
        .get(id, actor) ||
      this.identity.isGlobalAdministrator(actor) ||
      planDocumentsReadable(this.store, this.identity, actor, id) ||
      this.store.db
        .prepare(
          'SELECT a.state FROM event_artifacts e JOIN activities a ON a.id=e.event WHERE e.artifact=?',
        )
        .all(id)
        .some((event) => this.visible(actor, JSON.parse(String(event.state)) as ActivityRecord)) ||
      this.store.db
        .prepare("SELECT state FROM workflows WHERE json_extract(state,'$.brief')=?")
        .all(id)
        .some((row) =>
          this.workflowReadable(actor, JSON.parse(String(row.state)) as ApprovalInstance),
        )
    );
  }

  upload(actor: string, input: OfficeArtifactUpload) {
    return this.identity.action(actor, `club:${input.club}`, 'upload_artifact', () => {
      this.identity.authenticate(actor);
      requireThat(this.active(actor, input.club), 'Active artifact membership required');
      const content = Buffer.from(input.content, 'base64');
      requireThat(
        content.byteLength > 0 &&
          content.byteLength <= MAX_ARTIFACT_BYTES &&
          content.toString('base64') === input.content,
        'Valid base64 artifact required',
      );
      let visibility = input.visibility ?? 'club';
      if (input.parent) {
        const parent = this.artifact(input.parent);
        requireThat(
          this.readableArtifact(actor, input.parent) &&
            parent.club === input.club &&
            (parent.owner === actor || this.identity.decide(actor, `club:${input.club}`, 'manage')),
          'Artifact revision authority required',
        );
        visibility = input.visibility ?? (parent.visibility as OfficeArtifact['visibility']);
      }
      const id = randomUUID();
      return () => {
        this.store.db
          .prepare(
            'INSERT INTO office_artifacts(id,club,owner,title,mime,content,parent,created_at,visibility) VALUES(?,?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            input.club,
            actor,
            input.title,
            input.mime,
            content,
            input.parent ?? null,
            Date.now(),
            visibility,
          );
        appendAudit(this.store, actor, `club:${input.club}`, 'upload_artifact', id, {
          title: input.title,
          mime: input.mime,
          size: content.byteLength,
          parent: input.parent,
          visibility,
        });
        return this.metadata(id);
      };
    });
  }

  artifactContent(actor: string, id: string) {
    this.identity.authenticate(actor);
    requireThat(this.readableArtifact(actor, id), 'Artifact access required');
    const row = this.artifact(id);
    return { content: Buffer.from(row.content as Uint8Array), metadata: this.metadata(id) };
  }

  download(actor: string, id: string) {
    return this.store.transaction(() => {
      const artifact = this.artifactContent(actor, id);
      return { content: artifact.content, mime: artifact.metadata.mime };
    });
  }

  create(actor: string, draft: ActivityDraft) {
    return this.identity.authorized(actor, `club:${draft.club}`, 'manage', () => {
      this.validateDraft(actor, draft);
      requireThat(
        !this.store.db.prepare('SELECT 1 FROM activities WHERE id=?').get(draft.id),
        'Event already exists',
      );
      const event: ActivityRecord = { ...draft, creator: actor, epoch: 1, phase: 'draft' };
      this.store.db
        .prepare('INSERT INTO activities VALUES(?,?,?)')
        .run(event.id, event.club, JSON.stringify(event));
      this.store.db.prepare('INSERT INTO event_artifacts VALUES(?,?)').run(event.id, event.brief);
      appendAudit(this.store, actor, `event:${event.id}`, 'create', event.id, draft);
      return event;
    });
  }

  revise(actor: string, id: string, draft: ActivityDraft) {
    return this.identity.authorized(actor, `event:${id}`, 'manage', () => {
      const current = this.load(id);
      this.mutable(current);
      requireThat(draft.id === id && draft.club === current.club, 'Event identity is immutable');
      this.validateDraft(actor, draft);
      const event: ActivityRecord = {
        ...draft,
        creator: current.creator,
        epoch: current.epoch + 1,
        phase: 'draft',
      };
      this.cancelWorkflows(id);
      releasePlanResources(this.store, id);
      this.store.db.prepare('DELETE FROM event_plans WHERE event=?').run(id);
      this.store.db.prepare('DELETE FROM event_attendance WHERE event=?').run(id);
      this.save(event);
      this.store.db.prepare('DELETE FROM event_artifacts WHERE event=?').run(id);
      this.store.db.prepare('INSERT INTO event_artifacts VALUES(?,?)').run(id, event.brief);
      appendAudit(this.store, actor, `event:${id}`, 'revise', id, event);
      return event;
    });
  }

  list(actor: string) {
    return this.store.transaction(() => {
      this.identity.authenticate(actor);
      return this.store.db
        .prepare('SELECT state FROM activities ORDER BY id')
        .all()
        .map((row) => JSON.parse(String(row.state)) as ActivityRecord)
        .filter((event) => this.visible(actor, event));
    });
  }

  snapshot(actor: string, id: string) {
    return this.store.transaction(() => {
      this.identity.authenticate(actor);
      const event = this.load(id);
      requireThat(this.visible(actor, event), 'Event access required');
      return event;
    });
  }

  eventAction(actor: string, id: string, command: ActivityCommand) {
    const manage = ['submit', 'publish', 'finish', 'cancel'].includes(command.action);
    const apply = () => {
      this.identity.authenticate(actor);
      const event = this.load(id);
      this.mutable(event);
      const time = Date.now();
      switch (command.action) {
        case 'submit':
          requireThat(event.phase === 'draft', 'Draft event required');
          requirePlanReady(this.store, this.identity, event);
          event.phase = 'review';
          break;
        case 'publish':
          requirePlanReady(this.store, this.identity, event);
          requireThat(
            event.phase === 'approved' && time < event.window.closesMs,
            'Approved event required',
          );
          event.phase = 'open';
          break;
        case 'finish':
          requireThat(
            event.phase === 'open' && time >= event.window.startsMs,
            'Started event required',
          );
          event.phase = 'done';
          releasePlanResources(this.store, id);
          break;
        case 'cancel':
          event.phase = 'cancelled';
          this.cancelWorkflows(id);
          releasePlanResources(this.store, id);
          break;
        case 'signup': {
          requireThat(
            event.phase === 'open' && time >= event.window.opensMs && time < event.window.closesMs,
            'Event registration closed',
          );
          requireThat(
            !this.store.db
              .prepare('SELECT 1 FROM event_attendance WHERE event=? AND account=?')
              .get(id, actor),
            'Event signup already exists',
          );
          let club = this.identity.affiliation(actor);
          const plan = loadPlan(this.store, id);
          if (plan) {
            requirePlanReady(this.store, this.identity, event);
            const roster = plan.clubs.find((entry) => entry.participants.includes(actor));
            club =
              roster?.club ??
              this.identity.affiliation(
                actor,
                plan.clubs.map((entry) => entry.club),
              );
            requireThat(
              plan.clubs.some((entry) => entry.club === club) && (plan.kind === 'online' || roster),
              'Planned club and meeting participant required',
            );
            this.identity.requireMembership(actor, club);
          }
          this.store.db
            .prepare('INSERT INTO event_attendance VALUES(?,?,?,?,NULL)')
            .run(id, actor, club, time);
          break;
        }
        case 'cancel_signup':
          requireThat(
            this.store.db
              .prepare(
                'DELETE FROM event_attendance WHERE event=? AND account=? AND checked_in_at IS NULL',
              )
              .run(id, actor).changes,
            'Unconfirmed signup required',
          );
          break;
        case 'checkin':
          requirePlanReady(this.store, this.identity, event);
          requireThat(
            event.phase === 'open' && time >= event.checkinOpensMs && time < event.checkinClosesMs,
            'Event check-in closed',
          );
          requireThat(
            this.store.db
              .prepare(
                "UPDATE event_attendance SET checked_in_at=? WHERE event=? AND account=? AND checked_in_at IS NULL AND EXISTS(SELECT 1 FROM memberships m WHERE m.account=event_attendance.account AND m.club=event_attendance.club AND m.status='active')",
              )
              .run(time, id, actor).changes,
            'Active signup required',
          );
          break;
      }
      this.save(event);
      appendAudit(this.store, actor, `event:${id}`, command.action, id, command);
      return event;
    };
    return manage
      ? this.identity.authorized(actor, `event:${id}`, 'manage', apply)
      : this.store.transaction(apply);
  }

  attendance(actor: string, id: string): ActivityAttendance {
    return this.identity.authorized(actor, `event:${id}`, 'manage', () => ({
      members: this.store.db
        .prepare('SELECT * FROM event_attendance WHERE event=? ORDER BY signed_up_at,account')
        .all(id)
        .map((row) => ({
          account: String(row.account),
          club: String(row.club),
          signedUpAt: Number(row.signed_up_at),
          checkedInAt: row.checked_in_at === null ? null : Number(row.checked_in_at),
        })),
    }));
  }

  private task(id: string): ActivityTask {
    const row = this.store.db.prepare('SELECT * FROM activity_tasks WHERE id=?').get(id);
    requireThat(row, 'Task not found');
    return {
      id,
      event: String(row.event),
      title: String(row.title),
      dueMs: row.due_ms === null ? null : Number(row.due_ms),
      assignee: row.assignee === null ? null : String(row.assignee),
      done: row.done === 1,
    };
  }

  createTask(actor: string, event: string, input: ActivityTaskCreate) {
    return this.identity.authorized(actor, `event:${event}`, 'manage', () => {
      this.mutable(this.load(event));
      requireThat(
        input.dueMs === null || input.dueMs > Date.now(),
        'Future task deadline required',
      );
      requireThat(
        !this.store.db.prepare('SELECT 1 FROM activity_tasks WHERE id=?').get(input.id),
        'Task already exists',
      );
      this.store.db
        .prepare('INSERT INTO activity_tasks(id,event,title,due_ms) VALUES(?,?,?,?)')
        .run(input.id, event, input.title, input.dueMs);
      appendAudit(this.store, actor, `event:${event}`, 'create_task', input.id, input);
      return this.task(input.id);
    });
  }

  tasks(actor: string, id: string) {
    return this.store.transaction(() => {
      this.identity.authenticate(actor);
      const event = this.load(id);
      requireThat(this.visible(actor, event), 'Event access required');
      const manage = this.identity.decide(actor, `event:${id}`, 'manage');
      return this.store.db
        .prepare('SELECT id FROM activity_tasks WHERE event=? ORDER BY id')
        .all(id)
        .map((row) => this.task(String(row.id)))
        .filter(
          (task) =>
            manage ||
            (task.assignee === actor && this.clubs(event).some((club) => this.active(actor, club))),
        );
    });
  }

  taskAction(actor: string, id: string, command: ActivityTaskCommand) {
    const task = this.task(id);
    if (command.action === 'complete') {
      return this.identity.action(actor, `event:${task.event}`, 'complete_task', () => {
        this.identity.authenticate(actor);
        const current = this.task(id);
        const event = this.load(current.event);
        this.mutable(event);
        requireThat(!current.done, 'Open task required');
        requireThat(
          (current.assignee === actor &&
            this.clubs(event).some((club) => this.active(actor, club))) ||
            this.identity.decide(actor, `event:${current.event}`, 'manage'),
          'Task assignee or manager required',
        );
        return () => {
          this.store.db.prepare('UPDATE activity_tasks SET done=1 WHERE id=?').run(id);
          appendAudit(this.store, actor, `event:${current.event}`, 'task_complete', id, command);
          return this.task(id);
        };
      });
    }
    const apply = () => {
      this.identity.authenticate(actor);
      const current = this.task(id);
      const event = this.load(current.event);
      this.mutable(event);
      requireThat(!current.done, 'Open task required');
      switch (command.action) {
        case 'assign':
          requireThat(
            this.clubs(event).some((club) => this.active(command.account, club)),
            'Participating task assignee required',
          );
          this.store.db
            .prepare('UPDATE activity_tasks SET assignee=? WHERE id=?')
            .run(command.account, id);
          this.store.db.prepare('DELETE FROM activity_notices WHERE task=?').run(id);
          break;
        case 'notify':
          requireThat(
            current.assignee &&
              this.clubs(event).some((club) => this.active(current.assignee!, club)) &&
              command.dueMs >= Date.now(),
            'Active assignee and future notice required',
          );
          this.store.db
            .prepare(
              'INSERT INTO activity_notices VALUES(?,?,?,?,?,NULL) ON CONFLICT(task) DO UPDATE SET account=excluded.account,due_ms=excluded.due_ms,acknowledged_at=NULL',
            )
            .run(id, current.event, id, current.assignee, command.dueMs);
          break;
      }
      appendAudit(
        this.store,
        actor,
        `event:${current.event}`,
        `task_${command.action}`,
        id,
        command,
      );
      return this.task(id);
    };
    return this.identity.authorized(actor, `event:${task.event}`, 'manage', apply);
  }

  notices(actor: string): ActivityNoticeList {
    return this.store.transaction(() => {
      this.identity.authenticate(actor);
      return {
        notices: this.store.db
          .prepare('SELECT * FROM activity_notices WHERE account=? ORDER BY due_ms,id')
          .all(actor)
          .map((row) => ({
            id: String(row.id),
            event: String(row.event),
            task: String(row.task),
            account: String(row.account),
            dueMs: Number(row.due_ms),
            acknowledgedAt: row.acknowledged_at === null ? null : Number(row.acknowledged_at),
          })),
      };
    });
  }

  acknowledge(actor: string, id: string) {
    this.store.transaction(() => {
      this.identity.authenticate(actor);
      requireThat(
        this.store.db
          .prepare(
            'UPDATE activity_notices SET acknowledged_at=? WHERE id=? AND account=? AND due_ms<=? AND acknowledged_at IS NULL',
          )
          .run(Date.now(), id, actor, Date.now()).changes,
        'Due personal notice required',
      );
      appendAudit(this.store, actor, 'global', 'acknowledge_notice', id, {});
    });
  }

  private validateStage(stage: ApprovalStage, index: number, count: number) {
    requireThat(
      stage.name.trim() && (stage.onTimeout !== 'escalate' || index < count - 1),
      'Invalid approval escalation',
    );
    const approver = stage.approver;
    if (approver.kind === 'member')
      requireThat(this.active(approver.account), 'Active approver required');
    if (approver.kind === 'role') {
      requireThat(
        this.store.db.prepare('SELECT 1 FROM clubs WHERE id=?').get(approver.club),
        'Known approver club required',
      );
      requireThat(approver.role.trim(), 'Approver role required');
    }
    if (approver.kind === 'club_quorum' || approver.kind === 'presidents') {
      requireThat(
        approver.clubs.every((club) =>
          this.store.db.prepare('SELECT 1 FROM clubs WHERE id=?').get(club),
        ),
        'Known approval clubs required',
      );
      if (approver.kind === 'club_quorum')
        requireThat(approver.quorum <= approver.clubs.length, 'Invalid club quorum');
      else
        requireThat(
          stage.timeoutMs === null && stage.onTimeout === 'reject',
          'President consent cannot expire automatically',
        );
    }
  }

  putTemplate(actor: string, template: ApprovalTemplate) {
    return this.identity.authorized(actor, `club:${template.club}`, 'manage', () => {
      const existing = this.store.db
        .prepare('SELECT club FROM approval_templates WHERE id=?')
        .get(template.id);
      requireThat(!existing || existing.club === template.club, 'Template club is immutable');
      template.stages.forEach((stage, index) =>
        this.validateStage(stage, index, template.stages.length),
      );
      this.store.db
        .prepare(
          'INSERT INTO approval_templates VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition',
        )
        .run(template.id, template.club, JSON.stringify(template));
      appendAudit(
        this.store,
        actor,
        `club:${template.club}`,
        'approval_template',
        template.id,
        template,
      );
      return template;
    });
  }

  templates(actor: string, club: string) {
    return this.store.transaction(() => {
      this.identity.authenticate(actor);
      requireThat(
        this.active(actor, club) || this.identity.isGlobalAdministrator(actor),
        'Template club membership required',
      );
      return this.store.db
        .prepare('SELECT definition FROM approval_templates WHERE club=? ORDER BY id')
        .all(club)
        .map((row) => JSON.parse(String(row.definition)) as ApprovalTemplate);
    });
  }

  private loadWorkflow(id: string): ApprovalInstance {
    const row = this.store.db.prepare('SELECT state FROM workflows WHERE id=?').get(id);
    requireThat(row, 'Workflow not found');
    return JSON.parse(String(row.state)) as ApprovalInstance;
  }

  private saveWorkflow(workflow: ApprovalInstance) {
    this.store.db
      .prepare('UPDATE workflows SET state=? WHERE id=?')
      .run(JSON.stringify(workflow), workflow.id);
  }

  start(actor: string, input: ApprovalStart) {
    return this.identity.authorized(actor, `event:${input.event}`, 'manage', () => {
      const event = this.load(input.event);
      requireThat(
        event.phase === 'review' && event.epoch === input.epoch,
        'Current event review required',
      );
      requirePlanReady(this.store, this.identity, event);
      requireThat(
        !this.store.db
          .prepare(
            "SELECT 1 FROM workflows WHERE event=? AND json_extract(state,'$.epoch')=? AND json_extract(state,'$.status') IN ('active','approved')",
          )
          .get(event.id, event.epoch),
        'Event workflow already pending',
      );
      let stages: ApprovalStage[] = [];
      if (input.template) {
        const row = this.store.db
          .prepare('SELECT definition FROM approval_templates WHERE id=?')
          .get(input.template);
        requireThat(row, 'Approval template not found');
        const template = JSON.parse(String(row.definition)) as ApprovalTemplate;
        requireThat(
          template.active && template.club === event.club,
          'Active event-club template required',
        );
        stages = template.stages;
        stages.forEach((stage, index) => this.validateStage(stage, index, stages.length));
      }
      stages.push({
        name: 'Club approval',
        approver: { kind: 'presidents', clubs: this.clubs(event) },
        timeoutMs: null,
        onTimeout: 'reject',
      });
      const time = Date.now();
      const workflow: ApprovalInstance = {
        id: randomUUID(),
        club: event.club,
        event: event.id,
        brief: loadPlan(this.store, event.id)?.polished ?? event.brief,
        epoch: event.epoch,
        proposer: actor,
        stages,
        current: 0,
        status: 'active',
        startedAt: time,
        deadlineMs: stages[0].timeoutMs === null ? null : time + stages[0].timeoutMs,
        records: stages.map(() => ({
          approvals: {},
          delegations: {},
          rejected: null,
          escalated: false,
          autoApproved: false,
        })),
      };
      this.store.db
        .prepare('INSERT INTO workflows VALUES(?,?,?,?)')
        .run(workflow.id, workflow.club, workflow.event, JSON.stringify(workflow));
      appendAudit(this.store, actor, `workflow:${workflow.id}`, 'start', workflow.id, input);
      return workflow;
    });
  }

  private eligible(approver: ApprovalApprover, actor: string, club?: string): string | undefined {
    if (!this.active(actor)) return undefined;
    if (approver.kind === 'member') return approver.account === actor ? 'member' : undefined;
    if (approver.kind === 'role') {
      if (!this.active(actor, approver.club)) return undefined;
      if (approver.role === 'president')
        return this.chair(actor, approver.club) ? 'role' : undefined;
      const row = this.store.db
        .prepare('SELECT roles FROM memberships WHERE account=? AND club=?')
        .get(actor, approver.club)!;
      return approver.role === 'member' ||
        (JSON.parse(String(row.roles)) as string[]).includes(approver.role)
        ? 'role'
        : undefined;
    }
    return approver.clubs.find(
      (candidate) =>
        (!club || candidate === club) &&
        (approver.kind === 'presidents'
          ? this.chair(actor, candidate)
          : this.active(actor, candidate)),
    );
  }

  private sharedClub(first: string, second: string, club?: string) {
    return !!this.store.db
      .prepare(
        "SELECT 1 FROM memberships a JOIN memberships b ON b.club=a.club WHERE a.account=? AND b.account=? AND a.status='active' AND b.status='active' AND (? IS NULL OR a.club=?)",
      )
      .get(first, second, club ?? null, club ?? null);
  }

  private slot(approver: ApprovalApprover, record: ApprovalRecord, actor: string, club?: string) {
    if (!this.active(actor)) return undefined;
    for (const [slot, delegation] of Object.entries(record.delegations)) {
      if (
        delegation.to === actor &&
        (!club || club === slot) &&
        this.eligible(approver, delegation.from, slot) === slot &&
        this.sharedClub(
          delegation.from,
          actor,
          approver.kind === 'role'
            ? approver.club
            : approver.kind === 'club_quorum'
              ? slot
              : undefined,
        )
      )
        return slot;
    }
    const own = this.eligible(approver, actor, club);
    if (!own) return undefined;
    const delegation = Object.hasOwn(record.delegations, own) ? record.delegations[own] : undefined;
    return delegation && this.eligible(approver, delegation.from, own) === own ? undefined : own;
  }

  private approved(stage: ApprovalStage, record: ApprovalRecord) {
    const threshold =
      stage.approver.kind === 'presidents'
        ? stage.approver.clubs.length
        : stage.approver.kind === 'club_quorum'
          ? stage.approver.quorum
          : 1;
    return (
      Object.entries(record.approvals).filter(
        ([slot, vote]) => this.slot(stage.approver, record, vote.account, slot) === slot,
      ).length >= threshold
    );
  }

  private workflowReadable(actor: string, workflow: ApprovalInstance) {
    return (
      workflow.proposer === actor ||
      this.active(actor, workflow.club) ||
      this.identity.isGlobalAdministrator(actor) ||
      workflow.stages.some(
        (stage, index) =>
          !!this.eligible(stage.approver, actor) ||
          !!this.slot(stage.approver, workflow.records[index], actor),
      )
    );
  }

  private advance(workflow: ApprovalInstance) {
    workflow.current++;
    if (workflow.current === workflow.stages.length) {
      workflow.status = 'approved';
      workflow.deadlineMs = null;
    } else {
      const timeout = workflow.stages[workflow.current].timeoutMs;
      workflow.deadlineMs = timeout === null ? null : Date.now() + timeout;
    }
  }

  workflows(actor: string, event: string) {
    return this.store.transaction(() => {
      this.identity.authenticate(actor);
      const current = this.load(event);
      const workflows = this.store.db
        .prepare('SELECT state FROM workflows WHERE event=? ORDER BY id')
        .all(event)
        .map((row) => JSON.parse(String(row.state)) as ApprovalInstance)
        .filter((workflow) => this.workflowReadable(actor, workflow));
      requireThat(
        workflows.length || this.visible(actor, current),
        'Workflow event access required',
      );
      return workflows;
    });
  }

  workflowAction(actor: string, id: string, command: ApprovalCommand) {
    return this.identity.action(actor, `workflow:${id}`, command.action, () => {
      this.identity.authenticate(actor);
      const workflow = this.loadWorkflow(id);
      const event = this.load(workflow.event);
      requireThat(this.workflowReadable(actor, workflow), 'Workflow event access required');
      const time = Date.now();
      if (command.action === 'execute') {
        requirePlanReady(this.store, this.identity, event);
        requireThat(
          workflow.status === 'approved' &&
            event.phase === 'review' &&
            event.epoch === workflow.epoch,
          'Current approved workflow required',
        );
        requireThat(
          this.identity.decide(workflow.proposer, `event:${event.id}`, 'manage'),
          'Current workflow proposer authority required',
        );
        requireThat(
          actor === workflow.proposer ||
            this.identity.decide(actor, `event:${event.id}`, 'manage') ||
            this.clubs(event).some((club) => this.chair(actor, club)),
          'Workflow execution authority required',
        );
        requireThat(
          workflow.stages.every((stage, index) => {
            const evidence = workflow.records[index];
            return evidence.escalated || evidence.autoApproved || this.approved(stage, evidence);
          }),
          'Current approval authority required',
        );
        event.phase = 'approved';
        workflow.status = 'executed';
      } else if (command.action === 'cancel') {
        requireThat(
          (workflow.status === 'active' || workflow.status === 'approved') &&
            (workflow.proposer === actor ||
              this.identity.decide(actor, `event:${event.id}`, 'manage')),
          'Workflow cancellation authority required',
        );
        workflow.status = 'cancelled';
        workflow.deadlineMs = null;
      } else {
        requireThat(
          workflow.status === 'active' &&
            event.phase === 'review' &&
            event.epoch === workflow.epoch,
          'Current active workflow required',
        );
        const stage = workflow.stages[workflow.current];
        const evidence = workflow.records[workflow.current];
        if (command.action === 'poke') {
          requireThat(
            workflow.deadlineMs !== null && time >= workflow.deadlineMs,
            'Approval deadline has not elapsed',
          );
          if (stage.onTimeout === 'reject') {
            workflow.status = 'rejected';
            workflow.deadlineMs = null;
          } else {
            evidence.escalated = stage.onTimeout === 'escalate';
            evidence.autoApproved = stage.onTimeout === 'approve';
            this.advance(workflow);
          }
        } else {
          requireThat(
            workflow.deadlineMs === null || time < workflow.deadlineMs,
            'Approval deadline elapsed',
          );
          if (command.action === 'delegate') {
            requireThat(
              stage.approver.kind !== 'presidents',
              'President approvals require the current chair',
            );
            const slot = this.eligible(stage.approver, actor, command.club);
            requireThat(
              slot &&
                command.to !== actor &&
                this.active(command.to) &&
                this.sharedClub(
                  actor,
                  command.to,
                  stage.approver.kind === 'role'
                    ? stage.approver.club
                    : stage.approver.kind === 'club_quorum'
                      ? slot
                      : undefined,
                ),
              'Same-club approval delegation required',
            );
            const previous = Object.hasOwn(evidence.approvals, slot) && evidence.approvals[slot];
            requireThat(
              !previous || this.slot(stage.approver, evidence, previous.account, slot) !== slot,
              'Approval already recorded',
            );
            Object.defineProperty(evidence.delegations, slot, {
              value: { from: actor, to: command.to },
              enumerable: true,
              writable: true,
              configurable: true,
            });
          } else if (command.action === 'approve' || command.action === 'reject') {
            const slot = this.slot(stage.approver, evidence, actor, command.club);
            requireThat(slot && command.comment.trim(), 'Eligible approver and comment required');
            if (command.action === 'reject') {
              evidence.rejected = command.comment;
              workflow.status = 'rejected';
              workflow.deadlineMs = null;
            } else {
              const previous = Object.hasOwn(evidence.approvals, slot) && evidence.approvals[slot];
              requireThat(
                !previous || this.slot(stage.approver, evidence, previous.account, slot) !== slot,
                'Approval already recorded',
              );
              Object.defineProperty(evidence.approvals, slot, {
                value: { account: actor, comment: command.comment, at: time },
                enumerable: true,
                writable: true,
                configurable: true,
              });
              if (this.approved(stage, evidence)) this.advance(workflow);
            }
          }
        }
      }
      return () => {
        if (command.action === 'execute') this.save(event);
        this.saveWorkflow(workflow);
        appendAudit(this.store, actor, `workflow:${id}`, command.action, id, command);
        return workflow;
      };
    });
  }
}

export function registerOffice(app: FastifyInstance, store: Store, identity: LocalIdentity) {
  const office = new Office(store, identity);
  const actor = (request: FastifyRequest) =>
    store.token(bearer(request.headers.authorization), undefined, now()).id;
  const id = (request: FastifyRequest) => field(record(request.params).id, 128);
  app.post<{ Body: OfficeArtifactUpload }>(
    '/api/artifacts',
    {
      bodyLimit: MAX_ARTIFACT_REQUEST_BYTES,
      schema: { body: officeArtifactUploadSchema, response: { 200: officeArtifactSchema } },
    },
    async (request) => office.upload(actor(request), request.body),
  );
  app.get('/api/artifacts/:id/content', async (request, reply) => {
    const artifact = office.download(actor(request), id(request));
    return reply
      .type(artifact.mime)
      .header('content-disposition', 'attachment')
      .send(artifact.content);
  });
  app.get(
    '/api/events',
    { schema: { response: { 200: activityListSchema } } },
    async (request) => ({ events: office.list(actor(request)) }),
  );
  app.post<{ Body: ActivityDraft }>(
    '/api/events',
    {
      schema: { body: activityDraftSchema, response: { 200: activityRecordSchema } },
    },
    async (request) => office.create(actor(request), request.body),
  );
  app.put<{ Body: ActivityDraft }>(
    '/api/events/:id',
    {
      schema: { body: activityDraftSchema, response: { 200: activityRecordSchema } },
    },
    async (request) => office.revise(actor(request), id(request), request.body),
  );
  app.get(
    '/api/events/:id',
    { schema: { response: { 200: activityRecordSchema } } },
    async (request) => office.snapshot(actor(request), id(request)),
  );
  app.post<{ Body: ActivityCommand }>(
    '/api/events/:id/actions',
    {
      schema: { body: activityCommandSchema, response: { 200: activityRecordSchema } },
    },
    async (request) => office.eventAction(actor(request), id(request), request.body),
  );
  app.get(
    '/api/events/:id/attendance',
    { schema: { response: { 200: activityAttendanceSchema } } },
    async (request) => office.attendance(actor(request), id(request)),
  );
  app.get(
    '/api/events/:id/tasks',
    { schema: { response: { 200: activityTaskListSchema } } },
    async (request) => ({ tasks: office.tasks(actor(request), id(request)) }),
  );
  app.post<{ Body: ActivityTaskCreate }>(
    '/api/events/:id/tasks',
    {
      schema: { body: activityTaskCreateSchema, response: { 200: activityTaskSchema } },
    },
    async (request) => office.createTask(actor(request), id(request), request.body),
  );
  app.post<{ Body: ActivityTaskCommand }>(
    '/api/tasks/:id/actions',
    {
      schema: { body: activityTaskCommandSchema, response: { 200: activityTaskSchema } },
    },
    async (request) => office.taskAction(actor(request), id(request), request.body),
  );
  app.get(
    '/api/notices',
    { schema: { response: { 200: activityNoticeListSchema } } },
    async (request) => office.notices(actor(request)),
  );
  app.post('/api/notices/:id/acknowledge', async (request, reply) => {
    office.acknowledge(actor(request), id(request));
    return reply.code(204).send();
  });
  app.post<{ Body: ApprovalTemplate }>(
    '/api/approval-templates',
    {
      schema: { body: approvalTemplateSchema, response: { 200: approvalTemplateSchema } },
    },
    async (request) => office.putTemplate(actor(request), request.body),
  );
  app.get(
    '/api/clubs/:id/approval-templates',
    { schema: { response: { 200: approvalTemplateListSchema } } },
    async (request) => ({ templates: office.templates(actor(request), id(request)) }),
  );
  app.post<{ Body: ApprovalStart }>(
    '/api/workflows',
    {
      schema: { body: approvalStartSchema, response: { 200: approvalInstanceSchema } },
    },
    async (request) => office.start(actor(request), request.body),
  );
  app.get(
    '/api/events/:id/workflows',
    { schema: { response: { 200: approvalListSchema } } },
    async (request) => ({ workflows: office.workflows(actor(request), id(request)) }),
  );
  app.post<{ Body: ApprovalCommand }>(
    '/api/workflows/:id/actions',
    {
      schema: { body: approvalCommandSchema, response: { 200: approvalInstanceSchema } },
    },
    async (request) => office.workflowAction(actor(request), id(request), request.body),
  );
  return office;
}
