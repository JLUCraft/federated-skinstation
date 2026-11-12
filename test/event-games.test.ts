import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store, now } from '../server/store.js';
import { PointLedger } from '../server/points.js';
import { POINT_LIMIT } from '../shared/points.js';
import { site, type Login } from './helpers/site.js';
import type {
  ActivityDraft,
  ActivityPlan,
  ApprovalInstance,
  Competition,
  CompetitionRoute,
  EventAward,
  EventGameList,
  EventRewards,
  GameResource,
  GameHostAdmission,
  OfficeArtifact,
  PlanCommand,
  PlanDraft,
} from '../shared/contracts/generated.js';

async function organization() {
  const service = await site();
  const store = new Store(join(service.dir, 'db'));
  try {
    const root = await service.enroll('Admin');
    const chair = await service.enroll('Chair');
    const coChair = await service.enroll('CoChair');
    const alice = await service.enroll('Alice');
    const bob = await service.enroll('Bob');
    const carol = await service.enroll('Carol', '127.0.0.2');
    const call = service.requestJson;
    store.db
      .prepare("INSERT INTO grants VALUES('admin','user',?,'global','admin','fixture',?,NULL,NULL)")
      .run(root.user.id, now());
    store.db.prepare("INSERT INTO clubs VALUES('other','Other','school','other')").run();
    for (const login of [coChair, bob]) {
      store.db
        .prepare("UPDATE memberships SET status='revoked',revoked_at=? WHERE account=?")
        .run(now(), login.user.id);
      store.db
        .prepare("INSERT INTO memberships VALUES(?,'other','active','import','[]',?,NULL)")
        .run(login.user.id, now());
    }
    for (const [club, manager] of [
      ['jlu', chair],
      ['other', coChair],
    ] as const) {
      const succession = await call<{ id: string }>(
        root,
        'POST',
        `/api/clubs/${club}/successions`,
        { nominee: manager.user.id },
      );
      await call(manager, 'POST', `/api/identity/successions/${succession.id}/accept`, {}, 204);
      await call(manager, 'PUT', `/api/clubs/${club}/planning-profile`, { club, kind: 'official' });
    }
    const upload = (login: Login, club: string, title: string, visibility: 'club' | 'private') =>
      call<OfficeArtifact>(login, 'POST', '/api/artifacts', {
        club,
        title,
        mime: 'text/markdown',
        visibility,
        content: Buffer.from(title).toString('base64'),
      });
    const planEvent = async (
      id: string,
      kind: PlanDraft['kind'],
      resources: string[],
      base: number,
    ) => {
      const brief = await upload(chair, 'jlu', `${id} brief`, 'club');
      const draft: ActivityDraft = {
        id,
        club: 'jlu',
        title: id,
        brief: brief.id,
        coOrganizers: ['other'],
        window: { opensMs: base - 1000, closesMs: base + 10000, startsMs: base + 20000 },
        checkinOpensMs: base + 10000,
        checkinClosesMs: base + 19000,
        endsMs: base + 30000,
      };
      await call(chair, 'POST', '/api/events', draft);
      const plan = await call<ActivityPlan>(chair, 'PUT', `/api/events/${id}/plan`, {
        epoch: 1,
        kind,
        candidates: resources,
        clubs: [
          {
            club: 'jlu',
            kind: 'official',
            participants: kind === 'meeting' ? [alice.user.id] : [],
          },
          {
            club: 'other',
            kind: 'official',
            participants: kind === 'meeting' ? [bob.user.id] : [],
          },
        ],
      } satisfies PlanDraft);
      const action = (actor: Login, command: PlanCommand) =>
        call(actor, 'POST', `/api/events/${id}/plan/actions`, command);
      for (const [club, manager, reward] of [
        ['jlu', chair, '5'],
        ['other', coChair, '11'],
      ] as const) {
        const document = await upload(
          manager,
          club,
          `${id} ${club} opinion and consent`,
          'private',
        );
        await action(manager, {
          action: 'opinion',
          plan: plan.id,
          club,
          document: document.id,
          games: club === 'other' ? resources : [],
        });
        await action(manager, {
          action: 'rewards',
          plan: plan.id,
          club,
          rule: { points: reward, material: 'Club prize', topPlaces: 1 },
        });
        if (kind === 'meeting')
          await action(manager, {
            action: 'consent',
            plan: plan.id,
            club,
            document: document.id,
            transcript: null,
          });
      }
      await action(chair, { action: 'finalize', plan: plan.id, selected: resources });
      await action(chair, { action: 'polish', plan: plan.id, document: brief.id });
      await call(chair, 'POST', `/api/events/${id}/actions`, { action: 'submit' });
      const approval = await call<ApprovalInstance>(chair, 'POST', '/api/workflows', {
        event: id,
        epoch: 1,
      });
      for (const [club, manager] of [
        ['jlu', chair],
        ['other', coChair],
      ] as const)
        await call(manager, 'POST', `/api/workflows/${approval.id}/actions`, {
          action: 'approve',
          club,
          comment: 'Approved',
        });
      await call(chair, 'POST', `/api/workflows/${approval.id}/actions`, { action: 'execute' });
      await call(chair, 'POST', `/api/events/${id}/actions`, { action: 'publish' });
      return { plan, draft };
    };
    const resource = (id: string, automaticTeams = true): GameResource => ({
      id,
      club: 'other',
      title: id,
      address: `${id}.test:25565`,
      host: coChair.user.id,
      scorer: coChair.user.id,
      rules: { crossClub: false, seats: 1, reconnectMinMs: 1000, reconnectMaxMs: 10000 },
      automaticTeams,
    });
    return {
      service,
      store,
      root,
      chair,
      coChair,
      alice,
      bob,
      carol,
      call,
      planEvent,
      resource,
      close: async () => {
        store.close();
        await service.close();
      },
    };
  } catch (error) {
    store.close();
    await service.close();
    throw error;
  }
}

