import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store, now } from '../server/store.js';
import { site } from './helpers/site.js';
import type {
  Competition,
  CompetitionList,
  GameResource,
  CompetitionRoute,
  CompetitionDisputeCreated,
  CompetitionRankings,
  GameScoringSession,
  GameHostAdmission,
} from '../shared/contracts/generated.js';

test('central league journey keeps team identity, replacement epochs, scores and dispute corrections in SQLite', async (context) => {
  const service = await site();
  const store = new Store(join(service.dir, 'db'));
  try {
    const admin = await service.enroll('Admin');
    const host = await service.enroll('Host');
    const scorer = await service.enroll('Scorer');
    const captain = await service.enroll('Captain');
    const reserve = await service.enroll('Reserve');
    store.db
      .prepare("INSERT INTO grants VALUES('admin','user',?,'global','admin','fixture',?,NULL,NULL)")
      .run(admin.user.id, now());
    const call = service.requestJson;
    const resource: GameResource = {
      id: 'arena',
      club: 'jlu',
      title: 'Arena',
      address: 'game.example.test:25565',
      host: host.user.id,
      scorer: scorer.user.id,
      automaticTeams: false,
      rules: { crossClub: false, seats: 1, reconnectMinMs: 100, reconnectMaxMs: 1000 },
    };
    await call(admin, 'POST', '/api/game-resources', resource, 204);
    await call(admin, 'POST', '/api/seasons', { id: 'winter', club: 'jlu', title: 'Winter' });
    await call(admin, 'POST', '/api/leagues', { id: 'round', title: 'Round', resource: 'arena' });
    assert.deepEqual(
      (await call<CompetitionList>(host, 'GET', '/api/hosted-leagues')).leagues.map(
        (league) => league.id,
      ),
      ['round'],
    );
    assert.deepEqual(await call<CompetitionList>(scorer, 'GET', '/api/hosted-leagues'), {
      leagues: [],
    });
    let time = Date.now();
    context.mock.method(Date, 'now', () => time);
    await call(admin, 'POST', '/api/leagues/round/schedule', {
      season: 'winter',
      schedule: { opensMs: time - 1000, closesMs: time + 1000, startsMs: time + 2000 },
    });
    const action = (login: typeof admin, payload: object, status = 200) =>
      call<Competition>(login, 'POST', '/api/leagues/round/actions', payload, status);
    await action(captain, { action: 'create_team', team: 'alpha' });
    await action(captain, { action: 'invite', team: 'alpha', member: reserve.user.id });
    await action(reserve, { action: 'accept', team: 'alpha' });
    await action(captain, { action: 'register', team: 'alpha' });
    const captainAccount = store.account('id', captain.user.id)!;
    const extraProfile = store.createProfile(captainAccount, 'CaptainExtra');
    const admissionPath = (profile: string) => `/api/leagues/round/admission/${profile}`;
    const admission = (profile: string) =>
      call<GameHostAdmission>(host, 'GET', admissionPath(profile));
    assert.deepEqual(await admission(extraProfile.id), {
      account: captain.user.id,
      route: { destination: 'waiting' },
    });
    await call(admin, 'GET', admissionPath(captain.user.id), undefined, 403);
    await call(scorer, 'GET', admissionPath(captain.user.id), undefined, 403);
    await call(host, 'GET', admissionPath(host.user.id), undefined, 403);
    const scoring = () => call<GameScoringSession>(scorer, 'GET', '/api/leagues/round/scoring');
    let scoringSession = await scoring();
    assert.equal(scoringSession.league.id, 'round');
    assert.deepEqual(scoringSession.profiles[captain.user.id], [captain.user.id, extraProfile.id]);
    assert.deepEqual(scoringSession.profiles[reserve.user.id], [reserve.user.id]);
    assert.equal(scoringSession.profiles[host.user.id], undefined);
    await call(admin, 'GET', '/api/leagues/round/scoring', undefined, 403);
    await call(host, 'GET', '/api/leagues/round/scoring', undefined, 403);
    store.db
      .prepare('INSERT INTO profile_mappings VALUES(?,?)')
      .run(captain.user.id, '1'.repeat(32));
    scoringSession = await scoring();
    assert.deepEqual(scoringSession.profiles[captain.user.id], ['1'.repeat(32), extraProfile.id]);
    await call(host, 'GET', admissionPath(captain.user.id), undefined, 403);
    assert.equal((await admission('1'.repeat(32))).account, captain.user.id);
    store.deleteProfile(captainAccount, extraProfile.id);
    await call(host, 'GET', admissionPath(extraProfile.id), undefined, 403);
    assert.deepEqual((await scoring()).profiles[captain.user.id], ['1'.repeat(32)]);
    await action(host, {
      action: 'presence',
      member: captain.user.id,
      online: true,
      health: { rttMs: 20, jitterMs: 0, recoveryMs: 0 },
    });
    await action(host, {
      action: 'presence',
      member: reserve.user.id,
      online: true,
      health: { rttMs: 20, jitterMs: 0, recoveryMs: 0 },
    });
    await action(admin, { action: 'start' }, 403);
    time += 2000;
    let league = await action(admin, { action: 'start' });
    const original = league.seats.alpha[0];
    const originalLogin = original.player === captain.user.id ? captain : reserve;
    const replacementLogin = original.player === captain.user.id ? reserve : captain;
    const originalProfile = original.player === captain.user.id ? '1'.repeat(32) : reserve.user.id;
    const replacementProfile =
      replacementLogin.user.id === captain.user.id ? '1'.repeat(32) : reserve.user.id;
    const initialAdmission = await admission(originalProfile);
    assert.equal(initialAdmission.account, original.player);
    assert.deepEqual(initialAdmission.route, {
      destination: 'match',
      team: 'alpha',
      epoch: original.epoch,
      address: resource.address,
    });
    assert.equal(league.played.length, 1);
    assert.equal(
      (
        await call<CompetitionRoute>(
          originalLogin,
          'GET',
          `/api/leagues/round/route/${original.player}`,
        )
      ).destination,
      'match',
    );
    await action(host, {
      action: 'presence',
      member: original.player,
      online: false,
      health: { rttMs: 20, jitterMs: 0, recoveryMs: 0 },
    });
    await action(admin, { action: 'pause', paused: true });
    assert.deepEqual((await admission(originalProfile)).route, { destination: 'waiting' });
    time += 5000;
    league = await action(host, { action: 'tick' });
    assert.equal(league.seats.alpha[0].player, original.player);
    await action(host, { action: 'infrastructure', healthy: false });
    await action(admin, { action: 'pause', paused: false });
    time += 1000;
    league = await action(host, { action: 'infrastructure', healthy: true });
    assert.equal(league.seats.alpha[0].disconnectedUntil, time + 160);
    time += 161;
    league = await action(host, { action: 'tick' });
    assert.equal(league.seats.alpha[0].player, replacementLogin.user.id);
    assert.ok(league.seats.alpha[0].epoch > original.epoch);
    assert.equal((await admission(originalProfile)).route.destination, 'waiting');
    assert.deepEqual((await admission(replacementProfile)).route, {
      destination: 'match',
      team: 'alpha',
      epoch: league.seats.alpha[0].epoch,
      address: resource.address,
    });
    await action(host, {
      action: 'presence',
      member: original.player,
      online: true,
      health: { rttMs: 20, jitterMs: 0, recoveryMs: 0 },
    });
    assert.equal(
      (
        await call<CompetitionRoute>(
          originalLogin,
          'GET',
          `/api/leagues/round/route/${original.player}`,
        )
      ).destination,
      'waiting',
    );
    await action(captain, { action: 'score', event: 'first', players: {}, teams: {} }, 403);
    const score = {
      action: 'score',
      event: 'first',
      players: { [original.player]: 3, [replacementLogin.user.id]: 7 },
      teams: { alpha: 10 },
    };
    await action(scorer, score);
    league = await action(scorer, {
      ...score,
      players: { [replacementLogin.user.id]: 7, [original.player]: 3 },
    });
    assert.equal(league.teamScores.alpha, 10);
    await action(scorer, { ...score, teams: { alpha: 20 } }, 403);
    await action(
      scorer,
      { action: 'score', event: 'invalid', players: { [host.user.id]: 50 }, teams: {} },
      403,
    );
    assert.equal(
      store.db.prepare("SELECT 1 FROM league_scores WHERE event='invalid'").get(),
      undefined,
    );
    store.db.prepare('UPDATE accounts SET disabled=1 WHERE id=?').run(reserve.user.id);
    await call(host, 'GET', admissionPath(reserve.user.id), undefined, 403);
    store.db.prepare('UPDATE accounts SET disabled=0 WHERE id=?').run(reserve.user.id);
    store.db
      .prepare(
        "UPDATE memberships SET status='revoked',revoked_at=? WHERE account=? AND club='jlu'",
      )
      .run(now(), host.user.id);
    await call(host, 'GET', admissionPath('1'.repeat(32)), undefined, 403);
    await action(scorer, { action: 'finish' });
    assert.deepEqual(
      await call<CompetitionRoute>(captain, 'GET', `/api/leagues/round/route/${captain.user.id}`),
      { destination: 'unavailable' },
    );
    await action(scorer, score);
    const dispute = await call<CompetitionDisputeCreated>(
      captain,
      'POST',
      '/api/leagues/round/disputes',
      {
        reason: 'Missed result',
      },
    );
    await call(admin, 'POST', `/api/league-disputes/${dispute.id}/resolve`, {
      response: 'Corrected',
      players: { [captain.user.id]: 2 },
      teams: { alpha: 2 },
    });
    const rankings = await call<CompetitionRankings>(
      reserve,
      'GET',
      '/api/seasons/winter/rankings',
    );
    assert.equal(rankings.teams[0].score, 12);
    const persisted = JSON.parse(
      String(store.db.prepare("SELECT state FROM leagues WHERE id='round'").get()!.state),
    ) as Competition;
    assert.equal(persisted.teams.alpha.captain, captain.user.id);
    assert.equal(persisted.teamScores.alpha, 12);
    assert.equal(persisted.phase, 'finished');
    store.db.prepare('UPDATE accounts SET disabled=1 WHERE id=?').run(reserve.user.id);
    assert.equal((await scoring()).profiles[reserve.user.id], undefined);
    store.db.prepare("INSERT INTO clubs VALUES('other','Other','school','other')").run();
    store.db
      .prepare("INSERT INTO memberships VALUES(?,'other','active','import','[]',?,NULL)")
      .run(scorer.user.id, now());
    store.db
      .prepare(
        "UPDATE memberships SET status='revoked',revoked_at=? WHERE account=? AND club='jlu'",
      )
      .run(now(), scorer.user.id);
    await call(scorer, 'GET', '/api/leagues/round/scoring', undefined, 403);
  } finally {
    store.close();
    await service.close();
  }
});

