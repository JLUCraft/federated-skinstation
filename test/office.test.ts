import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store, now } from '../server/store.js';
import { site } from './helpers/site.js';
import type {
  ActivityDraft,
  ApprovalTemplate,
  OfficeArtifact,
  ApprovalInstance,
  ActivityRecord,
  ActivityTask,
  ActivityNoticeList,
  ActivityAttendance,
  ApprovalList,
} from '../shared/contracts/generated.js';

test('club workflow snapshots, delegated review and chair consent lead to real event attendance and tasks', async (context) => {
  const service = await site();
  const store = new Store(join(service.dir, 'db'));
  try {
    const root = await service.enroll('Admin');
    const chair = await service.enroll('Chair');
    const coChair = await service.enroll('CoChair');
    const reviewer = await service.enroll('Reviewer');
    const delegate = await service.enroll('Delegate');
    const member = reviewer;
    store.db
      .prepare("INSERT INTO grants VALUES('admin','user',?,'global','admin','fixture',?,NULL,NULL)")
      .run(root.user.id, now());
    store.db.prepare("INSERT INTO clubs VALUES('other','Other','school','other')").run();
    store.db
      .prepare("INSERT INTO memberships VALUES(?,'other','active','import','[]',?,NULL)")
      .run(coChair.user.id, now());
    const call = service.requestJson;
    for (const [club, nominee] of [
      ['jlu', chair],
      ['other', coChair],
    ] as const) {
      const proposal = await call<{ id: string }>(root, 'POST', `/api/clubs/${club}/successions`, {
        nominee: nominee.user.id,
      });
      await call(nominee, 'POST', `/api/identity/successions/${proposal.id}/accept`, {}, 204);
    }
    let time = Date.now();
    const start = time;
    context.mock.method(Date, 'now', () => time);
    const brief = await call<OfficeArtifact>(chair, 'POST', '/api/artifacts', {
      club: 'jlu',
      title: 'Event brief',
      mime: 'text/markdown',
      content: Buffer.from('A club meeting').toString('base64'),
    });
    const draft: ActivityDraft = {
      id: 'meeting',
      club: 'jlu',
      title: 'Meeting',
      brief: brief.id,
      coOrganizers: ['other'],
      window: { opensMs: start - 1000, closesMs: start + 10000, startsMs: start + 20000 },
      checkinOpensMs: start + 10000,
      checkinClosesMs: start + 19000,
      endsMs: start + 30000,
    };
    await call(chair, 'POST', '/api/events', draft);
    const template: ApprovalTemplate = {
      id: 'committee',
      club: 'jlu',
      name: 'Committee',
      active: true,
      stages: [
        {
          name: 'Review',
          approver: { kind: 'member', account: reviewer.user.id },
          timeoutMs: 5000,
          onTimeout: 'reject',
        },
      ],
    };
    await call(chair, 'POST', '/api/approval-templates', template);
    await call(chair, 'POST', '/api/events/meeting/actions', { action: 'submit' });
    const flow = await call<ApprovalInstance>(chair, 'POST', '/api/workflows', {
      event: 'meeting',
      epoch: 1,
      template: 'committee',
    });
    await call(chair, 'POST', '/api/approval-templates', { ...template, active: false });
    const workflow = (login: typeof root, payload: object, status = 200) =>
      call<ApprovalInstance>(login, 'POST', `/api/workflows/${flow.id}/actions`, payload, status);
    await workflow(reviewer, { action: 'delegate', to: delegate.user.id });
    await workflow(reviewer, { action: 'approve', comment: 'Delegated already' }, 403);
    assert.equal(
      (await workflow(delegate, { action: 'approve', comment: 'Brief reviewed' })).current,
      1,
    );
    await workflow(chair, { action: 'approve', club: 'jlu', comment: 'Host club consents' });
    assert.equal(
      (
        await workflow(coChair, {
          action: 'approve',
          club: 'other',
          comment: 'Co-organizer consents',
        })
      ).status,
      'approved',
    );
    assert.equal((await workflow(root, { action: 'execute' })).status, 'executed');
    assert.equal(
      (
        await call<ActivityRecord>(chair, 'POST', '/api/events/meeting/actions', {
          action: 'publish',
        })
      ).phase,
      'open',
    );
    await call(member, 'POST', '/api/events/meeting/actions', { action: 'signup' });
    await call(chair, 'POST', '/api/events/meeting/tasks', {
      id: 'prepare',
      title: 'Prepare room',
      dueMs: start + 7000,
    });
    await call(chair, 'POST', '/api/tasks/prepare/actions', {
      action: 'assign',
      account: member.user.id,
    });
    await call(chair, 'POST', '/api/tasks/prepare/actions', {
      action: 'notify',
      dueMs: start + 1000,
    });
    time = start + 1000;
    const notices = await call<ActivityNoticeList>(member, 'GET', '/api/notices');
    assert.equal(notices.notices[0].account, member.user.id);
    await call(member, 'POST', `/api/notices/${notices.notices[0].id}/acknowledge`, {}, 204);
    assert.equal(
      (
        await call<ActivityTask>(member, 'POST', '/api/tasks/prepare/actions', {
          action: 'complete',
        })
      ).done,
      true,
    );
    const content = await service.app.inject({
      url: `/api/artifacts/${brief.id}/content`,
      headers: { authorization: `Bearer ${coChair.accessToken}` },
    });
    assert.equal(content.statusCode, 200);
    assert.equal(content.body, 'A club meeting');
    time = start + 12000;
    await call(member, 'POST', '/api/events/meeting/actions', { action: 'checkin' });
    const attendance = await call<ActivityAttendance>(
      chair,
      'GET',
      '/api/events/meeting/attendance',
    );
    assert.equal(attendance.members[0].account, member.user.id);
    assert.equal(attendance.members[0].checkedInAt, time);
    await call(member, 'POST', '/api/events/meeting/actions', { action: 'cancel_signup' }, 403);
    time = start + 20000;
    assert.equal(
      (
        await call<ActivityRecord>(chair, 'POST', '/api/events/meeting/actions', {
          action: 'finish',
        })
      ).phase,
      'done',
    );
    assert.equal(
      (
        JSON.parse(
          String(store.db.prepare('SELECT state FROM workflows WHERE id=?').get(flow.id)!.state),
        ) as ApprovalInstance
      ).status,
      'executed',
    );
  } finally {
    store.close();
    await service.close();
  }
});

