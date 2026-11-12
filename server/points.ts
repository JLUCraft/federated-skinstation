import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  pointPolicyUpdateSchema,
  pointPolicySchema,
  activitySourceConfigSchema,
  activitySourceListSchema,
  activitySourceRecordSchema,
  activityAttestationSchema,
  activityReceiptSchema,
  memberPointsSchema,
  pointAllowanceRequestSchema,
  pointAllowanceSchema,
  pointAllowanceListSchema,
  type PointPolicyUpdate,
  type PointPolicy,
  type ActivitySourceConfig,
  type ActivitySourceRecord,
  type ActivityAttestation,
  type ActivityReceipt,
  type MemberPoints,
  type PointAllowanceRequest,
  type PointAllowance,
  type PointLedgerEntry,
  type GameResource,
} from '../shared/contracts/generated.js';
import { ACTIVITY_LIMITS, POINT_LIMIT, pointAmount } from '../shared/points.js';
import { appendAudit, type LocalIdentity } from './permissions.js';
import { now, requireThat, type Store } from './store.js';
import { bearer } from './validate.js';

const LEDGER_PAGE_SIZE = 100;

export function points(value: string) {
  const amount = pointAmount(value);
  requireThat(amount !== undefined, 'Valid point amount required');
  return amount;
}

export class PointLedger {
  constructor(readonly store: Store) {}

  balance(account: string, club: string) {
    const row = this.store.db
      .prepare('SELECT available FROM point_balances WHERE account=? AND club=?')
      .get(account, club);
    return row ? BigInt(String(row.available)) : 0n;
  }

  frozen(account: string, club: string) {
    return this.store.db
      .prepare('SELECT amount FROM point_escrows WHERE account=? AND club=?')
      .all(account, club)
      .reduce((sum, row) => sum + BigInt(String(row.amount)), 0n);
  }

  adjust(
    account: string,
    club: string,
    delta: bigint,
    kind: string,
    reference: string,
    time = Date.now(),
  ) {
    const balance = this.balance(account, club) + delta;
    requireThat(
      balance >= 0n && balance + this.frozen(account, club) <= POINT_LIMIT,
      'Insufficient points or point overflow',
    );
    this.store.db
      .prepare(
        'INSERT INTO point_balances VALUES(?,?,?) ON CONFLICT(account,club) DO UPDATE SET available=excluded.available',
      )
      .run(account, club, balance.toString());
    this.store.db
      .prepare(
        'INSERT INTO point_ledger(club,account,kind,reference,credit,amount,balance,at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        club,
        account,
        kind,
        reference,
        delta >= 0n ? 1 : 0,
        (delta < 0n ? -delta : delta).toString(),
        balance.toString(),
        time,
      );
    return balance;
  }
}

export class Points {
  readonly ledger: PointLedger;
  constructor(
    private readonly store: Store,
    private readonly identity: LocalIdentity,
  ) {
    this.ledger = new PointLedger(store);
  }

  private policy(): PointPolicy {
    const row = this.store.db.prepare('SELECT daily_member_cap FROM point_policy WHERE id=1').get();
    requireThat(row, 'Activity policy is not configured');
    return { dailyMemberCap: String(row.daily_member_cap), limits: ACTIVITY_LIMITS };
  }

  readPolicy(actor: string) {
    this.identity.authenticate(actor);
    return this.policy();
  }

  setPolicy(actor: string, input: PointPolicyUpdate) {
    return this.identity.authorized(actor, 'global', 'admin', () => {
      requireThat(points(input.dailyMemberCap) > 0n, 'Positive activity cap required');
      this.store.db
        .prepare(
          'INSERT INTO point_policy VALUES(1,?) ON CONFLICT(id) DO UPDATE SET daily_member_cap=excluded.daily_member_cap',
        )
        .run(input.dailyMemberCap);
      appendAudit(this.store, actor, 'global', 'activity_policy', 'activity', input);
      return this.policy();
    });
  }

  private source(id: string): ActivitySourceRecord {
    const row = this.store.db.prepare('SELECT * FROM activity_sources WHERE id=?').get(id);
    requireThat(row, 'Activity source not found');
    return {
      config: JSON.parse(String(row.config)) as ActivitySourceConfig,
      lastWindowEndMs: Number(row.last_window_end_ms),
    };
  }

