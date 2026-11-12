import type {
  AiJob,
  AiReview,
  ActivityRecord,
  ApprovalInstance,
  OfficeAiTask,
} from '../shared/contracts/generated.js';
import type { LocalIdentity } from './permissions.js';
import { loadPlan } from './planning-state.js';
import { requireThat, type Store } from './store.js';

export function loadOfficeAiTask(store: Store, id: string): OfficeAiTask {
  const row = store.db.prepare('SELECT state FROM office_ai_tasks WHERE id=?').get(id);
  requireThat(row, 'Document task not found');
  return JSON.parse(String(row.state)) as OfficeAiTask;
}

export function officeAiTaskCurrent(
  store: Store,
  task: Pick<OfficeAiTask, 'event' | 'plan' | 'epoch' | 'kind' | 'workflow' | 'stage'>,
) {
  const row = store.db.prepare('SELECT state FROM activities WHERE id=?').get(task.event);
  if (!row) return false;
  const event = JSON.parse(String(row.state)) as ActivityRecord;
  const plan = loadPlan(store, event.id);
  if (event.epoch !== task.epoch || plan?.id !== task.plan || !plan.finalized) return false;
  if (task.kind === 'polish') return event.phase === 'draft' && plan.polished === null;
  if (task.kind === 'summary')
    return (
      event.phase === 'done' &&
      !!store.db
        .prepare('SELECT 1 FROM event_settlements WHERE event=? AND plan=?')
        .get(event.id, plan.id) &&
      !store.db.prepare('SELECT 1 FROM event_summaries WHERE event=?').get(event.id)
    );
  const workflowRow = store.db.prepare('SELECT state FROM workflows WHERE id=?').get(task.workflow);
  if (!workflowRow) return false;
  const workflow = JSON.parse(String(workflowRow.state)) as ApprovalInstance;
  return (
    event.phase === 'review' &&
    workflow.status === 'active' &&
    workflow.epoch === task.epoch &&
    workflow.event === event.id &&
    workflow.current === task.stage &&
    workflow.stages[workflow.current]?.approver.kind === 'ai' &&
    (workflow.deadlineMs === null || Date.now() < workflow.deadlineMs)
  );
}

export function requireOfficeAiJobCurrent(store: Store, job: string) {
  const row = store.db.prepare('SELECT state FROM office_ai_tasks WHERE job=?').get(job);
  if (!row) return;
  const task = JSON.parse(String(row.state)) as OfficeAiTask;
  requireThat(
    task.appliedAt === null && officeAiTaskCurrent(store, task),
    'Current document task required',
  );
}

export function restrictOfficeAiOutput(store: Store, job: string, artifact: string) {
  const row = store.db.prepare('SELECT id FROM office_ai_tasks WHERE job=?').get(job);
  if (row)
    store.db.prepare('INSERT INTO office_ai_artifacts VALUES(?,?)').run(artifact, String(row.id));
}

function publicOutput(store: Store, task: OfficeAiTask, artifact: string) {
  return (
    task.appliedAt !== null &&
    task.output === artifact &&
    (task.kind === 'polish' ||
      (task.kind === 'summary' &&
        !!store.db
          .prepare(
            'SELECT 1 FROM event_summaries WHERE event=? AND output=? AND published_at IS NOT NULL',
          )
          .get(task.event, artifact)))
  );
}

export function privateOfficeAiArtifact(store: Store, artifact: string) {
  const rows = store.db
    .prepare(
      'SELECT t.state FROM office_ai_artifacts a JOIN office_ai_tasks t ON t.id=a.task WHERE a.artifact=?',
    )
    .all(artifact);
  return (
    rows.length > 0 &&
    !rows.some((row) =>
      publicOutput(store, JSON.parse(String(row.state)) as OfficeAiTask, artifact),
    )
  );
}

export function officeAiArtifactAccess(
  store: Store,
  identity: LocalIdentity,
  actor: string,
  artifact: string,
): boolean | undefined {
  if (!privateOfficeAiArtifact(store, artifact)) return undefined;
  if (identity.isGlobalAdministrator(actor)) return true;
  return store.db
    .prepare(
      'SELECT t.state FROM office_ai_artifacts a JOIN office_ai_tasks t ON t.id=a.task WHERE a.artifact=?',
    )
    .all(artifact)
    .some((row) => {
      const task = JSON.parse(String(row.state)) as OfficeAiTask;
      const eventRow = store.db.prepare('SELECT state FROM activities WHERE id=?').get(task.event);
      const event = eventRow && (JSON.parse(String(eventRow.state)) as ActivityRecord | undefined);
      return (
        event?.epoch === task.epoch &&
        loadPlan(store, task.event)?.id === task.plan &&
        identity.decide(actor, `event:${task.event}`, 'manage')
      );
    });
}

export function approvedAiStage(
  store: Store,
  identity: LocalIdentity,
  workflow: ApprovalInstance,
  index: number,
) {
  const vote = workflow.records[index].approvals.ai;
  if (!vote) return false;
  const row = store.db
    .prepare('SELECT state,job FROM office_ai_tasks WHERE id=?')
    .get(vote.comment);
  if (!row) return false;
  const task = JSON.parse(String(row.state)) as OfficeAiTask;
  const jobRow = store.db.prepare('SELECT state FROM ai_jobs WHERE id=?').get(String(row.job));
  if (!jobRow) return false;
  const job = JSON.parse(String(jobRow.state)) as Pick<
    AiJob,
    'providerAccount' | 'providerClub' | 'status' | 'attempts'
  >;
  const attempt = job.attempts.at(-1);
  if (
    task.kind !== 'review' ||
    task.workflow !== workflow.id ||
    task.stage !== index ||
    task.epoch !== workflow.epoch ||
    task.appliedAt === null ||
    !task.output ||
    job.status !== 'completed' ||
    attempt?.output !== task.output ||
    attempt.truncated ||
    attempt.error !== null ||
    vote.account !== job.providerAccount ||
    !identity.isActiveMember(job.providerAccount, job.providerClub)
  )
    return false;
  const artifact = store.db
    .prepare('SELECT content FROM office_artifacts WHERE id=?')
    .get(task.output);
  if (!artifact) return false;
  const review = JSON.parse(
    Buffer.from(artifact.content as Uint8Array).toString('utf8'),
  ) as AiReview;
  return review.decision === 'approve';
}
