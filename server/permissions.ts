import { randomUUID } from 'node:crypto';
import {
  PERMISSIONS, createAuthorizer, isPermission, parseScope, type Scope, type Permission, type PermissionSource,
} from '../shared/permissions.js';
import type { ClubDirectory, ClubMembers, GrantList, IdentitySnapshot } from '../shared/contracts/generated.js';
import { digest, now, requireThat, Rejected, type Store } from './store.js';
import type { School } from './school.js';

interface Membership { status: IdentitySnapshot['memberships'][number]['status']; roles: string }
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
  isGlobalAdministrator(account: string) {
    return this.enabled(account) && !!this.store.db.prepare(
      "SELECT 1 FROM grants WHERE principal_kind='user' AND principal=? AND scope='global' AND permission='admin' AND revoked_at IS NULL",
    ).get(account);
  }
  authenticate(account: string) {
    requireThat(this.enabled(account), 'Account disabled');
    requireThat(this.store.db.prepare(
      "SELECT 1 FROM memberships WHERE account=? AND status='active'",
    ).get(account), 'Active club membership required');
  }
  hasSiteAdministrator() {
    return !!this.store.db.prepare(
      "SELECT 1 FROM grants g JOIN accounts a ON a.id=g.principal WHERE g.principal_kind='user' AND g.scope='global' AND g.permission='admin' AND g.revoked_at IS NULL AND a.disabled=0 AND EXISTS(SELECT 1 FROM memberships m WHERE m.account=a.id AND m.status='active') LIMIT 1",
    ).get();
  }
  snapshot(account: string): IdentitySnapshot {
    return this.store.transaction(() => {
      this.authenticate(account);
      const memberships = this.store.db.prepare(
        'SELECT m.club,c.title,m.status,m.roles,h.account AS chair,COALESCE(h.epoch,0) AS epoch FROM memberships m JOIN clubs c ON c.id=m.club LEFT JOIN chairs h ON h.club=m.club WHERE m.account=? ORDER BY m.club',
      ).all(account).map(row => ({
        club: String(row.club), title: String(row.title),
        status: row.status as Membership['status'],
        roles: JSON.parse(String(row.roles)) as string[],
        chair: row.status === 'active' && row.chair === account, epoch: Number(row.epoch),
      }));
      const grants = this.store.db.prepare(
        "SELECT id,scope,permission FROM grants WHERE principal_kind='user' AND principal=? AND revoked_at IS NULL ORDER BY scope,permission,id",
      ).all(account).map(row => ({
        id: String(row.id), scope: String(row.scope), permission: String(row.permission),
      }));
      const successions = this.store.db.prepare(
        "SELECT id,club,proposed_by,epoch FROM successions WHERE nominee=? AND status='open' ORDER BY created_at,id",
      ).all(account).map(row => ({
        id: String(row.id), club: String(row.club),
        proposedBy: String(row.proposed_by), epoch: Number(row.epoch),
      }));
      return {
        account, memberships, grants, successions,
        siteAdmin: this.decide(account, 'global', 'admin'),
        muaAdmin: this.decide(account, 'service:mua', 'admin'),
      };
    });
  }
  clubs(account: string): ClubDirectory {
    return this.store.transaction(() => {
      this.authenticate(account);
      const clubs = this.store.db.prepare(
        "SELECT c.id,c.title,a.name AS chair_name,COALESCE(h.epoch,0) AS epoch FROM clubs c LEFT JOIN chairs h ON h.club=c.id LEFT JOIN memberships m ON m.account=h.account AND m.club=c.id AND m.status='active' LEFT JOIN accounts a ON a.id=m.account AND a.disabled=0 ORDER BY c.title,c.id",
      ).all().map(row => {
        const id = String(row.id);
        return {
          id, title: String(row.title), chairName: row.chair_name === null ? null : String(row.chair_name),
          epoch: Number(row.epoch),
          permissions: {
            members: this.decide(account, `club:${id}`, 'members.manage'),
            chairs: this.decide(account, `club:${id}`, 'chairs.manage'),
            grants: this.decide(account, `club:${id}`, 'grants.manage'),
            recovery: this.decide(account, `club:${id}`, 'accounts.recover'),
            selfNomination: this.canNominateSelf(account, id),
          },
        };
      }).filter(club => club.permissions.members || club.permissions.chairs || club.permissions.grants || club.permissions.recovery);
      return {
        clubs,
        globalGrants: this.decide(account, 'global', 'grants.manage'),
        muaGrants: this.decide(account, 'service:mua', 'grants.manage'),
        disableAccounts: this.decide(account, 'global', 'accounts.disable'),
      };
    });
  }
  members(actor: string, club: string): ClubMembers {
    return this.authorized(actor, `club:${club}`, 'members.manage', () => ({
      members: this.store.db.prepare(
        'SELECT m.account,a.name,m.status,m.roles,m.since,a.disabled FROM memberships m JOIN accounts a ON a.id=m.account WHERE m.club=? ORDER BY a.name,m.account',
      ).all(club).map(row => ({
        account: String(row.account), name: String(row.name), status: row.status as Membership['status'],
        roles: JSON.parse(String(row.roles)) as string[], disabled: row.disabled === 1, since: Number(row.since),
      })),
    }));
  }
  successions(actor: string, club: string) {
    return this.authorized(actor, `club:${club}`, 'chairs.manage', () => ({
      successions: this.store.db.prepare(
        'SELECT id,proposed_by,nominee,status,epoch,created_at,closed_at FROM successions WHERE club=? ORDER BY created_at DESC,id',
      ).all(club),
    }));
  }
  listGrants(actor: string, scope: string): GrantList {
    return this.authorized(actor, scope, 'grants.manage', () => {
      requireThat(this.parent(scope as Scope) !== undefined, 'Known scope required');
      return {
        grants: this.store.db.prepare(
          "SELECT g.id,g.principal_kind,g.principal,g.permission,g.granted_by,g.granted_at,a.name FROM grants g LEFT JOIN accounts a ON g.principal_kind='user' AND a.id=g.principal WHERE g.scope=? AND g.revoked_at IS NULL ORDER BY g.granted_at,g.id",
        ).all(scope).map(row => ({
          id: String(row.id), principal: String(row.principal),
          principalKind: row.principal_kind as 'user' | 'service',
          name: row.name === null ? null : String(row.name), permission: String(row.permission),
          grantedBy: String(row.granted_by), grantedAt: Number(row.granted_at),
        })),
        grantablePermissions: (Object.keys(PERMISSIONS) as Permission[]).filter(permission =>
          permission !== 'president' && (!PERMISSIONS[permission].globalOnly || scope === 'global') &&
          this.decide(actor, scope, permission)),
      };
    });
  }
  grantPermission(actor: string, account: string, scope: string, permission: string) {
    requireThat(isPermission(permission) && permission !== 'president', 'Grantable permission required');
    return this.authorized(actor, scope, ['grants.manage', permission], () => {
      requireThat(this.parent(scope as Scope) !== undefined && this.enabled(account), 'Known scope and enabled account required');
      let current: Scope | null | undefined = scope as Scope;
      while (current) {
        const parsed = parseScope(current)!;
        if (parsed.kind === 'club')
          requireThat(this.membership(account, parsed.id!)?.status === 'active', 'Active grantee membership required');
        current = this.parent(current);
      }
      requireThat(permission !== 'accounts.disable' || scope === 'global', 'Global grant required');
      const existing = this.store.db.prepare(
        "SELECT id FROM grants WHERE principal_kind='user' AND principal=? AND scope=? AND permission=? AND revoked_at IS NULL",
      ).get(account, scope, permission);
      if (existing) return String(existing.id);
      const id = randomUUID();
      this.store.db.prepare("INSERT INTO grants VALUES(?,'user',?,?,?,?,?,NULL,NULL)")
        .run(id, account, scope, permission, actor, now());
      appendAudit(this.store, actor, scope, 'grant_permission', id, { account, permission });
      return id;
    });
  }
  revokeGrant(actor: string, id: string) {
    const grant = this.store.db.prepare('SELECT scope,permission,revoked_at FROM grants WHERE id=?').get(id);
    requireThat(grant, 'Grant not found');
    this.authorized(actor, String(grant.scope), ['grants.manage', String(grant.permission)], () => {
      if (grant.revoked_at !== null) return;
      this.store.db.prepare('UPDATE grants SET revoked_at=?,revoked_by=? WHERE id=?')
        .run(now(), actor, id);
      appendAudit(this.store, actor, String(grant.scope), 'revoke_grant', id, {});
    });
  }
  disableAccount(actor: string, account: string) {
    this.authorized(actor, 'global', 'accounts.disable', () => {
      requireThat(this.store.account('id', account), 'Account not found');
      this.store.db.prepare('UPDATE accounts SET disabled=1 WHERE id=?').run(account);
      this.store.revokeSessions(account);
      appendAudit(this.store, actor, 'global', 'disable_account', account, {});
    });
  }
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
    if (parsed.kind === 'league') {
      const league = this.store.db.prepare('SELECT club FROM leagues WHERE id=?').get(parsed.id!);
      return league ? `club:${league.club}` : undefined;
    }
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
  authorized<T>(actor: string, scope: string, permission: string | readonly string[], action: () => T): T {
    const result = this.store.transaction((): { value: T } | { error: unknown } => {
      for (const required of typeof permission === 'string' ? [permission] : permission) {
        if (!this.decide(actor, scope, required)) return { error: new Rejected('Local authority required') };
      }
      const hadAdministrator = this.hasSiteAdministrator();
      this.store.db.exec('SAVEPOINT identity_action');
      try {
        const value = action();
        requireThat(!hadAdministrator || this.hasSiteAdministrator(), 'An active site administrator must remain');
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
      for (const [name, scope, accounts] of [
        ['site_admins', 'global', siteAdmins],
        ['mua_admins', 'service:mua', muaAdmins],
      ] as const) {
        if (accounts.length === 0 || this.store.db.prepare('SELECT 1 FROM identity_seeds WHERE name=?').get(name)) continue;
        for (const account of new Set(accounts)) {
          this.store.db.prepare("INSERT INTO grants VALUES(?,'user',?,?,'admin','config',?,NULL,NULL)")
            .run(randomUUID(), account, scope, now());
          appendAudit(this.store, 'config', scope, 'seed_admin', account, { permission: 'admin' }, 'system');
        }
        this.store.db.prepare('INSERT INTO identity_seeds VALUES(?)').run(name);
      }
    });
  }

  /** Configured school ownership is trusted; email strings alone cannot create clubs. */
  configureSchools(schools: Record<string, School>) {
    this.store.transaction(() => {
      for (const [school, config] of Object.entries(schools)) {
        const club = config.club ?? school;
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
    const club = school.club ?? a.school;
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
        "UPDATE grants SET revoked_at=?,revoked_by=? WHERE revoked_at IS NULL AND principal_kind='user' AND principal=? AND (scope=? OR scope IN (SELECT 'service:'||id FROM services WHERE club=?) OR scope IN (SELECT 'league:'||id FROM leagues WHERE club=?))",
      ).run(now(), actor, account, `club:${club}`, club, club);
      if (!this.store.db.prepare("SELECT 1 FROM memberships WHERE account=? AND status='active'").get(account)) {
        this.store.revokeSessions(account);
      }
      appendAudit(this.store, actor, `club:${club}`, 'revoke_membership', account, {});
    });
  }

  proposeSuccession(actor: string, club: string, nominee: string): string {
    return this.authorized(actor, `club:${club}`, 'chairs.manage', () => {
      this.checkSelfNomination(actor, nominee, club);
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
      this.checkSelfNomination(proposal.proposed_by, actor, proposal.club);
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
  private checkSelfNomination(actor: string, nominee: string, club: string) {
    requireThat(actor !== nominee || this.canNominateSelf(actor, club),
      'Self-nomination requires chair or site administrator authority');
  }
  private canNominateSelf(actor: string, club: string) {
    return this.chair(club)?.account === actor || this.isGlobalAdministrator(actor);
  }
}
