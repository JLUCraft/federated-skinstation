import { randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  competitionSchema, competitionCreateSchema, competitionCommandSchema, gameResourceSchema,
  competitionSeasonSchema, competitionBookingSchema, competitionDisputeRequestSchema,
  competitionResolutionSchema, competitionRouteSchema, competitionListSchema, gameResourceListSchema,
  competitionRankingsSchema, competitionDisputeListSchema, competitionDisputeCreatedSchema,
  competitionSeasonListSchema,
  type Competition, type CompetitionCreate, type CompetitionCommand, type GameResource,
  type CompetitionSeason, type CompetitionBooking, type CompetitionResolution, type CompetitionRoute,
  type CompetitionDisputeRequest, type CompetitionDisputeList,
} from '../shared/contracts/generated.js';
import { appendAudit, type LocalIdentity } from './permissions.js';
import { now, requireThat, type Store } from './store.js';
import { bearer, field, record } from './validate.js';

const MAX_PARTICIPANTS = 10000;
const compareIds = (first: string, second: string) => first < second ? -1 : Number(first > second);

export class Competitions {
  constructor(private readonly store: Store, private readonly identity: LocalIdentity) {}

  private active(account: string) {
    this.identity.authenticate(account);
  }

  private eligible(league: Competition, team: string, account: string) {
    return this.identity.isActiveMember(account, league.rules.crossClub ? undefined : league.teams[team].club);
  }

  private load(id: string): Competition {
    const row = this.store.db.prepare('SELECT state FROM leagues WHERE id=?').get(id);
    requireThat(row, 'League not found');
    return JSON.parse(String(row.state)) as Competition;
  }

  private save(league: Competition) {
    this.store.db.prepare('UPDATE leagues SET state=? WHERE id=?').run(JSON.stringify(league), league.id);
  }

  private resource(id: string): GameResource {
    const row = this.store.db.prepare('SELECT definition FROM game_resources WHERE id=?').get(id);
    requireThat(row, 'Game resource not found');
    return JSON.parse(String(row.definition)) as GameResource;
  }

  resources(actor: string) {
    this.active(actor);
    return this.store.db.prepare('SELECT definition FROM game_resources ORDER BY id').all()
      .map(row => JSON.parse(String(row.definition)) as GameResource);
  }

  putResource(actor: string, resource: GameResource) {
    this.identity.authorized(actor, `club:${resource.club}`, 'services.manage', () => {
      const existing = this.store.db.prepare('SELECT club FROM game_resources WHERE id=?').get(resource.id);
      requireThat(!existing || existing.club === resource.club, 'Resource club is immutable');
      requireThat(resource.rules.reconnectMinMs <= resource.rules.reconnectMaxMs, 'Invalid reconnect interval');
      this.identity.requireMembership(resource.host, resource.club);
      this.identity.requireMembership(resource.scorer, resource.club);
      requireThat(!this.store.db.prepare(
        "SELECT 1 FROM leagues WHERE resource=? AND json_extract(state,'$.phase')!='finished'",
      ).get(resource.id), 'Game resource is in use');
      this.store.db.prepare(
        'INSERT INTO game_resources(id,club,definition) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition',
      ).run(resource.id, resource.club, JSON.stringify(resource));
      appendAudit(this.store, actor, `club:${resource.club}`, 'resource', resource.id, resource);
    });
  }

  create(actor: string, input: CompetitionCreate) {
    const owner = this.resource(input.resource).club;
    return this.identity.authorized(actor, `club:${owner}`, 'manage', () => {
      const resource = this.resource(input.resource);
      this.identity.requireMembership(resource.host, resource.club);
      this.identity.requireMembership(resource.scorer, resource.club);
      requireThat(!this.store.db.prepare('SELECT 1 FROM leagues WHERE id=?').get(input.id), 'League already exists');
      const league: Competition = {
        id: input.id, club: resource.club, title: input.title, resource: resource.id,
        organizer: actor, host: resource.host, scorer: resource.scorer, rules: resource.rules,
        phase: 'registration', teams: {}, online: [], seats: {}, played: [],
        playerScores: {}, teamScores: {}, health: {}, admitted: null, schedule: null,
        manualPause: false, infrastructureDown: false, pausedSince: null, epoch: 0,
      };
      this.store.db.prepare('INSERT INTO leagues(id,club,resource,state) VALUES(?,?,?,?)')
        .run(league.id, league.club, league.resource, JSON.stringify(league));
      appendAudit(this.store, actor, `league:${league.id}`, 'create', league.id, input);
      return league;
    });
  }

