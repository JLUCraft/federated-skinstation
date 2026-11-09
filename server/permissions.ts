import { randomUUID } from 'node:crypto';
import {
  createAuthorizer, parseScope, type Scope, type PermissionSource,
} from '../shared/permissions.js';
import { digest, now, requireThat, Rejected, type Store } from './store.js';
import type { School } from './school.js';

interface Membership { status: 'active' | 'revoked'; roles: string }
interface Chair { account: string; epoch: number }
interface Succession { club: string; proposed_by: string; nominee: string; epoch: number; status: string }

/** All callers append inside the same transaction as the action being recorded. */
export function appendAudit(
  store: Store, actor: string, scope: string, action: string,
  target: string, payload: unknown, actorKind = 'user',
) {
  const previous = store.db.prepare('SELECT seq,hash FROM audit ORDER BY seq DESC LIMIT 1').get();
  const seq = Number(previous?.seq ?? 0) + 1;
  const at = now();
  const payloadDigest = digest(JSON.stringify(payload));
  const prevHash = String(previous?.hash ?? '');
  const hash = digest(JSON.stringify([seq, at, actorKind, actor, scope, action, target, payloadDigest, prevHash]));
  store.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(seq, at, actorKind, actor, scope, action, target, payloadDigest, prevHash, hash);
}

export class LocalIdentity {
  constructor(readonly store: Store) {}
  private membership(account: string, club: string) {
    return this.store.db.prepare('SELECT status,roles FROM memberships WHERE account=? AND club=?')
      .get(account, club) as Membership | undefined;
  }
  private chair(club: string) {
    return this.store.db.prepare('SELECT account,epoch FROM chairs WHERE club=?')
      .get(club) as Chair | undefined;
  }
  private enabled(account: string) {
    const row = this.store.account('id', account);
    return !!row && row.disabled === 0;
  }
  private parent(scope: Scope): Scope | null | undefined {
    const parsed = parseScope(scope);
    if (!parsed) return undefined;
    if (parsed.kind === 'global') return null;
    if (parsed.kind === 'club')
      return this.store.db.prepare('SELECT 1 FROM clubs WHERE id=?').get(parsed.id!) ? 'global' : undefined;
    if (parsed.kind === 'service') {
      const service = this.store.db.prepare('SELECT club FROM services WHERE id=?').get(parsed.id!);
      // The built-in MUA integration is global and has no club owner.
      return service ? `club:${service.club}` : parsed.id === 'mua' ? 'global' : undefined;
    }
    // P2 resources have no ownership model yet: never guess a parent.
    return undefined;
  }
  authorize(account: string, scope: string, permission: string): boolean {
    return this.store.transaction(() => this.decide(account, scope, permission));
  }
  private decide(account: string, scope: string, permission: string): boolean {
      const source: PermissionSource = {
        enabled: a => this.enabled(a),
        parent: s => this.parent(s),
        membership: (a, club) => {
          const m = this.membership(a, club);
          return m && { active: m.status === 'active', roles: JSON.parse(m.roles) as string[] };
        },
        chair: (a, club) => this.chair(club)?.account === a,
        grants: (a, s) => this.store.db.prepare(
          "SELECT permission FROM grants WHERE principal_kind='user' AND principal=? AND scope=? AND revoked_at IS NULL",
        ).all(a, s).map(row => String(row.permission)),
        audit: (a, s, p, allowed) => appendAudit(this.store, a, s, 'authorize', p, { allowed }),
      };
      return createAuthorizer(source)(account, scope, permission);
  }

  /** Keep the decision and mutation under one write lock, retaining failed decisions. */
  private authorized<T>(actor: string, scope: string, permission: string, action: () => T): T {
    const result = this.store.transaction((): { value: T } | { error: unknown } => {
      if (!this.decide(actor, scope, permission)) return { error: new Rejected('Local authority required') };
      this.store.db.exec('SAVEPOINT identity_action');
      try {
        const value = action();
        this.store.db.exec('RELEASE identity_action');
        return { value };
      } catch (error) {
        this.store.db.exec('ROLLBACK TO identity_action; RELEASE identity_action');
        return { error };
      }
    });
    if ('error' in result) throw result.error;
    return result.value;
  }

  /** One-time configuration import. Revoked grants are never reseeded on restart. */
  seedAdmins(siteAdmins: readonly string[], muaAdmins: readonly string[]) {
    this.store.transaction(() => {
      if (this.store.db.prepare("SELECT 1 FROM identity_seeds WHERE name='admins'").get()) return;
      for (const [scope, accounts] of [['global', siteAdmins], ['service:mua', muaAdmins]] as const)
        for (const account of new Set(accounts)) {
          this.store.db.prepare("INSERT INTO grants VALUES(?,'user',?,?,'admin','config',?,NULL,NULL)")
            .run(randomUUID(), account, scope, now());
          appendAudit(this.store, 'config', scope, 'seed_admin', account, { permission: 'admin' }, 'system');
        }
      this.store.db.prepare("INSERT INTO identity_seeds VALUES('admins')").run();
    });
  }