  private resource(config: ActivitySourceConfig) {
    const row = this.store.db
      .prepare('SELECT definition FROM game_resources WHERE id=?')
      .get(config.resource);
    requireThat(row, 'Activity game resource required');
    const resource = JSON.parse(String(row.definition)) as GameResource;
    requireThat(
      resource.club === config.club && resource.host === config.account,
      'Current resource host required',
    );
    return resource;
  }

  setSource(actor: string, config: ActivitySourceConfig) {
    return this.identity.authorized(actor, 'global', 'admin', () => {
      this.identity.requireMembership(config.account, config.club);
      this.resource(config);
      requireThat(
        points(config.pointsPerSlice) > 0n && points(config.dailySourceCap) > 0n,
        'Positive activity source rates required',
      );
      points(config.maxBonusPerSlice);
      const existing = this.store.db
        .prepare('SELECT config FROM activity_sources WHERE id=?')
        .get(config.id);
      requireThat(
        !existing ||
          (JSON.parse(String(existing.config)) as ActivitySourceConfig).club === config.club,
        'Activity source club is immutable',
      );
      this.store.db
        .prepare(
          'INSERT INTO activity_sources VALUES(?,?,0) ON CONFLICT(id) DO UPDATE SET config=excluded.config',
        )
        .run(config.id, JSON.stringify(config));
      appendAudit(this.store, actor, `club:${config.club}`, 'activity_source', config.id, config);
      return this.source(config.id);
    });
  }

  sources(actor: string) {
    this.identity.authenticate(actor);
    return this.store.db
      .prepare('SELECT id FROM activity_sources ORDER BY id')
      .all()
      .map((row) => this.source(String(row.id)));
  }

