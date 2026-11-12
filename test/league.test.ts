import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store, now } from '../server/store.js';
import { site } from './helpers/site.js';
import type { Competition, GameResource } from '../shared/contracts/generated.js';

test('central league journey keeps team identity, replacement epochs, scores and dispute corrections in SQLite', async context => {
  const service = await site();
  const store = new Store(join(service.dir, 'db'));
  try {
    const admin = await service.enroll('Admin');
    const host = await service.enroll('Host');
    const scorer = await service.enroll('Scorer');
    const captain = await service.enroll('Captain');
    const reserve = await service.enroll('Reserve');
    store.db.prepare("INSERT INTO grants VALUES('admin','user',?,'global','admin','fixture',?,NULL,NULL)")
      .run(admin.user.id, now());
    const call = async (login: typeof admin, method: 'GET' | 'POST', url: string, payload?: object, status = 200) => {
      const response = await service.app.inject({
        method, url, payload, headers: { authorization: `Bearer ${login.accessToken}` },
      });
      assert.equal(response.statusCode, status, response.body);
      return response.body ? response.json() : undefined;
    };
    const resource: GameResource = {
      id: 'arena', club: 'jlu', title: 'Arena', address: 'game.example.test:25565',
      host: host.user.id, scorer: scorer.user.id, automaticTeams: false,
      rules: { crossClub: false, seats: 1, reconnectMinMs: 100, reconnectMaxMs: 1000 },
    };
    await call(admin, 'POST', '/api/game-resources', resource, 204);
    await call(admin, 'POST', '/api/seasons', { id: 'winter', club: 'jlu', title: 'Winter' });
    await call(admin, 'POST', '/api/leagues', { id: 'round', title: 'Round', resource: 'arena' });
    let time = Date.now();
    context.mock.method(Date, 'now', () => time);
    await call(admin, 'POST', '/api/leagues/round/schedule', {
      season: 'winter', schedule: { opensMs: time - 1000, closesMs: time + 1000, startsMs: time + 2000 },
    });
    const action = (login: typeof admin, payload: object, status = 200) =>
      call(login, 'POST', '/api/leagues/round/actions', payload, status);
    await action(captain, { action: 'create_team', team: 'alpha' });
    await action(captain, { action: 'invite', team: 'alpha', member: reserve.user.id });
    await action(reserve, { action: 'accept', team: 'alpha' });
    await action(captain, { action: 'register', team: 'alpha' });
    await action(host, { action: 'presence', member: captain.user.id, online: true, health: { rttMs: 20, jitterMs: 0, recoveryMs: 0 } });
    await action(host, { action: 'presence', member: reserve.user.id, online: true, health: { rttMs: 20, jitterMs: 0, recoveryMs: 0 } });
    await action(admin, { action: 'start' }, 403);
    time += 2000;
    let league = await action(admin, { action: 'start' }) as Competition;
    const original = league.seats.alpha[0];
    const originalLogin = original.player === captain.user.id ? captain : reserve;
    const replacementLogin = original.player === captain.user.id ? reserve : captain;
    assert.equal(league.played.length, 1);
    assert.equal((await call(originalLogin, 'GET', `/api/leagues/round/route/${original.player}`)).destination, 'match');
    await action(host, { action: 'presence', member: original.player, online: false, health: { rttMs: 20, jitterMs: 0, recoveryMs: 0 } });
    await action(admin, { action: 'pause', paused: true });
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
    await action(host, { action: 'presence', member: original.player, online: true, health: { rttMs: 20, jitterMs: 0, recoveryMs: 0 } });
    assert.equal((await call(originalLogin, 'GET', `/api/leagues/round/route/${original.player}`)).destination, 'waiting');
    await action(captain, { action: 'score', event: 'first', players: {}, teams: {} }, 403);
    const score = { action: 'score', event: 'first', players: { [original.player]: 3, [replacementLogin.user.id]: 7 }, teams: { alpha: 10 } };
    await action(scorer, score);
    league = await action(scorer, { ...score, players: { [replacementLogin.user.id]: 7, [original.player]: 3 } });
    assert.equal(league.teamScores.alpha, 10);
    await action(scorer, { ...score, teams: { alpha: 20 } }, 403);
    await action(scorer, { action: 'score', event: 'invalid', players: { [host.user.id]: 50 }, teams: {} }, 403);
    assert.equal(store.db.prepare("SELECT 1 FROM league_scores WHERE event='invalid'").get(), undefined);
    await action(scorer, { action: 'finish' });
    await action(scorer, score);
    const dispute = await call(captain, 'POST', '/api/leagues/round/disputes', { reason: 'Missed result' });
    await call(admin, 'POST', `/api/league-disputes/${dispute.id}/resolve`, {
      response: 'Corrected', players: { [captain.user.id]: 2 }, teams: { alpha: 2 },
    });
    const rankings = await call(reserve, 'GET', '/api/seasons/winter/rankings');
    assert.equal(rankings.teams[0].score, 12);
    const persisted = JSON.parse(String(store.db.prepare("SELECT state FROM leagues WHERE id='round'").get()!.state)) as Competition;
    assert.equal(persisted.teams.alpha.captain, captain.user.id);
    assert.equal(persisted.teamScores.alpha, 12);
    assert.equal(persisted.phase, 'finished');
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
    store.db.prepare("INSERT INTO grants VALUES('admin','user',?,'global','admin','fixture',?,NULL,NULL)")
      .run(admin.user.id, now());
    store.db.prepare("INSERT INTO clubs VALUES('other','Other','school','other')").run();
    store.db.prepare("UPDATE memberships SET status='revoked',revoked_at=? WHERE account=?")
      .run(now(), guest.user.id);
    store.db.prepare("INSERT INTO memberships VALUES(?,'other','active','import','[]',?,NULL)")
      .run(guest.user.id, now());
    const call = async (login: typeof admin, url: string, payload: object, status = 200) => {
      const response = await service.app.inject({ method: 'POST', url, payload, headers: { authorization: `Bearer ${login.accessToken}` } });
      assert.equal(response.statusCode, status, response.body);
      return response.body ? response.json() : undefined;
    };
    await call(admin, '/api/identity/grants', { account: manager.user.id, scope: 'club:jlu', permission: 'manage' });
    const resource: GameResource = {
      id: 'arena', club: 'jlu', title: 'Arena', address: 'game.example.test:25565',
      host: manager.user.id, scorer: manager.user.id, automaticTeams: true,
      rules: { crossClub: true, seats: 2, reconnectMinMs: 100, reconnectMaxMs: 1000 },
    };
    await call(manager, '/api/game-resources', resource, 204);
    await call(manager, '/api/game-resources', { ...resource, club: 'other' }, 403);
    await call(manager, '/api/game-resources', {
      ...resource, id: 'separate', rules: { ...resource.rules, crossClub: false },
    }, 204);
    await call(manager, '/api/leagues', { id: 'separate', title: 'Separate', resource: 'separate' });
    await call(guest, '/api/leagues/separate/actions', { action: 'create_team', team: 'visitors' });
    await call(guest, '/api/leagues/separate/actions', { action: 'invite', team: 'visitors', member: manager.user.id }, 403);
    await call(guest, '/api/leagues/separate/actions', { action: 'register', team: 'visitors' });
    await call(manager, '/api/leagues', { id: 'automatic', title: 'Automatic', resource: 'separate' });
    const automatic = await call(manager, '/api/leagues/automatic/actions', {
      action: 'attendance', members: [manager.user.id, guest.user.id], automatic: true,
    }) as Competition;
    assert.deepEqual(Object.values(automatic.teams).map(team => team.club).sort(), ['jlu', 'other']);
    await call(manager, '/api/leagues', { id: 'open', title: 'Open', resource: 'arena' });
    await call(guest, '/api/leagues/open/actions', { action: 'create_team', team: 'guests' });
    await call(guest, '/api/leagues/open/actions', { action: 'register', team: 'guests' });
    await call(guest, '/api/leagues/open/actions', { action: 'start' }, 403);
    await call(guest, '/api/leagues/open/actions', { action: 'presence', member: guest.user.id, online: true, health: { rttMs: 0, jitterMs: 0, recoveryMs: 0 } }, 403);
    await call(manager, '/api/leagues/open/actions', { action: 'start', now: Date.now() }, 400);
    await call(manager, '/api/leagues/open/actions', { action: 'start' });
    await call(manager, '/api/game-resources', resource, 403);
    await call(admin, '/api/identity/grants', { account: manager.user.id, scope: 'league:open', permission: 'manage' });
    store.db.prepare("INSERT INTO memberships VALUES(?,'other','active','import','[]',?,NULL)")
      .run(manager.user.id, now());
    await call(admin, `/api/clubs/jlu/members/${manager.user.id}/revoke`, {}, 204);
    assert.ok(store.db.prepare("SELECT revoked_at FROM grants WHERE principal=? AND scope='league:open'").get(manager.user.id)!.revoked_at);
    await call(manager, '/api/leagues/open/actions', { action: 'pause', paused: true }, 403);
    await call(manager, '/api/leagues/open/actions', { action: 'tick' }, 403);
    await call(manager, '/api/leagues/open/actions', { action: 'finish' }, 403);
    assert.ok(store.db.prepare("SELECT 1 FROM audit WHERE actor=? AND action='authorize' AND target='manage'").get(guest.user.id));
  } finally {
    store.close();
    await service.close();
  }
});