  list(actor: string) {
    this.active(actor);
    return this.store.db.prepare('SELECT state FROM leagues ORDER BY id').all()
      .map(row => JSON.parse(String(row.state)) as Competition);
  }

  snapshot(actor: string, id: string) {
    this.active(actor);
    return this.load(id);
  }

  private teamOf(league: Competition, member: string) {
    return Object.keys(league.teams).find(id => league.teams[id].members.includes(member));
  }

  private claimTeam(id: string, team: string, captain: string) {
    const siblings = this.store.db.prepare(
      'SELECT other.state FROM season_leagues current JOIN season_leagues sibling ON sibling.season=current.season JOIN leagues other ON other.id=sibling.league WHERE current.league=? AND other.id!=?',
    ).all(id, id);
    requireThat(siblings.every(row => {
      const other = JSON.parse(String(row.state)) as Competition;
      return !Object.hasOwn(other.teams, team) || other.teams[team].captain === captain;
    }), 'Season team belongs to another captain');
  }

  private participant(league: Competition, member: string) {
    this.active(member);
    requireThat(league.admitted === null || league.admitted.includes(member), 'Participant is not admitted');
  }

  private delegate(league: Competition, actor: string, kind: 'host' | 'scorer') {
    requireThat(actor === league[kind], `League ${kind} required`);
    this.identity.requireMembership(actor, league.club);
  }

  private registration(league: Competition, time: number, window = true) {
    requireThat(league.phase === 'registration', 'League registration closed');
    requireThat(!window || !league.schedule ||
      (time >= league.schedule.opensMs && time < league.schedule.closesMs), 'Outside registration window');
  }

  private fill(league: Competition) {
    for (const team of Object.keys(league.seats).sort()) {
      const seats = league.seats[team];
      while (seats.length < league.rules.seats) {
        const candidates = league.teams[team].members.filter(member =>
          league.online.includes(member) && !seats.some(seat => seat.player === member) &&
          (league.admitted === null || league.admitted.includes(member)) &&
          this.eligible(league, team, member));
        if (!candidates.length) break;
        const player = candidates[randomInt(candidates.length)];
        requireThat(Number.isSafeInteger(league.epoch + 1), 'Seat epoch exhausted');
        seats.push({ player, epoch: ++league.epoch, disconnectedUntil: null });
        if (!league.played.includes(player)) league.played.push(player);
      }
    }
  }

  private expire(league: Competition, time: number) {
    for (const team of Object.keys(league.seats)) {
      league.seats[team] = league.seats[team].filter(seat =>
        (seat.disconnectedUntil === null || seat.disconnectedUntil > time) &&
        this.eligible(league, team, seat.player));
    }
    this.fill(league);
  }

  private pause(league: Competition, time: number) {
    if (league.manualPause || league.infrastructureDown) {
      league.pausedSince ??= time;
    } else if (league.pausedSince !== null) {
      for (const seats of Object.values(league.seats))
        for (const seat of seats)
          if (seat.disconnectedUntil !== null) seat.disconnectedUntil += time - league.pausedSince;
      league.pausedSince = null;
    }
  }

  private score(league: Competition, players: Record<string, number>, teams: Record<string, number>) {
    for (const [member, delta] of Object.entries(players)) {
      requireThat(league.played.includes(member) && Object.hasOwn(league.playerScores, member), 'Player has not participated');
      requireThat(Number.isSafeInteger(league.playerScores[member] + delta), 'Score overflow');
      league.playerScores[member] += delta;
    }
    for (const [team, delta] of Object.entries(teams)) {
      requireThat(Object.hasOwn(league.teamScores, team), 'Team has not participated');
      requireThat(Number.isSafeInteger(league.teamScores[team] + delta), 'Score overflow');
      league.teamScores[team] += delta;
    }
  }

