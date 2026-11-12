import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store, now } from '../server/store.js';
import { ACTIVITY_LIMITS, POINT_LIMIT } from '../shared/points.js';
import { site } from './helpers/site.js';
import type {
  ActivitySourceConfig,
  ActivitySourceList,
  GameResource,
  ActivityDelivery,
  OfficeArtifact,
  ActivityReceipt,
  MemberPoints,
  PointAllowance,
} from '../shared/contracts/generated.js';
import type { Authentication } from '../shared/http.js';

test('activity receipts enforce source and member caps across sources and preserve account-owned budgets through revocation', async (context) => {
  const service = await site();
  const store = new Store(join(service.dir, 'db'));
  try {
    const root = await service.enroll('Admin');
    const host = await service.enroll('Host');
    const alice = await service.enroll('Alice');
    const bob = await service.enroll('Bob');
    store.db
      .prepare("INSERT INTO grants VALUES('admin','user',?,'global','admin','fixture',?,NULL,NULL)")
      .run(root.user.id, now());
    const call = service.requestJson;
    await call(
      root,
      'POST',
      '/api/game-resources',
      {
        id: 'world',
        club: 'jlu',
        title: 'World',
        address: 'game.example.test:25565',
        host: host.user.id,
        scorer: host.user.id,
        automaticTeams: false,
        rules: { crossClub: true, seats: 4, reconnectMinMs: 100, reconnectMaxMs: 1000 },
      },
      204,
    );
    await call(root, 'POST', '/api/points/policy', { dailyMemberCap: '15' });
    const config: ActivitySourceConfig = {
      id: 'world',
      title: 'World',
      club: 'jlu',
      account: host.user.id,
      resource: 'world',
      weightBps: ACTIVITY_LIMITS.weightDenominator,
      pointsPerSlice: '10',
      maxBonusPerSlice: '2',
      dailySourceCap: '25',
      enabled: true,
    };
    await call(root, 'POST', '/api/activity-sources', config);
    await call(root, 'POST', '/api/activity-sources', { ...config, id: 'second' });
    const evidence = await call<OfficeArtifact>(host, 'POST', '/api/artifacts', {
      club: 'jlu',
      title: 'Activity telemetry',
      mime: 'application/json',
      content: Buffer.from('{"activity":"measured by host"}').toString('base64'),
    });
    const step = ACTIVITY_LIMITS.sliceMs;
    const time = Math.floor(Date.now() / step) * step + step * 2;
    context.mock.method(Date, 'now', () => time);
    const players = {
      [alice.user.id]: { activeSlices: 1, afkSlices: 0, bonusPoints: '1' },
      [bob.user.id]: { activeSlices: 1, afkSlices: 0, bonusPoints: '0' },
    };
    const input = {
      source: 'world',
      windowStartMs: time - step * 2,
      windowEndMs: time - step,
      players,
      evidence: evidence.id,
    };
    const receipt = await call<ActivityReceipt>(host, 'POST', '/api/points/activity', input);
    assert.equal(receipt.awarded[alice.user.id], '11');
    assert.equal(receipt.awarded[bob.user.id], '10');
    const replay = await call<ActivityReceipt>(host, 'POST', '/api/points/activity', {
      evidence: input.evidence,
      players: Object.fromEntries(Object.entries(players).reverse()),
      windowEndMs: input.windowEndMs,
      windowStartMs: input.windowStartMs,
      source: input.source,
    });
    assert.equal(replay.id, receipt.id);
    await call(host, 'POST', '/api/points/activity', {
      ...input,
      windowStartMs: time - step,
      windowEndMs: time,
    });
    const total = (await call<MemberPoints>(alice, 'GET', '/api/points/me')).balances[0].available;
    const bobTotal = (await call<MemberPoints>(bob, 'GET', '/api/points/me')).balances[0].available;
    assert.equal(BigInt(total) + BigInt(bobTotal), 25n);
    await call(host, 'POST', '/api/points/activity', { ...input, source: 'second' });
    const member = await call<MemberPoints>(alice, 'GET', '/api/points/me');
    const other = await call<MemberPoints>(bob, 'GET', '/api/points/me');
    assert.equal(member.earnedToday, '15');
    assert.equal(other.earnedToday, '15');
    assert.equal(member.balances[0].available, '15');
    assert.equal(member.activeSlices, 3);
    assert.equal(member.entries.length, 3);
    assert.equal(
      store.db.prepare('SELECT count(*) AS total FROM activity_receipts').get()!.total,
      3,
    );
    const allowance = await call<PointAllowance>(alice, 'POST', '/api/points/allowances', {
      scope: `member:${alice.user.id}`,
      club: 'jlu',
      budget: '10',
    });
    assert.equal(allowance.remaining, '10');
    await call(
      root,
      'POST',
      '/api/points/allowances',
      {
        scope: `member:${alice.user.id}`,
        club: 'jlu',
        budget: '0',
      },
      403,
    );
    store.db.prepare("INSERT INTO clubs VALUES('other','Other','school','other')").run();
    store.db
      .prepare("INSERT INTO memberships VALUES(?,'other','active','import','[]',?,NULL)")
      .run(alice.user.id, now());
    await call(root, 'POST', `/api/clubs/jlu/members/${alice.user.id}/revoke`, {}, 204);
    const revoked = await call<PointAllowance>(alice, 'POST', '/api/points/allowances', {
      scope: `member:${alice.user.id}`,
      club: 'jlu',
      budget: '0',
    });
    assert.equal(revoked.epoch, allowance.epoch + 1);
    assert.equal(revoked.remaining, '0');
    assert.equal(
      (await call<MemberPoints>(alice, 'GET', '/api/points/me')).balances[0].available,
      '15',
    );
    await call(
      alice,
      'POST',
      '/api/points/allowances',
      {
        scope: `member:${alice.user.id}`,
        club: 'jlu',
        budget: '1',
      },
      403,
    );
  } finally {
    store.close();
    await service.close();
  }
});