test('explicit workflow deadlines and current chair authority survive revisions without accepting stale approval', async (context) => {
  const service = await site();
  const store = new Store(join(service.dir, 'db'));
  try {
    const root = await service.enroll('Admin');
    const chair = await service.enroll('Chair');
    const successor = await service.enroll('Successor');
    const reviewer = await service.enroll('Reviewer');
    store.db
      .prepare("INSERT INTO grants VALUES('admin','user',?,'global','admin','fixture',?,NULL,NULL)")
      .run(root.user.id, now());
    store.db.prepare("INSERT INTO clubs VALUES('visiting','Visiting','school','visiting')").run();
    store.db
      .prepare("UPDATE memberships SET status='revoked',revoked_at=? WHERE account=?")
      .run(now(), reviewer.user.id);
    store.db
      .prepare("INSERT INTO memberships VALUES(?,'visiting','active','import','[]',?,NULL)")
      .run(reviewer.user.id, now());
    const call = service.requestJson;
    const appointment = await call<{ id: string }>(root, 'POST', '/api/clubs/jlu/successions', {
      nominee: chair.user.id,
    });
    await call(chair, 'POST', `/api/identity/successions/${appointment.id}/accept`, {}, 204);
    let time = Date.now();
    context.mock.method(Date, 'now', () => time);
    const brief = await call<OfficeArtifact>(root, 'POST', '/api/artifacts', {
      club: 'jlu',
      title: 'Brief',
      mime: 'text/plain',
      content: Buffer.from('A reviewed activity').toString('base64'),
    });
    const draft: ActivityDraft = {
      id: 'activity',
      club: 'jlu',
      title: 'Activity',
      brief: brief.id,
      coOrganizers: [],
      window: { opensMs: time - 1000, closesMs: time + 10000, startsMs: time + 20000 },
      checkinOpensMs: time + 10000,
      checkinClosesMs: time + 19000,
      endsMs: time + 30000,
    };
    await call(root, 'POST', '/api/events', draft);
    await call(root, 'POST', '/api/approval-templates', {
      id: 'escalation',
      club: 'jlu',
      name: 'Escalation',
      active: true,
      stages: [
        {
          name: 'First review',
          approver: { kind: 'member', account: reviewer.user.id },
          timeoutMs: 100,
          onTimeout: 'escalate',
        },
        {
          name: 'Escalated review',
          approver: { kind: 'member', account: root.user.id },
          timeoutMs: 1000,
          onTimeout: 'reject',
        },
      ],
    });
    await call(root, 'POST', '/api/events/activity/actions', { action: 'submit' });
    const flow = await call<ApprovalInstance>(root, 'POST', '/api/workflows', {
      event: 'activity',
      epoch: 1,
      template: 'escalation',
    });
    assert.equal(
      (await call<ActivityRecord>(reviewer, 'GET', '/api/events/activity')).brief,
      brief.id,
    );
    time += 101;
    const poked = await call<ApprovalInstance>(root, 'POST', `/api/workflows/${flow.id}/actions`, {
      action: 'poke',
    });
    assert.equal(poked.records[0].escalated, true);
    await call(root, 'POST', `/api/workflows/${flow.id}/actions`, {
      action: 'approve',
      comment: 'Reviewed after escalation',
    });
    await call(chair, 'POST', `/api/workflows/${flow.id}/actions`, {
      action: 'approve',
      club: 'jlu',
      comment: 'Club consent',
    });
    const next = await call<{ id: string }>(chair, 'POST', '/api/clubs/jlu/successions', {
      nominee: successor.user.id,
    });
    await call(successor, 'POST', `/api/identity/successions/${next.id}/accept`, {}, 204);
    await call(root, 'POST', `/api/workflows/${flow.id}/actions`, { action: 'execute' }, 403);
    assert.ok(
      store.db
        .prepare(
          "SELECT 1 FROM audit WHERE actor=? AND action='authorize_action' AND target='execute'",
        )
        .get(root.user.id),
    );
    const revisedBrief = await call<OfficeArtifact>(root, 'POST', '/api/artifacts', {
      club: 'jlu',
      title: 'Updated brief',
      mime: 'text/plain',
      content: Buffer.from('Updated activity').toString('base64'),
      parent: brief.id,
    });
    assert.equal(
      (
        await call<ActivityRecord>(root, 'PUT', '/api/events/activity', {
          ...draft,
          brief: revisedBrief.id,
        })
      ).epoch,
      2,
    );
    assert.equal(
      (
        JSON.parse(
          String(store.db.prepare('SELECT state FROM workflows WHERE id=?').get(flow.id)!.state),
        ) as ApprovalInstance
      ).status,
      'cancelled',
    );
    await call(reviewer, 'GET', '/api/events/activity', undefined, 403);
    await call(reviewer, 'GET', `/api/artifacts/${revisedBrief.id}/content`, undefined, 403);
    const historical = await call<ApprovalList>(reviewer, 'GET', '/api/events/activity/workflows');
    assert.equal(historical.workflows.length, 1);
    assert.equal(historical.workflows[0].brief, brief.id);
    await call(root, 'POST', '/api/events/activity/actions', { action: 'submit' });
    const current = await call<ApprovalInstance>(root, 'POST', '/api/workflows', {
      event: 'activity',
      epoch: 2,
    });
    await call(
      root,
      'POST',
      `/api/workflows/${current.id}/actions`,
      { action: 'approve', comment: 'Not the chair' },
      403,
    );
    await call(successor, 'POST', `/api/workflows/${current.id}/actions`, {
      action: 'approve',
      club: 'jlu',
      comment: 'Current chair consents',
    });
    await call(root, 'POST', `/api/workflows/${current.id}/actions`, { action: 'execute' });
    assert.equal(
      (await call<ActivityRecord>(root, 'GET', '/api/events/activity')).brief,
      revisedBrief.id,
    );
    assert.equal(
      store.db.prepare('SELECT count(*) AS total FROM office_artifacts').get()!.total,
      2,
    );
  } finally {
    store.close();
    await service.close();
  }
});