test('league authority remains club scoped while cross-club participants use their own accounts', async () => {
  const service = await site();
  const store = new Store(join(service.dir, 'db'));
  try {
    const admin = await service.enroll('Admin');
    const manager = await service.enroll('Manager');
    const guest = await service.enroll('Guest');
    store.db
      .prepare("INSERT INTO grants VALUES('admin','user',?,'global','admin','fixture',?,NULL,NULL)")
      .run(admin.user.id, now());
    store.db.prepare("INSERT INTO clubs VALUES('other','Other','school','other')").run();
    store.db
      .prepare("UPDATE memberships SET status='revoked',revoked_at=? WHERE account=?")
      .run(now(), guest.user.id);
    store.db
      .prepare("INSERT INTO memberships VALUES(?,'other','active','import','[]',?,NULL)")
      .run(guest.user.id, now());
    const call = <Result = unknown>(
      login: typeof admin,
      url: string,
      payload: object,
      status = 200,
    ) => service.requestJson<Result>(login, 'POST', url, payload, status);
    await call(admin, '/api/identity/grants', {
      account: manager.user.id,
      scope: 'club:jlu',
      permission: 'manage',
    });
    const resource: GameResource = {
      id: 'arena',
      club: 'jlu',
      title: 'Arena',
      address: 'game.example.test:25565',
      host: manager.user.id,
      scorer: manager.user.id,
      automaticTeams: true,
      rules: { crossClub: true, seats: 2, reconnectMinMs: 100, reconnectMaxMs: 1000 },
    };
    await call(manager, '/api/game-resources', resource, 204);
    await call(manager, '/api/game-resources', { ...resource, club: 'other' }, 403);
    await call(
      manager,
      '/api/game-resources',
      {
        ...resource,
        id: 'separate',
        rules: { ...resource.rules, crossClub: false },
      },
      204,
    );
    await call(manager, '/api/leagues', {
      id: 'separate',
      title: 'Separate',
      resource: 'separate',
    });
    await call(guest, '/api/leagues/separate/actions', { action: 'create_team', team: 'visitors' });
    await call(
      guest,
      '/api/leagues/separate/actions',
      { action: 'invite', team: 'visitors', member: manager.user.id },
      403,
    );
    await call(guest, '/api/leagues/separate/actions', { action: 'register', team: 'visitors' });
    await call(manager, '/api/leagues', {
      id: 'automatic',
      title: 'Automatic',
      resource: 'separate',
    });
    const automatic = await call<Competition>(manager, '/api/leagues/automatic/actions', {
      action: 'attendance',
      members: [manager.user.id, guest.user.id],
      automatic: true,
    });
    assert.deepEqual(
      Object.values(automatic.teams)
        .map((team) => team.club)
        .sort(),
      ['jlu', 'other'],
    );
    await call(manager, '/api/leagues', { id: 'open', title: 'Open', resource: 'arena' });
    await call(guest, '/api/leagues/open/actions', { action: 'create_team', team: 'guests' });
    await call(guest, '/api/leagues/open/actions', { action: 'register', team: 'guests' });
    await call(guest, '/api/leagues/open/actions', { action: 'start' }, 403);
    await call(
      guest,
      '/api/leagues/open/actions',
      {
        action: 'presence',
        member: guest.user.id,
        online: true,
        health: { rttMs: 0, jitterMs: 0, recoveryMs: 0 },
      },
      403,
    );
    await call(manager, '/api/leagues/open/actions', { action: 'start', now: Date.now() }, 400);
    await call(manager, '/api/leagues/open/actions', { action: 'start' });
    await call(manager, '/api/game-resources', resource, 403);
    await call(admin, '/api/identity/grants', {
      account: manager.user.id,
      scope: 'league:open',
      permission: 'manage',
    });
    store.db
      .prepare("INSERT INTO memberships VALUES(?,'other','active','import','[]',?,NULL)")
      .run(manager.user.id, now());
    await call(admin, `/api/clubs/jlu/members/${manager.user.id}/revoke`, {}, 204);
    assert.ok(
      store.db
        .prepare("SELECT revoked_at FROM grants WHERE principal=? AND scope='league:open'")
        .get(manager.user.id)!.revoked_at,
    );
    await call(manager, '/api/leagues/open/actions', { action: 'pause', paused: true }, 403);
    await call(manager, '/api/leagues/open/actions', { action: 'tick' }, 403);
    await call(manager, '/api/leagues/open/actions', { action: 'finish' }, 403);
    assert.ok(
      store.db
        .prepare("SELECT 1 FROM audit WHERE actor=? AND action='authorize' AND target='manage'")
        .get(guest.user.id),
    );
  } finally {
    store.close();
    await service.close();
  }
});