  /** Configured school ownership is trusted; email strings alone cannot create clubs. */
  configureSchools(schools: Record<string, School>) {
    this.store.transaction(() => {
      for (const [school, config] of Object.entries(schools)) {
        const club = config.identity?.club ?? school;
        this.store.db.prepare("INSERT INTO clubs VALUES(?,?,'school',?) ON CONFLICT(id) DO NOTHING")
          .run(club, school, school);
        requireThat(this.store.db.prepare('SELECT school FROM clubs WHERE id=?').get(club)!.school === school,
          'Club belongs to another school');
      }
    });
  }

  /** Called inside email confirmation's transaction after the challenge is consumed. */
  enrollVerifiedEmail(account: string, schools: Record<string, School>) {
    const a = this.store.account('id', account);
    requireThat(a && a.verified_at > 0 && a.disabled === 0, 'Verified enabled account required');
    const school = schools[a.school];
    const parts = a.email.toLowerCase().split('@');
    requireThat(school && parts.length === 2 && school.emailDomains.some(d => d.toLowerCase() === parts[1]),
      'Unsupported school email');
    const club = school.identity?.club ?? a.school;
    if (this.membership(account, club)) return;
    const inserted = this.store.db.prepare(
      "INSERT INTO memberships(account,club,status,source,roles,since) VALUES(?,?,'active','email_domain','[]',?)",
    ).run(account, club, now());
    if (inserted.changes)
      appendAudit(this.store, account, `club:${club}`, 'join_email_domain', account, { source: 'email_domain' });
  }

  revokeMembership(actor: string, account: string, club: string) {
    this.authorized(actor, `club:${club}`, 'members.manage', () => {
      const member = this.membership(account, club);
      requireThat(member, 'Membership not found');
      if (member.status === 'revoked') return;
      this.store.db.prepare("UPDATE memberships SET status='revoked',revoked_at=? WHERE account=? AND club=?")
        .run(now(), account, club);
      // Keep the chair epoch as history; an inactive chair derives no authority.
      this.store.db.prepare(
        "UPDATE grants SET revoked_at=?,revoked_by=? WHERE revoked_at IS NULL AND principal_kind='user' AND principal=? AND (scope=? OR scope IN (SELECT 'service:'||id FROM services WHERE club=?))",
      ).run(now(), actor, account, `club:${club}`, club);
      if (!this.store.db.prepare("SELECT 1 FROM memberships WHERE account=? AND status='active'").get(account)) {
        this.store.db.prepare('DELETE FROM tokens WHERE account=?').run(account);
        // These tables are owned by the optional connect routes.
        for (const table of ['oauth_refresh', 'oauth_devices']) {
          if (this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
            this.store.db.prepare(`DELETE FROM ${table} WHERE account=?`).run(account);
        }
      }
      appendAudit(this.store, actor, `club:${club}`, 'revoke_membership', account, {});
    });
  }

  proposeSuccession(actor: string, club: string, nominee: string): string {
    return this.authorized(actor, `club:${club}`, 'chairs.manage', () => {
      requireThat(this.enabled(nominee) && this.membership(nominee, club)?.status === 'active',
        'Nominee must be an active club member');
      const id = randomUUID();
      const epoch = (this.chair(club)?.epoch ?? 0) + 1;
      this.store.db.prepare("INSERT INTO successions VALUES(?,?,?,?,'open',?,?,NULL)")
        .run(id, club, actor, nominee, epoch, now());
      appendAudit(this.store, actor, `club:${club}`, 'propose_succession', id, { nominee, epoch });
      return id;
    });
  }

  /** Appointment by the club's current authority, accepted by the nominee. No external quorum. */
  acceptSuccession(actor: string, id: string) {
    const proposal = this.store.db.prepare('SELECT * FROM successions WHERE id=?').get(id) as Succession | undefined;
    requireThat(proposal && proposal.status === 'open' && proposal.nominee === actor, 'Open nomination required');
    this.authorized(proposal.proposed_by, `club:${proposal.club}`, 'chairs.manage', () => {
      requireThat(this.store.db.prepare("SELECT 1 FROM successions WHERE id=? AND status='open'").get(id),
        'Open nomination required');
      requireThat(this.enabled(actor) && this.membership(actor, proposal.club)?.status === 'active',
        'Active nominee required');
      requireThat(proposal.epoch === (this.chair(proposal.club)?.epoch ?? 0) + 1, 'Stale succession');
      this.store.db.prepare("INSERT INTO succession_votes VALUES(?,?,?,'approve')").run(randomUUID(), id, actor);
      this.store.db.prepare('INSERT INTO chairs VALUES(?,?,?,?) ON CONFLICT(club) DO UPDATE SET account=excluded.account,epoch=excluded.epoch,updated_at=excluded.updated_at')
        .run(proposal.club, actor, proposal.epoch, now());
      this.store.db.prepare("UPDATE successions SET status=CASE WHEN id=? THEN 'accepted' ELSE 'rejected' END,closed_at=? WHERE club=? AND status='open'")
        .run(id, now(), proposal.club);
      appendAudit(this.store, actor, `club:${proposal.club}`, 'accept_succession', id, { epoch: proposal.epoch });
    });
  }
}