  attest(actor: string, input: ActivityAttestation) {
    const club = this.source(input.source).config.club;
    return this.identity.action(actor, `club:${club}`, 'activity_attest', () => {
      const source = this.source(input.source);
      const config = source.config;
      requireThat(config.enabled && config.account === actor, 'Enabled activity source required');
      this.identity.requireMembership(actor, config.club);
      this.resource(config);
      const policy = this.policy();
      const start = input.windowStartMs;
      const end = input.windowEndMs;
      const duration = end - start;
      const time = Date.now();
      const limits = ACTIVITY_LIMITS;
      requireThat(
        duration > 0 &&
          duration <= limits.sliceMs * limits.maxBatchSlices &&
          start % limits.sliceMs === 0 &&
          end % limits.sliceMs === 0 &&
          end <= time &&
          Object.keys(input.players).length <= limits.maxPlayers,
        'Invalid activity window',
      );
      const payload = JSON.stringify({
        source: input.source,
        windowStartMs: start,
        windowEndMs: end,
        players: Object.fromEntries(
          Object.keys(input.players)
            .sort()
            .map((account) => {
              const total = input.players[account];
              return [
                account,
                {
                  activeSlices: total.activeSlices,
                  afkSlices: total.afkSlices,
                  bonusPoints: total.bonusPoints,
                },
              ];
            }),
        ),
        evidence: input.evidence,
      });
      const id = `${input.source}:${start}:${end}`;
      const previous = this.store.db
        .prepare('SELECT payload,receipt FROM activity_receipts WHERE id=?')
        .get(id);
      if (previous) {
        requireThat(previous.payload === payload, 'Activity receipt reused with different payload');
        return () => JSON.parse(String(previous.receipt)) as ActivityReceipt;
      }
      requireThat(start >= source.lastWindowEndMs, 'Activity windows must not overlap');
      requireThat(
        this.store.db
          .prepare('SELECT 1 FROM office_artifacts WHERE id=? AND owner=?')
          .get(input.evidence, actor),
        'Source-owned activity evidence required',
      );
      const slices = duration / limits.sliceMs;
      const accounts = new Map<string, string>();
      for (const [account, total] of Object.entries(input.players)) {
        accounts.set(account, this.identity.affiliation(account));
        requireThat(
          total.activeSlices + total.afkSlices <= slices &&
            points(total.bonusPoints) <=
              BigInt(total.activeSlices) * points(config.maxBonusPerSlice),
          'Activity totals exceed the measured window',
        );
      }
      return () => {
        const day = Math.floor(time / limits.dayMs);
        const previousSource = this.store.db
          .prepare('SELECT * FROM activity_source_days WHERE source=? AND day=?')
          .get(input.source, day);
        const usedSource = BigInt(String(previousSource?.points ?? '0'));
        const sourceCap = points(config.dailySourceCap);
        let remaining = sourceCap > usedSource ? sourceCap - usedSource : 0n;
        let sourceActive = 0;
        let sourceAfk = 0;
        const awarded = new Map<string, string>();
        const cap = points(policy.dailyMemberCap);
        for (const account of [...accounts.keys()].sort()) {
          const total = input.players[account];
          const previousMember = this.store.db
            .prepare('SELECT * FROM activity_member_days WHERE account=? AND day=?')
            .get(account, day);
          const used = BigInt(String(previousMember?.points ?? '0'));
          const raw =
            ((BigInt(total.activeSlices) * points(config.pointsPerSlice) +
              points(total.bonusPoints)) *
              BigInt(config.weightBps)) /
            BigInt(limits.weightDenominator);
          const memberRemaining = cap > used ? cap - used : 0n;
          const award =
            raw < memberRemaining
              ? raw < remaining
                ? raw
                : remaining
              : memberRemaining < remaining
                ? memberRemaining
                : remaining;
          remaining -= award;
          sourceActive += total.activeSlices;
          sourceAfk += total.afkSlices;
          this.store.db
            .prepare(
              'INSERT INTO activity_member_days VALUES(?,?,?,?,?) ON CONFLICT(account,day) DO UPDATE SET points=excluded.points,active_slices=activity_member_days.active_slices+excluded.active_slices,afk_slices=activity_member_days.afk_slices+excluded.afk_slices',
            )
            .run(account, day, (used + award).toString(), total.activeSlices, total.afkSlices);
          this.ledger.adjust(account, accounts.get(account)!, award, 'activity', id, time);
          awarded.set(account, award.toString());
        }
        this.store.db
          .prepare(
            'INSERT INTO activity_source_days VALUES(?,?,?,?,?) ON CONFLICT(source,day) DO UPDATE SET points=excluded.points,active_slices=activity_source_days.active_slices+excluded.active_slices,afk_slices=activity_source_days.afk_slices+excluded.afk_slices',
          )
          .run(
            input.source,
            day,
            (sourceCap > usedSource ? sourceCap - remaining : usedSource).toString(),
            sourceActive,
            sourceAfk,
          );
        this.store.db
          .prepare('UPDATE activity_sources SET last_window_end_ms=? WHERE id=?')
          .run(end, input.source);
        const receipt: ActivityReceipt = {
          id,
          attestation: input,
          creditedAt: time,
          creditedDay: day,
          accounts: Object.fromEntries(accounts),
          awarded: Object.fromEntries(awarded),
        };
        this.store.db
          .prepare('INSERT INTO activity_receipts VALUES(?,?,?,?)')
          .run(id, input.source, payload, JSON.stringify(receipt));
        appendAudit(this.store, actor, `club:${config.club}`, 'activity_attest', id, receipt);
        return receipt;
      };
    });
  }

  overview(actor: string): MemberPoints {
    return this.store.transaction(() => {
      this.identity.authenticate(actor);
      const time = Date.now();
      const day = Math.floor(time / ACTIVITY_LIMITS.dayMs);
      const usage = this.store.db
        .prepare('SELECT * FROM activity_member_days WHERE account=? AND day=?')
        .get(actor, day);
      const entries: PointLedgerEntry[] = this.store.db
        .prepare('SELECT * FROM point_ledger WHERE account=? ORDER BY seq DESC LIMIT ?')
        .all(actor, LEDGER_PAGE_SIZE)
        .map((row) => ({
          seq: Number(row.seq),
          club: String(row.club),
          account: actor,
          kind: String(row.kind),
          reference: String(row.reference),
          credit: row.credit === 1,
          amount: String(row.amount),
          balance: String(row.balance),
          at: Number(row.at),
        }));
      return {
        account: actor,
        asOfMs: time,
        dayEndsMs: (day + 1) * ACTIVITY_LIMITS.dayMs,
        earnedToday: String(usage?.points ?? '0'),
        activeSlices: Number(usage?.active_slices ?? 0),
        afkSlices: Number(usage?.afk_slices ?? 0),
        balances: this.store.db
          .prepare('SELECT club,available FROM point_balances WHERE account=? ORDER BY club')
          .all(actor)
          .map((row) => ({
            club: String(row.club),
            available: String(row.available),
            frozen: this.ledger.frozen(actor, String(row.club)).toString(),
          })),
        entries,
      };
    });
  }