  execute(actor: string, id: string, command: CompetitionCommand) {
    const manage = ['attendance', 'start', 'pause'].includes(command.action);
    const apply = () => {
      this.active(actor);
      const league = this.load(id);
      const time = Date.now();
      switch (command.action) {
        case 'create_team': {
          this.registration(league, time);
          this.participant(league, actor);
          requireThat(!Object.hasOwn(league.teams, command.team) && !this.teamOf(league, actor), 'Team or membership already exists');
          requireThat(Object.keys(league.teams).length < MAX_PARTICIPANTS, 'League capacity reached');
          this.claimTeam(id, command.team, actor);
          Object.defineProperty(league.teams, command.team, {
            value: { club: this.identity.affiliation(actor), captain: actor, members: [actor], invited: [], registered: false },
            enumerable: true, configurable: true, writable: true,
          });
          break;
        }
        case 'invite': {
          this.registration(league, time);
          this.participant(league, actor);
          this.participant(league, command.member);
          const team = Object.hasOwn(league.teams, command.team) && league.teams[command.team];
          requireThat(team && team.captain === actor, 'Team captain required');
          requireThat(this.eligible(league, command.team, actor) && this.eligible(league, command.team, command.member),
            'Active team affiliation required');
          requireThat(team.invited.length < MAX_PARTICIPANTS, 'Invitation capacity reached');
          if (!team.invited.includes(command.member)) team.invited.push(command.member);
          break;
        }
        case 'accept': {
          this.registration(league, time);
          this.participant(league, actor);
          requireThat(!this.teamOf(league, actor), 'Member already belongs to a team');
          const team = Object.hasOwn(league.teams, command.team) && league.teams[command.team];
          requireThat(team && team.invited.includes(actor), 'Team invitation required');
          requireThat(this.eligible(league, command.team, actor), 'Cross-club teams disabled');
          requireThat(team.members.length < MAX_PARTICIPANTS, 'Team capacity reached');
          team.invited = team.invited.filter(member => member !== actor);
          team.members.push(actor);
          team.registered = false;
          break;
        }
        case 'register': {
          this.registration(league, time);
          this.participant(league, actor);
          const team = Object.hasOwn(league.teams, command.team) && league.teams[command.team];
          requireThat(team && team.captain === actor, 'Team captain required');
          for (const member of team.members) {
            this.participant(league, member);
            requireThat(this.eligible(league, command.team, member), 'Active team affiliation required');
          }
          team.registered = true;
          break;
        }
        case 'attendance': {
          this.registration(league, time, false);
          for (const member of command.members) this.active(member);
          if (command.automatic) {
            requireThat(!Object.keys(league.teams).length, 'Automatic teams require an empty league');
            const groups = new Map<string, string[]>();
            for (const member of [...command.members].sort()) {
              const club = league.rules.crossClub ? league.club : this.identity.affiliation(member);
              const group = groups.get(club) ?? [];
              group.push(member);
              groups.set(club, group);
            }
            for (const [club, members] of groups) {
              for (let offset = 0; offset < members.length; offset += league.rules.seats) {
                const group = members.slice(offset, offset + league.rules.seats);
                const team = `auto-${group[0]}`;
                this.claimTeam(id, team, group[0]);
                league.teams[team] = {
                  club, captain: group[0], members: group, invited: [], registered: true,
                };
              }
            }
          }
          league.admitted = command.members;
          break;
        }
        case 'start': {
          this.registration(league, time, false);
          requireThat(!league.schedule || time >= league.schedule.startsMs, 'League start is scheduled later');
          requireThat(!this.store.db.prepare(
            "SELECT 1 FROM leagues WHERE resource=? AND id!=? AND json_extract(state,'$.phase')='playing'",
          ).get(league.resource, league.id), 'Game resource is already playing');
          for (const [team, roster] of Object.entries(league.teams)) {
            if (!roster.registered) continue;
            const admitted = roster.members.filter(member => league.admitted === null || league.admitted.includes(member));
            if (!admitted.length) continue;
            for (const member of admitted) {
              this.participant(league, member);
              requireThat(this.eligible(league, team, member), 'Active team affiliation required');
            }
            Object.defineProperty(league.seats, team, { value: [], enumerable: true, writable: true, configurable: true });
            Object.defineProperty(league.teamScores, team, { value: 0, enumerable: true, writable: true });
            for (const member of admitted)
              Object.defineProperty(league.playerScores, member, { value: 0, enumerable: true, writable: true, configurable: true });
          }
          requireThat(Object.keys(league.seats).length, 'Registered participants required');
          league.phase = 'playing';
          this.fill(league);
          break;
        }
        case 'presence': {
          this.delegate(league, actor, 'host');
          this.participant(league, command.member);
          requireThat(league.phase !== 'finished', 'League finished');
          if (league.phase === 'playing' && league.pausedSince === null) this.expire(league, time);
          league.health[command.member] = command.health;
          league.online = league.online.filter(member => member !== command.member);
          if (command.online) league.online.push(command.member);
          const health = command.health;
          const grace = Math.min(league.rules.reconnectMaxMs, Math.max(league.rules.reconnectMinMs,
            health.rttMs * 8 + health.jitterMs * 4 + health.recoveryMs * 2));
          for (const seats of Object.values(league.seats))
            for (const seat of seats.filter(seat => seat.player === command.member)) {
              if (command.online) seat.disconnectedUntil = null;
              else seat.disconnectedUntil ??= (league.pausedSince ?? time) + grace;
            }
          if (command.online && league.phase === 'playing' && league.pausedSince === null) this.fill(league);
          break;
        }
        case 'tick':
          this.delegate(league, actor, 'host');
          requireThat(league.phase === 'playing', 'Playing league required');
          if (league.pausedSince === null) this.expire(league, time);
          break;
        case 'infrastructure':
          this.delegate(league, actor, 'host');
          requireThat(league.phase !== 'finished', 'Active league required');
          league.infrastructureDown = !command.healthy;
          this.pause(league, time);
          break;
        case 'pause':
          requireThat(league.phase === 'playing', 'Playing league required');
          league.manualPause = command.paused;
          this.pause(league, time);
          break;
        case 'score': {
          this.delegate(league, actor, 'scorer');
          const payload = JSON.stringify([
            Object.entries(command.players).sort(([first], [second]) => compareIds(first, second)),
            Object.entries(command.teams).sort(([first], [second]) => compareIds(first, second)),
          ]);
          const previous = this.store.db.prepare('SELECT payload FROM league_scores WHERE league=? AND event=?')
            .get(id, command.event);
          if (previous) {
            requireThat(previous.payload === payload, 'Score event reused with different payload');
            return league;
          }
          requireThat(league.phase === 'playing', 'Playing league required');
          this.score(league, command.players, command.teams);
          this.store.db.prepare('INSERT INTO league_scores VALUES(?,?,?,?)').run(id, command.event, payload, time);
          break;
        }
        case 'finish':
          this.delegate(league, actor, 'scorer');
          requireThat(league.phase !== 'registration', 'Started league required');
          league.phase = 'finished';
          break;
      }
      this.save(league);
      appendAudit(this.store, actor, `league:${id}`, command.action, id, command);
      return league;
    };
    return manage
      ? this.identity.authorized(actor, `league:${id}`, 'manage', apply)
      : this.store.transaction(apply);
  }

