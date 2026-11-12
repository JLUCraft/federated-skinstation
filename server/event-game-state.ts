import type { ActivityRecord, Competition } from '../shared/contracts/generated.js';
import type { LocalIdentity } from './permissions.js';
import { loadPlan, requirePlanReady } from './planning-state.js';
import { requireThat, type Store } from './store.js';

export function eventGame(store: Store, league: string) {
  const row = store.db
    .prepare('SELECT event,plan,resource FROM event_games WHERE league=?')
    .get(league);
  return row
    ? { event: String(row.event), plan: String(row.plan), resource: String(row.resource) }
    : undefined;
}

export function checkedInMembers(store: Store, event: string) {
  return store.db
    .prepare(
      'SELECT account,club FROM event_attendance WHERE event=? AND checked_in_at IS NOT NULL ORDER BY account',
    )
    .all(event)
    .map((row) => ({ account: String(row.account), club: String(row.club) }));
}

export function eventEnrollment(store: Store, event: string, account: string) {
  const row = store.db
    .prepare(
      'SELECT club FROM event_attendance WHERE event=? AND account=? AND checked_in_at IS NOT NULL',
    )
    .get(event, account);
  return row ? String(row.club) : undefined;
}

export function currentGameMembers(store: Store, identity: LocalIdentity, event: string) {
  return checkedInMembers(store, event).filter((member) =>
    identity.isActiveMember(member.account, member.club),
  );
}

export function requireEventGameCurrent(store: Store, identity: LocalIdentity, league: string) {
  const binding = eventGame(store, league);
  if (!binding) return;
  const row = store.db.prepare('SELECT state FROM activities WHERE id=?').get(binding.event);
  requireThat(row, 'Event not found');
  const event = JSON.parse(String(row.state)) as ActivityRecord;
  const plan = loadPlan(store, event.id);
  requireThat(
    event.phase === 'open' &&
      plan?.id === binding.plan &&
      plan.selected.includes(binding.resource) &&
      Date.now() >= event.checkinOpensMs,
    'Current open event game required',
  );
  requirePlanReady(store, identity, event);
}

export function requireEventGamesFinished(store: Store, event: ActivityRecord) {
  const plan = loadPlan(store, event.id);
  if (plan?.kind !== 'online') return;
  requireThat(plan.finalized && plan.epoch === event.epoch, 'Finalized event plan required');
  for (const selected of plan.selected) {
    const row = store.db
      .prepare(
        'SELECT g.plan,l.state FROM event_games g JOIN leagues l ON l.id=g.league WHERE g.event=? AND g.resource=?',
      )
      .get(event.id, selected);
    requireThat(row?.plan === plan.id, 'Every selected game must run');
    requireThat(
      (JSON.parse(String(row.state)) as Competition).phase === 'finished',
      'Every event game must finish',
    );
  }
}

export function cancelEventGames(store: Store, event: string) {
  for (const row of store.db
    .prepare(
      'SELECT l.id,l.state FROM event_games g JOIN leagues l ON l.id=g.league WHERE g.event=?',
    )
    .all(event)) {
    const league = JSON.parse(String(row.state)) as Competition;
    league.phase = 'finished';
    league.seats = {};
    league.online = [];
    store.db
      .prepare('UPDATE leagues SET state=? WHERE id=?')
      .run(JSON.stringify(league), String(row.id));
  }
}

export function requireUnsettledGame(store: Store, league: string) {
  requireThat(
    !store.db
      .prepare(
        'SELECT 1 FROM event_games g JOIN event_settlements s ON s.event=g.event WHERE g.league=?',
      )
      .get(league),
    'Settled event results are closed',
  );
}