  private allowance(scope: string): PointAllowance | undefined {
    const row = this.store.db.prepare('SELECT * FROM point_allowances WHERE scope=?').get(scope);
    return row
      ? {
          scope,
          club: String(row.club),
          account: String(row.account),
          epoch: Number(row.epoch),
          remaining: String(row.remaining),
        }
      : undefined;
  }

  authorizeBudget(actor: string, input: PointAllowanceRequest) {
    return this.identity.action(actor, input.scope, 'authorize_point_budget', () => {
      this.identity.authenticate(actor);
      const budget = points(input.budget);
      const previous = this.allowance(input.scope);
      const revocation =
        budget === 0n && previous?.account === actor && previous.club === input.club;
      if (!revocation) {
        this.identity.requireMembership(actor, input.club);
        requireThat(
          input.scope === `member:${actor}` ||
            (input.scope.startsWith('event:') &&
              this.identity.decide(actor, input.scope, 'manage')),
          'Point spending scope authority required',
        );
        requireThat(
          budget <= this.ledger.balance(actor, input.club),
          'Budget exceeds available points',
        );
      }
      const allowance: PointAllowance = {
        scope: input.scope,
        club: input.club,
        account: actor,
        epoch: (previous?.epoch ?? 0) + 1,
        remaining: input.budget,
      };
      return () => {
        this.store.db
          .prepare(
            'INSERT INTO point_allowances VALUES(?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET club=excluded.club,account=excluded.account,epoch=excluded.epoch,remaining=excluded.remaining',
          )
          .run(
            allowance.scope,
            allowance.club,
            allowance.account,
            allowance.epoch,
            allowance.remaining,
          );
        appendAudit(this.store, actor, input.scope, 'authorize_point_budget', actor, allowance);
        return allowance;
      };
    });
  }

  allowances(actor: string) {
    this.identity.authenticate(actor);
    return this.store.db
      .prepare('SELECT scope FROM point_allowances WHERE account=? ORDER BY scope')
      .all(actor)
      .map((row) => this.allowance(String(row.scope))!);
  }
}

export function registerPoints(app: FastifyInstance, store: Store, identity: LocalIdentity) {
  const service = new Points(store, identity);
  const actor = (request: FastifyRequest) =>
    store.token(bearer(request.headers.authorization), undefined, now()).id;
  app.get(
    '/api/points/policy',
    { schema: { response: { 200: pointPolicySchema } } },
    async (request) => service.readPolicy(actor(request)),
  );
  app.post<{ Body: PointPolicyUpdate }>(
    '/api/points/policy',
    {
      schema: { body: pointPolicyUpdateSchema, response: { 200: pointPolicySchema } },
    },
    async (request) => service.setPolicy(actor(request), request.body),
  );
  app.get(
    '/api/activity-sources',
    { schema: { response: { 200: activitySourceListSchema } } },
    async (request) => ({ sources: service.sources(actor(request)) }),
  );
  app.post<{ Body: ActivitySourceConfig }>(
    '/api/activity-sources',
    {
      schema: { body: activitySourceConfigSchema, response: { 200: activitySourceRecordSchema } },
    },
    async (request) => service.setSource(actor(request), request.body),
  );
  app.post<{ Body: ActivityAttestation }>(
    '/api/points/activity',
    {
      schema: { body: activityAttestationSchema, response: { 200: activityReceiptSchema } },
    },
    async (request) => service.attest(actor(request), request.body),
  );
  app.get(
    '/api/points/me',
    { schema: { response: { 200: memberPointsSchema } } },
    async (request) => service.overview(actor(request)),
  );
  app.post<{ Body: PointAllowanceRequest }>(
    '/api/points/allowances',
    {
      schema: { body: pointAllowanceRequestSchema, response: { 200: pointAllowanceSchema } },
    },
    async (request) => service.authorizeBudget(actor(request), request.body),
  );
  app.get(
    '/api/points/allowances',
    { schema: { response: { 200: pointAllowanceListSchema } } },
    async (request) => ({ allowances: service.allowances(actor(request)) }),
  );
  return service;
}