  route(actor: string, id: string, member: string): CompetitionRoute {
    return this.store.transaction(() => {
      this.active(actor);
      const league = this.load(id);
      requireThat(actor === member || actor === league.host, 'Own or host route required');
      if (actor !== member) this.delegate(league, actor, 'host');
      this.participant(league, member);
      if (league.phase !== 'playing' || league.pausedSince !== null) return { destination: 'unavailable' };
      const team = this.teamOf(league, member);
      if (team && !this.eligible(league, team, member)) return { destination: 'unavailable' };
      for (const [team, seats] of Object.entries(league.seats)) {
        const seat = seats.find(seat => seat.player === member);
        if (seat) return { destination: 'match', team, epoch: seat.epoch, address: this.resource(league.resource).address };
      }
      return { destination: team && league.teams[team].registered ? 'waiting' : 'unavailable' };
    });
  }

  createSeason(actor: string, season: CompetitionSeason) {
    return this.identity.authorized(actor, `club:${season.club}`, 'manage', () => {
      requireThat(!this.store.db.prepare('SELECT 1 FROM seasons WHERE id=?').get(season.id), 'Season already exists');
      this.store.db.prepare('INSERT INTO seasons VALUES(?,?,?)').run(season.id, season.club, season.title);
      appendAudit(this.store, actor, `club:${season.club}`, 'create_season', season.id, season);
      return season;
    });
  }

