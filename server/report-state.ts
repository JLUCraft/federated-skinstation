import type { ClubReport } from '../shared/contracts/generated.js';
import type { LocalIdentity } from './permissions.js';
import { requireThat, type Store } from './store.js';

export function loadReport(store: Store, id: string): ClubReport {
  const row = store.db.prepare('SELECT state FROM club_reports WHERE id=?').get(id);
  requireThat(row, 'Report not found');
  return JSON.parse(String(row.state)) as ClubReport;
}

export function requireReportJobCurrent(store: Store, job: string) {
  const row = store.db.prepare('SELECT report,version FROM report_ai_jobs WHERE job=?').get(job);
  if (!row) return;
  const report = loadReport(store, String(row.report));
  requireThat(
    report.version === row.version && report.currentJob === job && report.status === 'generating',
    'Current report generation required',
  );
}

export function restrictReportOutput(store: Store, job: string, artifact: string) {
  const row = store.db.prepare('SELECT report FROM report_ai_jobs WHERE job=?').get(job);
  if (row)
    store.db.prepare('INSERT INTO report_artifacts VALUES(?,?)').run(artifact, String(row.report));
}

export function privateReportArtifact(store: Store, artifact: string) {
  return (
    !store.db.prepare('SELECT 1 FROM report_publications WHERE output=?').get(artifact) &&
    !!(
      store.db.prepare('SELECT 1 FROM report_artifacts WHERE artifact=?').get(artifact) ||
      store.db.prepare('SELECT 1 FROM report_policy_artifacts WHERE artifact=?').get(artifact)
    )
  );
}

export function reportArtifactAccess(
  store: Store,
  identity: LocalIdentity,
  actor: string,
  artifact: string,
): boolean | undefined {
  if (store.db.prepare('SELECT 1 FROM report_publications WHERE output=?').get(artifact))
    return identity.isActiveMember(actor);
  if (!privateReportArtifact(store, artifact)) return undefined;
  const policy = store.db
    .prepare('SELECT club FROM report_policy_artifacts WHERE artifact=?')
    .get(artifact);
  return (
    ((policy && identity.decide(actor, `club:${String(policy.club)}`, 'manage')) ||
      store.db
        .prepare('SELECT report FROM report_artifacts WHERE artifact=?')
        .all(artifact)
        .some((row) => identity.decide(actor, `report:${String(row.report)}`, 'manage'))) === true
  );
}
