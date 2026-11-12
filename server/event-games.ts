import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  competitionSchema,
  eventGameRequestSchema,
  eventGameListSchema,
  eventSettlementRequestSchema,
  eventRewardsSchema,
  eventAwardCommandSchema,
  eventAwardSchema,
  type EventGameRequest,
  type EventGameList,
  type EventSettlementRequest,
  type EventRewards,
  type EventAward,
  type EventAwardCommand,
} from '../shared/contracts/generated.js';
import type { Competitions } from './league.js';
import type { Office } from './office.js';
import type { PointLedger } from './points.js';
import { points } from './points.js';
import { appendAudit, type LocalIdentity } from './permissions.js';
import {
  checkedInMembers,
  currentGameMembers,
  requireEventGamesFinished,
} from './event-game-state.js';
import { gameResource, loadPlan, requirePlanReady } from './planning-state.js';
import { now, requireThat, type Store } from './store.js';
import { bearer, field, record } from './validate.js';

export class EventGames {
  constructor(
    private readonly store: Store,
    private readonly identity: LocalIdentity,
    private readonly office: Office,
    private readonly competitions: Competitions,
    private readonly ledger: PointLedger,
  ) {}

  private visible(actor: string, eventId: string) {
    this.identity.authenticate(actor);
    const event = this.office.load(eventId);
    requireThat(this.office.visible(actor, event), 'Event access required');
    return event;
  }

  prepare(actor: string, eventId: string, input: EventGameRequest) {
    return this.identity.authorized(actor, `event:${eventId}`, 'manage', () => {
      this.identity.authenticate(actor);
      const event = this.office.load(eventId);
      const plan = loadPlan(this.store, eventId);
      requireThat(
        event.phase === 'open' &&
          plan?.id === input.plan &&
          plan.kind === 'online' &&
          plan.selected.includes(input.resource) &&
          Date.now() >= event.checkinOpensMs,
        'Current open event game required',
      );
      requirePlanReady(this.store, this.identity, event);
      const resource = gameResource(this.store, input.resource);
      const existing = this.store.db
        .prepare('SELECT plan,league FROM event_games WHERE event=? AND resource=?')
        .get(eventId, input.resource);
      if (existing) {
        requireThat(existing.plan === plan.id, 'Current game binding required');
        return this.competitions.load(String(existing.league));
      }
      const league = this.competitions.createState(actor, {
        id: `event-${randomUUID()}`,
        title: event.title,
        resource: input.resource,
      });
      this.store.db
        .prepare('INSERT INTO event_games VALUES(?,?,?,?)')
        .run(eventId, plan.id, input.resource, league.id);
      league.schedule = {
        opensMs: event.checkinOpensMs,
        closesMs: event.window.startsMs,
        startsMs: event.window.startsMs,
      };
      this.competitions.admit(
        league,
        currentGameMembers(this.store, this.identity, eventId).map((member) => member.account),
        resource.automaticTeams,
      );
      this.competitions.save(league);
      appendAudit(this.store, actor, `event:${eventId}`, 'prepare_game', league.id, input);
      return league;
    });
  }

  games(actor: string, event: string): EventGameList {
    return this.store.transaction(() => {
      this.visible(actor, event);
      return {
        games: this.store.db
          .prepare('SELECT resource,league FROM event_games WHERE event=? ORDER BY resource')
          .all(event)
          .map((row) => ({
            resource: String(row.resource),
            competition: this.competitions.load(String(row.league)),
          })),
      };
    });
  }

  private award(event: string, account: string): EventAward {
    const row = this.store.db
      .prepare('SELECT * FROM event_awards WHERE event=? AND account=?')
      .get(event, account);
    requireThat(row, 'Event award not found');
    return {
      event,
      account,
      club: String(row.club),
      rank: Number(row.rank),
      points: String(row.points),
      material: row.material === null ? null : String(row.material),
      deliveredBy: row.delivered_by === null ? null : String(row.delivered_by),
      receivedAt: row.received_at === null ? null : Number(row.received_at),
    };
  }

  private rewardView(actor: string, event: string): EventRewards {
    const row = this.store.db
      .prepare('SELECT settled_at FROM event_settlements WHERE event=?')
      .get(event);
    const manager = this.identity.decide(actor, `event:${event}`, 'manage');
    const clubs = new Map<string, boolean>();
    const awards = this.store.db
      .prepare('SELECT account FROM event_awards WHERE event=? ORDER BY rank,account')
      .all(event)
      .map((entry) => this.award(event, String(entry.account)))
      .filter((award) => {
        if (manager || award.account === actor) return true;
        if (!clubs.has(award.club))
          clubs.set(award.club, this.identity.decide(actor, `club:${award.club}`, 'manage'));
        return clubs.get(award.club);
      });
    return { event, settledAt: row ? Number(row.settled_at) : null, awards };
  }

  rewards(actor: string, event: string) {
    return this.store.transaction(() => {
      this.visible(actor, event);
      return this.rewardView(actor, event);
    });
  }