  seasons(actor: string) {
    this.active(actor);
    return this.store.db.prepare('SELECT id,club,title FROM seasons ORDER BY id').all();
  }

  schedule(actor: string, id: string, booking: CompetitionBooking) {
    return this.identity.authorized(actor, `league:${id}`, 'manage', () => {
      const league = this.load(id);
      this.registration(league, Date.now(), false);
      const season = this.store.db.prepare('SELECT club FROM seasons WHERE id=?').get(booking.season);
      requireThat(season?.club === league.club, 'Season and league club must match');
      const schedule = booking.schedule;
      requireThat(schedule.opensMs < schedule.closesMs && schedule.closesMs <= schedule.startsMs &&
        schedule.closesMs > Date.now(), 'Invalid league schedule');
      requireThat(!Object.values(league.teams).some(team => team.registered), 'Registered league cannot be rescheduled');
      for (const row of this.store.db.prepare(
        'SELECT state FROM leagues l JOIN season_leagues s ON s.league=l.id WHERE s.season=? AND l.id!=?',
      ).all(booking.season, id)) {
        const other = JSON.parse(String(row.state)) as Competition;
        requireThat(Object.keys(league.teams).every(team =>
          !Object.hasOwn(other.teams, team) || other.teams[team].captain === league.teams[team].captain),
        'Season team belongs to another captain');
      }
      this.store.db.prepare('INSERT INTO season_leagues VALUES(?,?) ON CONFLICT(league) DO UPDATE SET season=excluded.season')
        .run(booking.season, id);
      league.schedule = schedule;
      this.save(league);
      appendAudit(this.store, actor, `league:${id}`, 'schedule', id, booking);
      return league;
    });
  }

  rankings(actor: string, season: string) {
    this.active(actor);
    requireThat(this.store.db.prepare('SELECT 1 FROM seasons WHERE id=?').get(season), 'Season not found');
    const players = new Map<string, number>();
    const teams = new Map<string, number>();
    for (const row of this.store.db.prepare(
      'SELECT l.state FROM leagues l JOIN season_leagues s ON s.league=l.id WHERE s.season=?',
    ).all(season)) {
      const league = JSON.parse(String(row.state)) as Competition;
      if (league.phase !== 'finished') continue;
      for (const [source, target] of [[league.playerScores, players], [league.teamScores, teams]] as const)
        for (const [id, score] of Object.entries(source)) {
          const total = (target.get(id) ?? 0) + score;
          requireThat(Number.isSafeInteger(total), 'Season score overflow');
          target.set(id, total);
        }
    }
    const sorted = (values: Map<string, number>) => [...values].sort(([first, left], [second, right]) =>
      right - left || compareIds(first, second)).map(([id, score]) => ({ id, score }));
    return { players: sorted(players), teams: sorted(teams) };
  }

  dispute(actor: string, id: string, reason: string) {
    return this.store.transaction(() => {
      this.active(actor);
      const league = this.load(id);
      const team = this.teamOf(league, actor);
      requireThat(league.phase === 'finished' && team && league.teams[team].registered, 'Finished league participant required');
      requireThat(!this.store.db.prepare(
        'SELECT 1 FROM league_disputes WHERE league=? AND account=? AND resolution IS NULL',
      ).get(id, actor), 'Open dispute already exists');
      const dispute = randomUUID();
      this.store.db.prepare('INSERT INTO league_disputes(id,league,account,reason,created_at) VALUES(?,?,?,?,?)')
        .run(dispute, id, actor, reason, Date.now());
      appendAudit(this.store, actor, `league:${id}`, 'dispute', dispute, { reason });
      return { id: dispute };
    });
  }

  disputes(actor: string, id: string): CompetitionDisputeList {
    return this.identity.authorized(actor, `league:${id}`, 'manage', () => ({
      disputes: this.store.db.prepare('SELECT * FROM league_disputes WHERE league=? ORDER BY created_at,id')
        .all(id).map(row => ({
          id: String(row.id), league: String(row.league), account: String(row.account),
          reason: String(row.reason), createdAt: Number(row.created_at),
          resolution: row.resolution === null ? null : JSON.parse(String(row.resolution)) as CompetitionResolution,
          reviewer: row.reviewer === null ? null : String(row.reviewer),
          resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
        })),
    }));
  }