test('point credits remain exact beyond JavaScript numbers and roll back the whole receipt when a later day overflows', async (context) => {
  const service = await site();
  const store = new Store(join(service.dir, 'db'));
  try {
    const root = await service.enroll('Admin');
    const host = await service.enroll('Host');
    const member = await service.enroll('Member');
    store.db
      .prepare("INSERT INTO grants VALUES('admin','user',?,'global','admin','fixture',?,NULL,NULL)")
      .run(root.user.id, now());
    const call = <Result = unknown>(
      login: typeof root,
      url: string,
      payload: object,
      status = 200,
    ) => service.requestJson<Result>(login, 'POST', url, payload, status);
    await call(
      root,
      '/api/game-resources',
      {
        id: 'world',
        club: 'jlu',
        title: 'World',
        address: 'game.example.test:25565',
        host: host.user.id,
        scorer: host.user.id,
        automaticTeams: false,
        rules: { crossClub: true, seats: 4, reconnectMinMs: 100, reconnectMaxMs: 1000 },
      },
      204,
    );
    await call(root, '/api/points/policy', { dailyMemberCap: POINT_LIMIT.toString() });
    const config: ActivitySourceConfig = {
      id: 'world',
      title: 'World',
      club: 'jlu',
      account: host.user.id,
      resource: 'world',
      weightBps: ACTIVITY_LIMITS.weightDenominator,
      pointsPerSlice: POINT_LIMIT.toString(),
      maxBonusPerSlice: '0',
      dailySourceCap: POINT_LIMIT.toString(),
      enabled: true,
    };
    await call(root, '/api/activity-sources', config);
    const evidence = await call<OfficeArtifact>(host, '/api/artifacts', {
      club: 'jlu',
      title: 'Telemetry',
      mime: 'application/json',
      content: Buffer.from('{}').toString('base64'),
    });
    const step = ACTIVITY_LIMITS.sliceMs;
    let time = Math.floor(Date.now() / step) * step + step;
    context.mock.method(Date, 'now', () => time);
    const input = {
      source: 'world',
      windowStartMs: time - step,
      windowEndMs: time,
      evidence: evidence.id,
      players: { [member.user.id]: { activeSlices: 1, afkSlices: 0, bonusPoints: '0' } },
    };
    const credited = await call<ActivityReceipt>(host, '/api/points/activity', input);
    assert.equal(credited.awarded[member.user.id], POINT_LIMIT.toString());
    assert.equal(
      store.db.prepare('SELECT available FROM point_balances WHERE account=?').get(member.user.id)!
        .available,
      POINT_LIMIT.toString(),
    );
    time += ACTIVITY_LIMITS.dayMs;
    for (const [login, name] of [
      [root, 'admin'],
      [host, 'host'],
      [member, 'member'],
    ] as const) {
      const response = await service.post('/authserver/authenticate', {
        username: `${name}@school.test`,
        password: 'password-for-contract-testing',
        requestUser: true,
      });
      assert.equal(response.statusCode, 200, response.body);
      login.accessToken = response.json<Authentication>().accessToken;
    }
    await call(root, '/api/activity-sources', { ...config, pointsPerSlice: '1' });
    await call(
      host,
      '/api/points/activity',
      {
        ...input,
        windowStartMs: time - step,
        windowEndMs: time,
      },
      403,
    );
    assert.equal(
      store.db.prepare('SELECT count(*) AS total FROM activity_receipts').get()!.total,
      1,
    );
    assert.equal(store.db.prepare('SELECT count(*) AS total FROM point_ledger').get()!.total, 1);
    assert.equal(
      store.db
        .prepare('SELECT count(*) AS total FROM activity_member_days WHERE day=?')
        .get(Math.floor(time / ACTIVITY_LIMITS.dayMs))!.total,
      0,
    );
    assert.equal(
      store.db.prepare("SELECT last_window_end_ms FROM activity_sources WHERE id='world'").get()!
        .last_window_end_ms,
      input.windowEndMs,
    );
    store.db.prepare("INSERT INTO clubs VALUES('other','Other','school','other')").run();
    store.db
      .prepare("INSERT INTO memberships VALUES(?,'other','active','import','[]',?,NULL)")
      .run(host.user.id, now());
    await call(root, `/api/clubs/jlu/members/${host.user.id}/revoke`, {}, 204);
    assert.deepEqual(
      (await service.requestJson<ActivitySourceList>(host, 'GET', '/api/hosted-activity-sources'))
        .sources,
      [],
    );
    await call(
      host,
      '/api/points/activity',
      {
        ...input,
        windowStartMs: time - step,
        windowEndMs: time,
        players: {},
      },
      403,
    );
    assert.equal(
      store.db.prepare('SELECT count(*) AS total FROM activity_receipts').get()!.total,
      1,
    );
  } finally {
    store.close();
    await service.close();
  }
});