test('event-owned games use real check-ins and league scores for exact tied rewards across clubs', async (context) => {
  const fixture = await organization();
  const { service, store, chair, coChair, alice, bob, carol, call } = fixture;
  try {
    let time = Date.now();
    const base = time;
    context.mock.method(Date, 'now', () => time);
    for (const resource of ['first', 'second'])
      await call(
        coChair,
        'POST',
        '/api/game-resources',
        fixture.resource(resource, resource === 'first'),
        204,
      );
    const event = await fixture.planEvent('league-day', 'online', ['first', 'second'], base);
    for (const member of [alice, bob, carol])
      await call(member, 'POST', '/api/events/league-day/actions', { action: 'signup' });
    await call(
      chair,
      'POST',
      '/api/events/league-day/games',
      { plan: event.plan.id, resource: 'first' },
      403,
    );
    time = base + 11000;
    await call(alice, 'POST', '/api/events/league-day/actions', { action: 'checkin' });
    const first = await call<Competition>(chair, 'POST', '/api/events/league-day/games', {
      plan: event.plan.id,
      resource: 'first',
    });
    const admissionPath = (league: string, profile: string) =>
      `/api/leagues/${league}/admission/${profile}`;
    assert.equal(
      (await call<GameHostAdmission>(coChair, 'GET', admissionPath(first.id, alice.user.id))).route
        .destination,
      'waiting',
    );
    await call(coChair, 'GET', admissionPath(first.id, bob.user.id), undefined, 403);
    await call(
      chair,
      'PUT',
      '/api/events/league-day',
      {
        ...event.draft,
        title: 'Cannot revise a prepared game',
        window: { ...event.draft.window, closesMs: time + 1000 },
      },
      403,
    );
    await call(
      coChair,
      'POST',
      `/api/leagues/${first.id}/actions`,
      {
        action: 'presence',
        member: bob.user.id,
        online: true,
        health: { rttMs: 20, jitterMs: 0, recoveryMs: 0 },
      },
      403,
    );
    for (const member of [bob, carol])
      await call(member, 'POST', '/api/events/league-day/actions', { action: 'checkin' });
    assert.equal(
      (
        await call<Competition>(chair, 'POST', '/api/events/league-day/games', {
          plan: event.plan.id,
          resource: 'first',
        })
      ).id,
      first.id,
    );
    const second = await call<Competition>(chair, 'POST', '/api/events/league-day/games', {
      plan: event.plan.id,
      resource: 'second',
    });
    for (const member of [alice, bob, carol]) {
      const team = `team-${member.user.id}`;
      await call(member, 'POST', `/api/leagues/${second.id}/actions`, {
        action: 'create_team',
        team,
      });
      await call(member, 'POST', `/api/leagues/${second.id}/actions`, { action: 'register', team });
    }
    await call(
      chair,
      'POST',
      `/api/leagues/${first.id}/actions`,
      { action: 'attendance', members: [], automatic: true },
      403,
    );
    await call(
      coChair,
      'POST',
      `/api/leagues/${first.id}/schedule`,
      {
        season: 'ignored',
        schedule: event.draft.window,
      },
      403,
    );
    for (const league of [first, second])
      for (const member of [alice, bob, carol])
        await call(coChair, 'POST', `/api/leagues/${league.id}/actions`, {
          action: 'presence',
          member: member.user.id,
          online: true,
          health: { rttMs: 20, jitterMs: 0, recoveryMs: 0 },
        });
    time = base + 20000;
    await call(chair, 'POST', '/api/events/league-day/actions', { action: 'finish' }, 403);
    for (const [index, league] of [first, second].entries()) {
      const started = await call<Competition>(chair, 'POST', `/api/leagues/${league.id}/actions`, {
        action: 'start',
      });
      assert.equal(started.played.length, 3);
      await service.restart();
      const admitted = await call<GameHostAdmission>(
        coChair,
        'GET',
        admissionPath(league.id, bob.user.id),
      );
      assert.equal(admitted.account, bob.user.id);
      assert.equal(admitted.route.destination, 'match');
      assert.equal(
        Object.values(started.teams).find((team) => team.members.includes(bob.user.id))!.club,
        'other',
      );
      assert.equal(
        (
          await call<CompetitionRoute>(
            alice,
            'GET',
            `/api/leagues/${league.id}/route/${alice.user.id}`,
          )
        ).destination,
        'match',
      );
      await call(coChair, 'POST', `/api/leagues/${league.id}/actions`, {
        action: 'score',
        event: 'round',
        players: {
          [alice.user.id]: Number.MAX_SAFE_INTEGER - index,
          [bob.user.id]: Number.MAX_SAFE_INTEGER - index,
          [carol.user.id]: Number.MAX_SAFE_INTEGER - index * 2,
        },
        teams: {},
      });
      await call(coChair, 'POST', `/api/leagues/${league.id}/actions`, { action: 'finish' });
      await service.restart();
    }
    const games = await call<EventGameList>(alice, 'GET', '/api/events/league-day/games');
    assert.deepEqual(
      games.games.map((game) => game.competition.id),
      [first.id, second.id],
    );
    await call(chair, 'POST', '/api/events/league-day/actions', { action: 'finish' });
    const dispute = await call<{ id: string }>(alice, 'POST', `/api/leagues/${first.id}/disputes`, {
      reason: 'Confirm scoring record',
    });
    await call(chair, 'POST', '/api/events/league-day/rewards', { plan: event.plan.id }, 403);
    await call(coChair, 'POST', `/api/league-disputes/${dispute.id}/resolve`, {
      response: 'Scoring record confirmed',
      players: {},
      teams: {},
    });
    const rewards = await call<EventRewards>(chair, 'POST', '/api/events/league-day/rewards', {
      plan: event.plan.id,
    });
    assert.equal(rewards.awards.length, 2);
    assert.equal(rewards.awards.find((award) => award.account === alice.user.id)!.points, '5');
    assert.equal(rewards.awards.find((award) => award.account === bob.user.id)!.club, 'other');
    assert.equal(rewards.awards.find((award) => award.account === bob.user.id)!.points, '11');
    assert.ok(rewards.awards.every((award) => award.rank === 1));
    assert.deepEqual(
      await call<EventRewards>(chair, 'POST', '/api/events/league-day/rewards', {
        plan: event.plan.id,
      }),
      rewards,
    );
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS count FROM point_ledger WHERE kind='event_reward'")
        .get()!.count,
      2,
    );
    assert.equal(
      (await call<EventRewards>(carol, 'GET', '/api/events/league-day/rewards')).awards.length,
      0,
    );
    await call(
      alice,
      'POST',
      `/api/leagues/${second.id}/disputes`,
      { reason: 'Already settled' },
      403,
    );
    await call(
      coChair,
      'POST',
      `/api/leagues/${first.id}/actions`,
      { action: 'score', event: 'late', players: { [alice.user.id]: 1 }, teams: {} },
      403,
    );

    const original = {
      action: 'score',
      event: 'round',
      players: {
        [alice.user.id]: Number.MAX_SAFE_INTEGER,
        [bob.user.id]: Number.MAX_SAFE_INTEGER,
        [carol.user.id]: Number.MAX_SAFE_INTEGER,
      },
      teams: {},
    };
    const replay = await call<Competition>(
      coChair,
      'POST',
      `/api/leagues/${first.id}/actions`,
      original,
    );
    assert.deepEqual(replay.playerScores, original.players);
    await call(
      coChair,
      'POST',
      `/api/leagues/${first.id}/actions`,
      {
        ...original,
        players: { ...original.players, [alice.user.id]: Number.MAX_SAFE_INTEGER - 1 },
      },
      403,
    );
    assert.deepEqual(
      await call<EventRewards>(chair, 'GET', '/api/events/league-day/rewards'),
      rewards,
    );

    const next = await fixture.planEvent('cancelled-game', 'online', ['first'], time);
    await call(alice, 'POST', '/api/events/cancelled-game/actions', { action: 'signup' });
    time += 11000;
    await call(alice, 'POST', '/api/events/cancelled-game/actions', { action: 'checkin' });
    const cancelled = await call<Competition>(chair, 'POST', '/api/events/cancelled-game/games', {
      plan: next.plan.id,
      resource: 'first',
    });
    time = next.draft.endsMs + 1000;
    await call(chair, 'POST', `/api/leagues/${cancelled.id}/actions`, { action: 'start' }, 403);
    await call(chair, 'POST', '/api/events/cancelled-game/actions', { action: 'cancel' });
    assert.equal(
      (await call<Competition>(alice, 'GET', `/api/leagues/${cancelled.id}`)).phase,
      'finished',
    );
    await call(chair, 'POST', `/api/leagues/${cancelled.id}/actions`, { action: 'start' }, 403);
    await call(chair, 'POST', '/api/events/cancelled-game/rewards', { plan: next.plan.id }, 403);
    await call(coChair, 'POST', '/api/game-resources', fixture.resource('first'), 204);
  } finally {
    await fixture.close();
  }
});

