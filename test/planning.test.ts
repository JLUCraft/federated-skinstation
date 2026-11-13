import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store, now } from '../server/store.js';
import { site, type Login } from './helpers/site.js';
import type {
  ActivityDraft,
  ActivityPlan,
  ActivityRecord,
  ActivityAttendance,
  ApprovalInstance,
  GameResource,
  OfficeArtifact,
  PlanCommand,
  PlanDraft,
} from '../shared/contracts/generated.js';

await test('cross-club meeting planning requires current official and individual consent while keeping evidence private', async (context) => {
  const service = await site();
  const store = new Store(join(service.dir, 'db'));
  try {
    const chair = await service.enroll('Chair');
    const coChair = await service.enroll('CoChair');
    const participant = await service.enroll('Participant');
    const outsider = await service.enroll('Outsider');
    store.db
      .prepare("INSERT INTO grants VALUES('admin','user',?,'global','admin','fixture',?,NULL,NULL)")
      .run(chair.user.id, now());
    store.db
      .prepare("INSERT INTO clubs VALUES('independent','Independent','community','independent')")
      .run();
    for (const account of [coChair, participant]) {
      store.db
        .prepare("UPDATE memberships SET status='revoked',revoked_at=? WHERE account=?")
        .run(now(), account.user.id);
      store.db
        .prepare("INSERT INTO memberships VALUES(?,'independent','active','import','[]',?,NULL)")
        .run(account.user.id, now());
    }
    const call = service.requestJson;
    for (const [club, nominee] of [
      ['jlu', chair],
      ['independent', coChair],
    ] as const) {
      const succession = await call<{ id: string }>(
        chair,
        'POST',
        `/api/clubs/${club}/successions`,
        { nominee: nominee.user.id },
      );
      await call(nominee, 'POST', `/api/identity/successions/${succession.id}/accept`, {}, 204);
    }
    await call(chair, 'PUT', '/api/clubs/jlu/planning-profile', { club: 'jlu', kind: 'official' });
    await call(coChair, 'PUT', '/api/clubs/independent/planning-profile', {
      club: 'independent',
      kind: 'independent',
    });
    let time = Date.now();
    const start = time;
    context.mock.method(Date, 'now', () => time);
    const upload = (login: Login, club: string, title: string, content = title) =>
      call<OfficeArtifact>(login, 'POST', '/api/artifacts', {
        club,
        title,
        mime: 'text/markdown',
        visibility: 'private',
        content: Buffer.from(content).toString('base64'),
      });
    const brief = await upload(chair, 'jlu', 'Meeting brief');
    const draft: ActivityDraft = {
      id: 'meeting',
      club: 'jlu',
      title: 'Meeting',
      brief: brief.id,
      coOrganizers: ['independent'],
      window: { opensMs: start - 1000, closesMs: start + 10000, startsMs: start + 20000 },
      checkinOpensMs: start + 10000,
      checkinClosesMs: start + 19000,
      endsMs: start + 30000,
    };
    await call(chair, 'POST', '/api/events', draft);
    const input: PlanDraft = {
      epoch: 1,
      kind: 'meeting',
      candidates: [],
      clubs: [
        { club: 'jlu', kind: 'official', participants: [chair.user.id] },
        { club: 'independent', kind: 'independent', participants: [participant.user.id] },
      ],
    };
    let plan = await call<ActivityPlan>(chair, 'PUT', '/api/events/meeting/plan', input);
    const action = (login: Login, command: PlanCommand, status = 200) =>
      call<ActivityPlan>(login, 'POST', '/api/events/meeting/plan/actions', command, status);
    for (const [club, manager] of [
      ['jlu', chair],
      ['independent', coChair],
    ] as const) {
      const opinion = await upload(manager, club, `${club} opinion`);
      await action(manager, {
        action: 'opinion',
        plan: plan.id,
        club,
        document: opinion.id,
        games: [],
      });
      await action(manager, {
        action: 'rewards',
        plan: plan.id,
        club,
        rule: { points: '5', material: null, topPlaces: null },
      });
    }
    await action(chair, { action: 'finalize', plan: plan.id, selected: [] }, 403);
    const officialConsent = await upload(chair, 'jlu', 'Official consent');
    await action(chair, {
      action: 'consent',
      plan: plan.id,
      club: 'jlu',
      document: officialConsent.id,
      transcript: null,
    });
    const managerConsent = await upload(
      coChair,
      'independent',
      'Manager cannot consent for individuals',
    );
    await action(
      coChair,
      {
        action: 'consent',
        plan: plan.id,
        club: 'independent',
        document: managerConsent.id,
        transcript: null,
      },
      403,
    );
    const personalConsent = await upload(participant, 'independent', 'Individual consent');
    const transcript = await upload(participant, 'independent', 'Consent transcript');
    await action(participant, {
      action: 'consent',
      plan: plan.id,
      club: 'independent',
      document: personalConsent.id,
      transcript: transcript.id,
    });
    const delegation = await call<{ id: string }>(chair, 'POST', '/api/identity/grants', {
      account: outsider.user.id,
      scope: 'event:meeting',
      permission: 'manage',
    });
    plan = await action(outsider, { action: 'finalize', plan: plan.id, selected: [] });
    await call(chair, 'DELETE', `/api/identity/grants/${delegation.id}`, undefined, 204);
    assert.equal(plan.finalized, true);
    assert.ok(plan.evidence);
    await call(chair, 'POST', '/api/events/meeting/actions', { action: 'submit' }, 403);
    const download = (login: Login, artifact: string) =>
      service.app.inject({
        url: `/api/artifacts/${artifact}/content`,
        headers: { authorization: `Bearer ${login.accessToken}` },
      });
    const evidence = await download(chair, plan.evidence);
    assert.equal(evidence.statusCode, 200);
    assert.equal((await download(outsider, plan.evidence)).statusCode, 403);
    const snapshot = evidence.json<{
      plan: { finalized: boolean };
      materials: { id: string; content: string }[];
    }>();
    assert.equal(snapshot.plan.finalized, true);
    assert.equal(
      Buffer.from(
        snapshot.materials.find((entry) => entry.id === transcript.id)!.content,
        'base64',
      ).toString(),
      'Consent transcript',
    );
    assert.equal((await download(coChair, personalConsent.id)).statusCode, 403);
    const polished = await upload(chair, 'jlu', 'Polished meeting');
    await action(chair, { action: 'polish', plan: plan.id, document: personalConsent.id }, 403);
    await action(chair, { action: 'polish', plan: plan.id, document: polished.id });
    await call(chair, 'POST', '/api/events/meeting/actions', { action: 'submit' });
    const workflow = await call<ApprovalInstance>(chair, 'POST', '/api/workflows', {
      event: 'meeting',
      epoch: 1,
    });
    assert.equal(workflow.brief, polished.id);
    for (const [club, login] of [
      ['jlu', chair],
      ['independent', coChair],
    ] as const)
      await call(login, 'POST', `/api/workflows/${workflow.id}/actions`, {
        action: 'approve',
        club,
        comment: 'Approved',
      });
    await call(chair, 'POST', `/api/workflows/${workflow.id}/actions`, { action: 'execute' });
    await call(coChair, 'PUT', '/api/clubs/independent/planning-profile', {
      club: 'independent',
      kind: 'official',
    });
    await call(chair, 'POST', '/api/events/meeting/actions', { action: 'publish' }, 403);
    await call(coChair, 'PUT', '/api/clubs/independent/planning-profile', {
      club: 'independent',
      kind: 'independent',
    });
    await call(chair, 'POST', '/api/events/meeting/actions', { action: 'publish' });
    assert.equal((await download(outsider, polished.id)).statusCode, 200);
    assert.equal((await download(outsider, officialConsent.id)).statusCode, 403);
    assert.equal((await download(outsider, personalConsent.id)).statusCode, 403);
    assert.equal((await download(outsider, plan.evidence)).statusCode, 403);
    await call(outsider, 'GET', '/api/events/meeting/plan', undefined, 403);
    await call(outsider, 'POST', '/api/events/meeting/actions', { action: 'signup' }, 403);
    await call(participant, 'POST', '/api/events/meeting/actions', { action: 'signup' });
    time = start + 12000;
    await call(participant, 'POST', '/api/events/meeting/actions', { action: 'checkin' });
    await service.restart();
    assert.equal(
      (await call<ActivityPlan>(chair, 'GET', '/api/events/meeting/plan')).evidence,
      plan.evidence,
    );
    await call(chair, 'PUT', '/api/events/meeting', {
      ...draft,
      window: { opensMs: time - 1000, closesMs: time + 10000, startsMs: time + 20000 },
      checkinOpensMs: time + 10000,
      checkinClosesMs: time + 19000,
      endsMs: time + 30000,
    });
    await call(participant, 'GET', '/api/events/meeting/plan', undefined, 403);
    await action(
      chair,
      {
        action: 'consent',
        plan: plan.id,
        club: 'jlu',
        document: officialConsent.id,
        transcript: null,
      },
      403,
    );
  } finally {
    store.close();
    await service.close();
  }
});