test('activity delivery archives private profile evidence and credits atomically across retries and restart', async (context) => {
  const service = await site();
  const store = new Store(join(service.dir, 'db'));
  try {
    const root = await service.enroll('Admin');
    const host = await service.enroll('Host');
    const alice = await service.enroll('Alice');
    const bob = await service.enroll('Bob');
    store.db
      .prepare("INSERT INTO grants VALUES('admin','user',?,'global','admin','fixture',?,NULL,NULL)")
      .run(root.user.id, now());
    const call = service.requestJson;
    await call(
      root,
      'POST',
      '/api/game-resources',
      {
        id: 'world',
        club: 'jlu',
        title: 'World',
        address: 'game.example.test:25565',
        host: host.user.id,
        scorer: host.user.id,
        automaticTeams: false,
        rules: { crossClub: true, seats: 4, reconnectMinMs: 100, reconnectMaxMs: 1000 },
      },
      204,
    );
    const config: ActivitySourceConfig = {
      id: 'world',
      title: 'World',
      club: 'jlu',
      account: host.user.id,
      resource: 'world',
      weightBps: ACTIVITY_LIMITS.weightDenominator,
      pointsPerSlice: '10',
      maxBonusPerSlice: '0',
      dailySourceCap: '100',
      enabled: true,
    };
    await call(root, 'POST', '/api/activity-sources', config);
    await call(root, 'POST', '/api/points/policy', { dailyMemberCap: '100' });
    const assignments = '/api/hosted-activity-sources';
    assert.deepEqual(
      (await call<ActivitySourceList>(host, 'GET', assignments)).sources.map(
        ({ config }) => config.id,
      ),
      ['world'],
    );
    assert.deepEqual((await call<ActivitySourceList>(bob, 'GET', assignments)).sources, []);

    const time = Math.floor(Date.now() / ACTIVITY_LIMITS.sliceMs) * ACTIVITY_LIMITS.sliceMs;
    context.mock.method(Date, 'now', () => time);
    const extra = store.createProfile(store.account('id', alice.user.id)!, 'AliceExtra');
    const delivery = {
      source: 'world',
      windowStartMs: time - ACTIVITY_LIMITS.sliceMs,
      windowEndMs: time,
      players: { [alice.user.id]: { activeSlices: 1, afkSlices: 0, bonusPoints: '0' } },
      profiles: { [extra.id]: alice.user.id },
      telemetry: JSON.stringify({ slices: [{ active: true, uuid: extra.id }] }),
    };
    const endpoint = '/api/points/activity-deliveries';
    await call(bob, 'POST', endpoint, delivery, 403);
    await call(
      host,
      'POST',
      endpoint,
      { ...delivery, profiles: { [bob.user.id]: alice.user.id } },
      403,
    );
    const receipt = await call<ActivityReceipt>(host, 'POST', endpoint, delivery);
    assert.equal(receipt.awarded[alice.user.id], '10');
    const artifact = store.db
      .prepare('SELECT visibility,owner FROM office_artifacts WHERE id=?')
      .get(receipt.attestation.evidence)!;
    assert.equal(artifact.visibility, 'private');
    assert.equal(artifact.owner, host.user.id);
    assert.deepEqual(
      await call<Pick<ActivityDelivery, 'profiles' | 'telemetry'>>(
        host,
        'GET',
        `/api/artifacts/${receipt.attestation.evidence}/content`,
      ),
      { profiles: delivery.profiles, telemetry: delivery.telemetry },
    );
    await call(
      alice,
      'GET',
      `/api/artifacts/${receipt.attestation.evidence}/content`,
      undefined,
      403,
    );
    store.deleteProfile(store.account('id', alice.user.id)!, extra.id);
    await service.restart();
    assert.deepEqual(await call<ActivityReceipt>(host, 'POST', endpoint, delivery), receipt);
    await call(host, 'POST', endpoint, { ...delivery, telemetry: '{"slices":[]}' }, 403);
    await call(
      host,
      'POST',
      endpoint,
      { ...delivery, profiles: { [alice.user.id]: alice.user.id } },
      403,
    );
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM office_artifacts').get()!.n, 1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM point_ledger').get()!.n, 1);
    const next = {
      ...delivery,
      windowStartMs: time,
      windowEndMs: time + ACTIVITY_LIMITS.sliceMs,
      profiles: { [alice.user.id]: alice.user.id },
    };
    context.mock.method(Date, 'now', () => time + ACTIVITY_LIMITS.sliceMs);
    store.db
      .prepare('UPDATE point_balances SET available=? WHERE account=?')
      .run(POINT_LIMIT.toString(), alice.user.id);
    await call(host, 'POST', endpoint, next, 403);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM office_artifacts').get()!.n, 1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM activity_receipts').get()!.n, 1);
    store.db
      .prepare('UPDATE point_balances SET available=? WHERE account=?')
      .run('10', alice.user.id);
    const nextReceipt = await call<ActivityReceipt>(host, 'POST', endpoint, next);
    assert.equal(nextReceipt.awarded[alice.user.id], '10');
    const resource = JSON.parse(
      String(
        store.db.prepare("SELECT definition FROM game_resources WHERE id='world'").get()!
          .definition,
      ),
    ) as GameResource;
    await call(root, 'POST', '/api/game-resources', { ...resource, host: bob.user.id }, 204);
    assert.deepEqual((await call<ActivitySourceList>(host, 'GET', assignments)).sources, []);
    await call(root, 'POST', '/api/game-resources', resource, 204);
    await call(root, 'POST', '/api/activity-sources', { ...config, enabled: false });
    assert.deepEqual((await call<ActivitySourceList>(host, 'GET', assignments)).sources, []);
    await call(host, 'POST', endpoint, next, 403);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM office_artifacts').get()!.n, 2);
  } finally {
    store.close();
    await service.close();
  }
});
