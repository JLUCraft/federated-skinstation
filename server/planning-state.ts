import type { ActivityPlan, ActivityRecord, GameResource } from '../shared/contracts/generated.js';
import type { LocalIdentity } from './permissions.js';
import { requireThat, type Store } from './store.js';

export function loadPlan(store: Store, event: string): ActivityPlan | undefined {
  const row = store.db.prepare('SELECT state FROM event_plans WHERE event=?').get(event);
  return row ? (JSON.parse(String(row.state)) as ActivityPlan) : undefined;
}

export function setPolishedPlan(
  store: Store,
  event: ActivityRecord,
  plan: ActivityPlan,
  artifact: string,
) {
  requireThat(
    event.phase === 'draft' && plan.finalized && plan.epoch === event.epoch && !plan.polished,
    'Finalized draft plan required',
  );
  plan.polished = artifact;
  store.db
    .prepare('UPDATE event_plans SET state=? WHERE event=?')
    .run(JSON.stringify(plan), event.id);
  store.db.prepare('INSERT OR IGNORE INTO event_artifacts VALUES(?,?)').run(event.id, artifact);
}
export function gameResource(store: Store, id: string): GameResource {
  const row = store.db.prepare('SELECT definition FROM game_resources WHERE id=?').get(id);
  requireThat(row, 'Game resource not found');
  return JSON.parse(String(row.definition)) as GameResource;
}

export function gameEndpoint(address: string) {
  let endpoint: URL;
  try {
    endpoint = new URL(`minecraft://${address}`);
  } catch {
    requireThat(false, 'Valid Minecraft address required');
  }
  requireThat(
    endpoint.hostname &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.pathname &&
      !endpoint.search &&
      !endpoint.hash &&
      (!endpoint.port || (Number(endpoint.port) > 0 && Number(endpoint.port) <= 65535)),
    'Valid Minecraft address required',
  );
  return `${endpoint.hostname.toLowerCase()}:${endpoint.port || '25565'}`;
}

export function releasePlanResources(store: Store, event: string) {
  store.db.prepare('DELETE FROM event_reservations WHERE event=?').run(event);
}

export function planDocumentsReadable(
  store: Store,
  identity: LocalIdentity,
  actor: string,
  artifact: string,
) {
  return store.db
    .prepare('SELECT event,plan,club,audience FROM planning_documents WHERE artifact=?')
    .all(artifact)
    .some((row) => {
      const plan = loadPlan(store, String(row.event));
      if (plan?.id !== row.plan) return false;
      return (
        identity.decide(actor, `event:${plan.event}`, 'manage') ||
        (row.audience === 'club' && identity.decide(actor, `club:${String(row.club)}`, 'manage'))
      );
    });
}

export function requirePlanPolicy(
  store: Store,
  identity: LocalIdentity,
  event: ActivityRecord,
  plan: ActivityPlan,
) {
  requireThat(plan.epoch === event.epoch, 'Current event plan required');
  for (const club of plan.clubs) {
    requireThat(
      store.db.prepare('SELECT kind FROM club_planning_profiles WHERE club=?').get(club.club)
        ?.kind === club.kind,
      'Current club planning profile required',
    );
    for (const member of club.participants) identity.requireMembership(member, club.club);
    const reward = plan.rewards.find((entry) => entry.club === club.club);
    requireThat(reward, 'Every participating club must define rewards');
    if (plan.clubs.length > 1) {
      const opinion = plan.opinions.find((entry) => entry.club === club.club);
      requireThat(
        opinion &&
          identity.isActiveMember(opinion.actor, club.club) &&
          identity.decide(opinion.actor, `club:${club.club}`, 'manage'),
        'Current participating-club opinion required',
      );
    }
    if (plan.kind === 'meeting') {
      requireThat(club.participants.length, 'Meeting participants required');
      if (club.kind === 'official') {
        requireThat(
          plan.consents.some(
            (consent) =>
              consent.club === club.club &&
              identity.isActiveMember(consent.actor, club.club) &&
              identity.decide(consent.actor, `club:${club.club}`, 'manage'),
          ),
          'Current official club consent required',
        );
      } else {
        requireThat(
          club.participants.every((member) =>
            plan.consents.some((consent) => consent.club === club.club && consent.actor === member),
          ),
          'Every independent participant must consent',
        );
      }
    }
  }
  for (const selected of plan.selected) {
    const resource = gameResource(store, selected);
    identity.requireMembership(resource.host, resource.club);
    identity.requireMembership(resource.scorer, resource.club);
    requireThat(
      plan.clubs.some((club) => club.club === resource.club) &&
        plan.opinions.some(
          (opinion) =>
            opinion.club === resource.club &&
            opinion.games.includes(selected) &&
            identity.isActiveMember(opinion.actor, resource.club) &&
            identity.decide(opinion.actor, `club:${resource.club}`, 'manage'),
        ),
      'Resource owner must authorize the selected game',
    );
  }
}

export function requirePlanReady(store: Store, identity: LocalIdentity, event: ActivityRecord) {
  const plan = loadPlan(store, event.id);
  if (!plan) return;
  requireThat(plan.finalized && plan.polished, 'Finalized and polished plan required');
  requireThat(Date.now() < event.endsMs, 'Current event planning window required');
  requirePlanPolicy(store, identity, event, plan);
  requireThat(
    plan.selected.every((resource) =>
      store.db
        .prepare('SELECT 1 FROM event_reservations WHERE event=? AND resource=?')
        .get(event.id, resource),
    ),
    'Current game reservations required',
  );
}