  resolve(actor: string, id: string, resolution: CompetitionResolution) {
    const dispute = this.store.db.prepare('SELECT league FROM league_disputes WHERE id=?').get(id);
    requireThat(dispute, 'Dispute not found');
    return this.identity.authorized(actor, `league:${dispute.league}`, 'manage', () => {
      const current = this.store.db.prepare('SELECT * FROM league_disputes WHERE id=?').get(id)!;
      requireThat(current.resolution === null, 'Dispute already resolved');
      const league = this.load(String(current.league));
      requireThat(league.phase === 'finished', 'Finished league required');
      this.score(league, resolution.players, resolution.teams);
      this.save(league);
      this.store.db.prepare('UPDATE league_disputes SET resolution=?,reviewer=?,resolved_at=? WHERE id=?')
        .run(JSON.stringify(resolution), actor, Date.now(), id);
      appendAudit(this.store, actor, `league:${league.id}`, 'resolve_dispute', id, resolution);
      return league;
    });
  }
}

export function registerCompetitions(app: FastifyInstance, store: Store, identity: LocalIdentity) {
  const competitions = new Competitions(store, identity);
  const actor = (request: FastifyRequest) => store.token(bearer(request.headers.authorization), undefined, now()).id;
  const id = (request: FastifyRequest) => field(record(request.params).id, 128);
  app.get('/api/game-resources', { schema: { response: { 200: gameResourceListSchema } } },
    async request => ({ resources: competitions.resources(actor(request)) }));
  app.post<{ Body: GameResource }>('/api/game-resources', { schema: { body: gameResourceSchema } }, async (request, reply) => {
    competitions.putResource(actor(request), request.body);
    return reply.code(204).send();
  });
  app.get('/api/leagues', { schema: { response: { 200: competitionListSchema } } },
    async request => ({ leagues: competitions.list(actor(request)) }));
  app.post<{ Body: CompetitionCreate }>('/api/leagues', {
    schema: { body: competitionCreateSchema, response: { 200: competitionSchema } },
  }, async request => competitions.create(actor(request), request.body));
  app.get('/api/leagues/:id', { schema: { response: { 200: competitionSchema } } },
    async request => competitions.snapshot(actor(request), id(request)));
  app.post<{ Body: CompetitionCommand }>('/api/leagues/:id/actions', {
    schema: { body: competitionCommandSchema, response: { 200: competitionSchema } },
  }, async request => competitions.execute(actor(request), id(request), request.body));
  app.get('/api/leagues/:id/route/:member', { schema: { response: { 200: competitionRouteSchema } } },
    async request => competitions.route(actor(request), id(request), field(record(request.params).member, 128)));
  app.post<{ Body: CompetitionSeason }>('/api/seasons', {
    schema: { body: competitionSeasonSchema },
  }, async request => competitions.createSeason(actor(request), request.body));
  app.get('/api/seasons', { schema: { response: { 200: competitionSeasonListSchema } } },
    async request => ({ seasons: competitions.seasons(actor(request)) }));
  app.get('/api/seasons/:id/rankings', { schema: { response: { 200: competitionRankingsSchema } } },
    async request => competitions.rankings(actor(request), id(request)));
  app.post<{ Body: CompetitionBooking }>('/api/leagues/:id/schedule', {
    schema: { body: competitionBookingSchema, response: { 200: competitionSchema } },
  }, async request => competitions.schedule(actor(request), id(request), request.body));
  app.post<{ Body: CompetitionDisputeRequest }>('/api/leagues/:id/disputes', {
    schema: { body: competitionDisputeRequestSchema, response: { 200: competitionDisputeCreatedSchema } },
  }, async request => competitions.dispute(actor(request), id(request), request.body.reason));
  app.get('/api/leagues/:id/disputes', { schema: { response: { 200: competitionDisputeListSchema } } },
    async request => competitions.disputes(actor(request), id(request)));
  app.post<{ Body: CompetitionResolution }>('/api/league-disputes/:id/resolve', {
    schema: { body: competitionResolutionSchema, response: { 200: competitionSchema } },
  }, async request => competitions.resolve(actor(request), id(request), request.body));
  return competitions;
}