  settle(actor: string, eventId: string, planId: string) {
    return this.identity.authorized(actor, `event:${eventId}`, 'manage', () => {
      this.identity.authenticate(actor);
      const event = this.office.load(eventId);
      const plan = loadPlan(this.store, eventId);
      requireThat(
        event.phase === 'done' &&
          plan?.id === planId &&
          plan.finalized &&
          plan.epoch === event.epoch,
        'Completed current event plan required',
      );
      const settled = this.store.db
        .prepare('SELECT plan FROM event_settlements WHERE event=?')
        .get(eventId);
      if (settled) {
        requireThat(settled.plan === plan.id, 'Current event settlement required');
        return this.rewardView(actor, eventId);
      }
      const members = new Map(
        checkedInMembers(this.store, eventId).map((member) => [member.account, member.club]),
      );
      const scores = new Map<string, bigint>();
      if (plan.kind === 'online') {
        requireEventGamesFinished(this.store, event);
        for (const resource of plan.selected) {
          const binding = this.store.db
            .prepare('SELECT league FROM event_games WHERE event=? AND resource=?')
            .get(eventId, resource)!;
          const league = this.competitions.load(String(binding.league));
          requireThat(
            !this.store.db
              .prepare('SELECT 1 FROM league_disputes WHERE league=? AND resolution IS NULL')
              .get(league.id),
            'Open result dispute must be resolved',
          );
          for (const account of league.played) {
            requireThat(members.has(account), 'Enrolled game participant required');
            scores.set(account, (scores.get(account) ?? 0n) + BigInt(league.playerScores[account]));
          }
        }
      } else {
        for (const account of members.keys()) scores.set(account, 0n);
      }
      const ranked = [...scores.entries()].sort(([first, firstScore], [second, secondScore]) =>
        firstScore > secondScore
          ? -1
          : firstScore < secondScore
            ? 1
            : first < second
              ? -1
              : Number(first > second),
      );
      const time = Date.now();
      this.store.db
        .prepare('INSERT INTO event_settlements VALUES(?,?,?)')
        .run(eventId, plan.id, time);
      let rank = 0;
      for (const [index, [account, score]] of ranked.entries()) {
        if (index === 0 || score !== ranked[index - 1][1]) rank = index + 1;
        const club = members.get(account)!;
        const rule = plan.rewards.find((reward) => reward.club === club)?.rule;
        requireThat(rule, 'Enrolled club reward rule required');
        if (rule.topPlaces !== null && rank > rule.topPlaces) continue;
        this.store.db
          .prepare('INSERT INTO event_awards VALUES(?,?,?,?,?,?,NULL,NULL)')
          .run(eventId, account, club, rank, rule.points, rule.material);
        const amount = points(rule.points);
        if (amount > 0n) this.ledger.adjust(account, club, amount, 'event_reward', eventId, time);
      }
      appendAudit(this.store, actor, `event:${eventId}`, 'settle_rewards', plan.id, {
        participants: ranked.length,
      });
      return this.rewardView(actor, eventId);
    });
  }

  awardAction(actor: string, event: string, account: string, command: EventAwardCommand) {
    return this.identity.action(actor, `event:${event}`, command.action, () => {
      this.identity.authenticate(actor);
      const row = this.store.db
        .prepare('SELECT club FROM event_awards WHERE event=? AND account=?')
        .get(event, account);
      requireThat(
        row &&
          (actor === account ||
            this.identity.decide(actor, `event:${event}`, 'manage') ||
            this.identity.decide(actor, `club:${String(row.club)}`, 'manage')),
        'Event award access required',
      );
      const award = this.award(event, account);
      requireThat(award.material !== null, 'Material award required');
      if (command.action === 'deliver')
        requireThat(
          this.identity.decide(actor, `club:${award.club}`, 'manage') && award.deliveredBy === null,
          'Current club delivery authority required',
        );
      else
        requireThat(
          actor === account && award.deliveredBy !== null && award.receivedAt === null,
          'Delivered personal award required',
        );
      return () => {
        if (command.action === 'deliver')
          this.store.db
            .prepare('UPDATE event_awards SET delivered_by=? WHERE event=? AND account=?')
            .run(actor, event, account);
        else
          this.store.db
            .prepare('UPDATE event_awards SET received_at=? WHERE event=? AND account=?')
            .run(Date.now(), event, account);
        appendAudit(this.store, actor, `event:${event}`, command.action, account, command);
        return this.award(event, account);
      };
    });
  }
}

export function registerEventGames(
  app: FastifyInstance,
  store: Store,
  identity: LocalIdentity,
  office: Office,
  competitions: Competitions,
  ledger: PointLedger,
) {
  const events = new EventGames(store, identity, office, competitions, ledger);
  const actor = (request: FastifyRequest) =>
    store.token(bearer(request.headers.authorization), undefined, now()).id;
  const id = (request: FastifyRequest) => field(record(request.params).id, 128);
  app.get(
    '/api/events/:id/games',
    { schema: { response: { 200: eventGameListSchema } } },
    async (request) => events.games(actor(request), id(request)),
  );
  app.post<{ Body: EventGameRequest }>(
    '/api/events/:id/games',
    {
      schema: { body: eventGameRequestSchema, response: { 200: competitionSchema } },
    },
    async (request) => events.prepare(actor(request), id(request), request.body),
  );
  app.get(
    '/api/events/:id/rewards',
    { schema: { response: { 200: eventRewardsSchema } } },
    async (request) => events.rewards(actor(request), id(request)),
  );
  app.post<{ Body: EventSettlementRequest }>(
    '/api/events/:id/rewards',
    {
      schema: { body: eventSettlementRequestSchema, response: { 200: eventRewardsSchema } },
    },
    async (request) => events.settle(actor(request), id(request), request.body.plan),
  );
  app.post<{ Body: EventAwardCommand }>(
    '/api/events/:id/awards/:account',
    {
      schema: { body: eventAwardCommandSchema, response: { 200: eventAwardSchema } },
    },
    async (request) =>
      events.awardAction(
        actor(request),
        id(request),
        field(record(request.params).account, 128),
        request.body,
      ),
  );
  return events;
}