test('meeting rewards roll back together on overflow and retain private club-owned delivery receipts', async (context) => {
  const fixture = await organization();
  const { service, store, chair, coChair, alice, bob, carol, call } = fixture;
  try {
    let time = Date.now();
    const base = time;
    context.mock.method(Date, 'now', () => time);
    const event = await fixture.planEvent('club-meeting', 'meeting', [], base);
    for (const member of [alice, bob])
      await call(member, 'POST', '/api/events/club-meeting/actions', { action: 'signup' });
    time = base + 11000;
    for (const member of [alice, bob])
      await call(member, 'POST', '/api/events/club-meeting/actions', { action: 'checkin' });
    time = base + 20000;
    await call(chair, 'POST', '/api/events/club-meeting/actions', { action: 'finish' });
    const ledger = new PointLedger(store);
    const overflow =
      alice.user.id > bob.user.id
        ? { account: alice.user.id, club: 'jlu' }
        : { account: bob.user.id, club: 'other' };
    store.transaction(() =>
      ledger.adjust(overflow.account, overflow.club, POINT_LIMIT, 'fixture', 'opening'),
    );
    await call(chair, 'POST', '/api/events/club-meeting/rewards', { plan: event.plan.id }, 403);
    assert.equal(
      store.db.prepare("SELECT 1 FROM event_settlements WHERE event='club-meeting'").get(),
      undefined,
    );
    assert.equal(
      store.db.prepare("SELECT 1 FROM point_ledger WHERE kind='event_reward'").get(),
      undefined,
    );
    store.transaction(() =>
      ledger.adjust(overflow.account, overflow.club, -POINT_LIMIT, 'fixture', 'spend'),
    );
    const settled = await call<EventRewards>(chair, 'POST', '/api/events/club-meeting/rewards', {
      plan: event.plan.id,
    });
    assert.equal(settled.awards.length, 2);
    assert.equal(ledger.balance(alice.user.id, 'jlu'), 5n);
    assert.equal(ledger.balance(bob.user.id, 'other'), 11n);
    assert.equal(
      (await call<EventRewards>(alice, 'GET', '/api/events/club-meeting/rewards')).awards.length,
      1,
    );
    assert.equal(
      (await call<EventRewards>(coChair, 'GET', '/api/events/club-meeting/rewards')).awards[0]
        .account,
      bob.user.id,
    );
    assert.equal(
      (await call<EventRewards>(carol, 'GET', '/api/events/club-meeting/rewards')).awards.length,
      0,
    );
    const awardUrl = `/api/events/club-meeting/awards/${bob.user.id}`;
    await call(bob, 'POST', awardUrl, { action: 'receive' }, 403);
    await call(chair, 'POST', awardUrl, { action: 'deliver' }, 403);
    await call(coChair, 'POST', awardUrl, { action: 'deliver' });
    await call(alice, 'POST', awardUrl, { action: 'receive' }, 403);
    time += 1000;
    const received = await call<EventAward>(bob, 'POST', awardUrl, { action: 'receive' });
    assert.equal(received.deliveredBy, coChair.user.id);
    assert.equal(received.receivedAt, time);
    await call(bob, 'POST', awardUrl, { action: 'receive' }, 403);
    await service.restart();
    assert.equal(
      (await call<EventRewards>(bob, 'GET', '/api/events/club-meeting/rewards')).awards[0]
        .receivedAt,
      time,
    );
    await call(chair, 'POST', '/api/events/club-meeting/rewards', { plan: event.plan.id });
    assert.equal(ledger.balance(bob.user.id, 'other'), 11n);
  } finally {
    await fixture.close();
  }
});