await test('online plans reserve physical endpoints atomically and release them on revision or cancellation', async (context) => {
  const service = await site();
  const store = new Store(join(service.dir, 'db'));
  try {
    const manager = await service.enroll('Manager');
    const visitor = await service.enroll('Visitor');
    store.db
      .prepare("INSERT INTO grants VALUES('admin','user',?,'global','admin','fixture',?,NULL,NULL)")
      .run(manager.user.id, now());
    const call = service.requestJson;
    store.db.prepare("INSERT INTO clubs VALUES('home','Home','school','jlu')").run();
    store.db
      .prepare("INSERT INTO memberships VALUES(?,'home','active','import','[]',0,NULL)")
      .run(visitor.user.id);
    const succession = await call<{ id: string }>(manager, 'POST', '/api/clubs/jlu/successions', {
      nominee: manager.user.id,
    });
    await call(manager, 'POST', `/api/identity/successions/${succession.id}/accept`, {}, 204);
    let time = Date.now();
    context.mock.method(Date, 'now', () => time);
    const resource: GameResource = {
      id: 'paper',
      club: 'jlu',
      title: 'Paper',
      address: 'paper.test:25565',
      host: manager.user.id,
      scorer: manager.user.id,
      rules: { crossClub: false, seats: 1, reconnectMinMs: 1000, reconnectMaxMs: 10000 },
      automaticTeams: true,
    };
    await call(manager, 'POST', '/api/game-resources', resource, 204);
    await call(
      manager,
      'POST',
      '/api/game-resources',
      {
        ...resource,
        id: 'alias',
        address: 'PAPER.test',
      },
      204,
    );
    await call(manager, 'PUT', '/api/clubs/jlu/planning-profile', {
      club: 'jlu',
      kind: 'official',
    });
    const document = await call<OfficeArtifact>(manager, 'POST', '/api/artifacts', {
      club: 'jlu',
      title: 'Private proposal',
      mime: 'text/plain',
      visibility: 'private',
      content: Buffer.from('Resource proposal').toString('base64'),
    });
    const publicBrief = await call<OfficeArtifact>(manager, 'POST', '/api/artifacts', {
      club: 'jlu',
      title: 'Event brief',
      mime: 'text/plain',
      content: Buffer.from('Event').toString('base64'),
    });
    const drafts = new Map<string, ActivityDraft>();
    const create = async (id: string) => {
      const draft: ActivityDraft = {
        id,
        club: 'jlu',
        title: id,
        brief: publicBrief.id,
        coOrganizers: [],
        window: { opensMs: time - 1000, closesMs: time + 10000, startsMs: time + 20000 },
        checkinOpensMs: time + 10000,
        checkinClosesMs: time + 19000,
        endsMs: time + 30000,
      };
      drafts.set(id, draft);
      await call(manager, 'POST', '/api/events', draft);
      const input: PlanDraft = {
        epoch: 1,
        kind: 'online',
        clubs: [{ club: 'jlu', kind: 'official', participants: [] }],
        candidates: ['paper', 'alias'],
      };
      const plan = await call<ActivityPlan>(manager, 'PUT', `/api/events/${id}/plan`, input);
      const mutate = (command: PlanCommand, status = 200) =>
        call<ActivityPlan>(manager, 'POST', `/api/events/${id}/plan/actions`, command, status);
      await mutate({
        action: 'opinion',
        plan: plan.id,
        club: 'jlu',
        document: document.id,
        games: ['paper', 'alias'],
      });
      await mutate({
        action: 'rewards',
        plan: plan.id,
        club: 'jlu',
        rule: { points: '0', material: null, topPlaces: null },
      });
      return { plan, mutate };
    };
    const first = await create('first');
    await first.mutate(
      { action: 'finalize', plan: first.plan.id, selected: ['paper', 'alias'] },
      403,
    );
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS count FROM event_reservations').get()!.count,
      0,
    );
    await first.mutate({ action: 'finalize', plan: first.plan.id, selected: ['paper'] });
    await first.mutate({ action: 'polish', plan: first.plan.id, document: publicBrief.id });
    await call(manager, 'POST', '/api/events/first/actions', { action: 'submit' });
    const approval = await call<ApprovalInstance>(manager, 'POST', '/api/workflows', {
      event: 'first',
      epoch: 1,
    });
    await call(manager, 'POST', `/api/workflows/${approval.id}/actions`, {
      action: 'approve',
      club: 'jlu',
      comment: 'Approved',
    });
    await call(manager, 'POST', `/api/workflows/${approval.id}/actions`, { action: 'execute' });
    await call(manager, 'POST', '/api/events/first/actions', { action: 'publish' });
    await call(visitor, 'POST', '/api/events/first/actions', { action: 'signup' });
    const attendance = await call<ActivityAttendance>(
      manager,
      'GET',
      '/api/events/first/attendance',
    );
    assert.equal(
      attendance.members.find((member) => member.account === visitor.user.id)!.club,
      'jlu',
    );
    await call(
      manager,
      'POST',
      '/api/game-resources',
      { ...resource, address: 'elsewhere.test' },
      403,
    );
    const second = await create('second');
    await second.mutate({ action: 'finalize', plan: second.plan.id, selected: ['alias'] }, 403);
    await call(manager, 'POST', '/api/leagues', {
      id: 'standalone',
      title: 'Standalone',
      resource: 'alias',
    });
    await call(manager, 'POST', '/api/leagues/standalone/actions', {
      action: 'create_team',
      team: 'team',
    });
    await call(manager, 'POST', '/api/leagues/standalone/actions', {
      action: 'register',
      team: 'team',
    });
    await call(manager, 'POST', '/api/leagues/standalone/actions', { action: 'start' }, 403);
    await service.restart();
    await call(manager, 'POST', '/api/events/first/actions', { action: 'cancel' });
    await second.mutate({ action: 'finalize', plan: second.plan.id, selected: ['alias'] });
    await call(manager, 'PUT', '/api/events/second', drafts.get('second')!);
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS count FROM event_reservations').get()!.count,
      0,
    );
    await call(manager, 'POST', '/api/leagues/standalone/actions', { action: 'start' });
    const third = await create('third');
    await third.mutate({ action: 'finalize', plan: third.plan.id, selected: ['paper'] }, 403);
    await call(manager, 'POST', '/api/leagues/standalone/actions', { action: 'finish' });
    const finished = await third.mutate({
      action: 'finalize',
      plan: third.plan.id,
      selected: ['paper'],
    });
    assert.equal(finished.finalized, true);
    await third.mutate({ action: 'polish', plan: third.plan.id, document: publicBrief.id });
    time = drafts.get('third')!.endsMs;
    await call(
      manager,
      'POST',
      '/api/game-resources',
      { ...resource, title: 'Updated after window' },
      204,
    );
    await call(manager, 'POST', '/api/events/third/actions', { action: 'submit' }, 403);
    const revision: ActivityDraft = {
      ...drafts.get('third')!,
      window: { opensMs: time - 1000, closesMs: time + 10000, startsMs: time + 20000 },
      checkinOpensMs: time + 10000,
      checkinClosesMs: time + 19000,
      endsMs: time + 30000,
    };
    const revised = await call<ActivityRecord>(manager, 'PUT', '/api/events/third', revision);
    assert.equal(revised.epoch, 2);
    await third.mutate({ action: 'finalize', plan: third.plan.id, selected: ['paper'] }, 403);
    await call(manager, 'PUT', '/api/events/third', { ...revision, brief: document.id }, 403);
  } finally {
    store.close();
    await service.close();
  }
});
