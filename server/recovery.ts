import { randomUUID } from 'node:crypto';
import { appendAudit, type LocalIdentity } from './permissions.js';
import { digest, now, requireThat, secret, type Store } from './store.js';
import type { School } from './school.js';
import { RECOVERY_EMAIL_MAX_LENGTH } from '../shared/identity.js';

const RECOVERY_TTL_SECONDS = 15 * 60;

interface Recovery {
  id: string;
  account: string;
  club: string;
  requested_by: string;
  email: string;
}

export class AccountRecovery {
  constructor(
    private readonly store: Store,
    private readonly identity: LocalIdentity,
    private readonly schools: Record<string, School>,
  ) {}

  private target(actor: string, account: string, club: string) {
    const target = this.store.account('id', account);
    requireThat(target?.disabled === 0, 'Enabled recovery account required');
    const school = this.schools[target.school];
    requireThat(
      school && (school.club ?? target.school) === club,
      'Recovery belongs to the account home club',
    );
    requireThat(
      this.store.db
        .prepare("SELECT 1 FROM memberships WHERE account=? AND club=? AND status='active'")
        .get(account, club),
      'Active recovery membership required',
    );
    const privileged = this.store.db
      .prepare(
        "SELECT 1 FROM grants WHERE principal_kind='user' AND principal=? AND scope='global' AND revoked_at IS NULL",
      )
      .get(account);
    requireThat(
      !privileged || this.identity.isGlobalAdministrator(actor),
      'Site administrator required to recover global authority',
    );
    return target;
  }

  propose(actor: string, club: string, account: string, email: string) {
    return this.identity.authorized(actor, `club:${club}`, 'accounts.recover', () => {
      this.target(actor, account, club);
      const address = email.toLowerCase().trim();
      requireThat(
        address.length <= RECOVERY_EMAIL_MAX_LENGTH && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address),
        'Valid recovery email required',
      );
      const existing = this.store.account('email', address);
      requireThat(!existing || existing.id === account, 'Recovery email already in use');
      const id = randomUUID();
      const code = secret();
      this.store.db
        .prepare('DELETE FROM account_recoveries WHERE account=? OR expires<=?')
        .run(account, now());
      this.store.db
        .prepare('INSERT INTO account_recoveries VALUES(?,?,?,?,?,?,?)')
        .run(id, account, club, actor, address, digest(code), now() + RECOVERY_TTL_SECONDS);
      appendAudit(this.store, actor, `club:${club}`, 'propose_recovery', account, {
        id,
        email: address,
      });
      return { email: address, confirmation: `${id}.${code}` };
    });
  }

  confirm(confirmation: string, passwordHash: string) {
    const parts = confirmation.split('.');
    requireThat(parts.length === 2, 'Invalid recovery confirmation');
    const [id, code] = parts;
    const proposal = this.store.db
      .prepare('SELECT * FROM account_recoveries WHERE id=?')
      .get(id) as Recovery | undefined;
    requireThat(proposal, 'Invalid recovery confirmation');
    this.identity.authorized(
      proposal.requested_by,
      `club:${proposal.club}`,
      'accounts.recover',
      () => {
        const recovery = this.store.db
          .prepare('SELECT * FROM account_recoveries WHERE id=? AND token=? AND expires>?')
          .get(id, digest(code), now()) as Recovery | undefined;
        requireThat(recovery, 'Invalid or expired recovery confirmation');
        const target = this.target(recovery.requested_by, recovery.account, recovery.club);
        const existing = this.store.account('email', recovery.email);
        requireThat(!existing || existing.id === target.id, 'Recovery email already in use');
        this.store.db
          .prepare('UPDATE accounts SET email=?,password=?,verified_at=? WHERE id=?')
          .run(recovery.email, passwordHash, now(), target.id);
        this.store.revokeSessions(target.id);
        this.store.db.prepare('DELETE FROM passkeys WHERE account=?').run(target.id);
        this.store.db.prepare('DELETE FROM password_resets WHERE account=?').run(target.id);
        this.store.db
          .prepare('DELETE FROM challenges WHERE email IN (?,?)')
          .run(target.email, recovery.email);
        this.store.db.prepare('DELETE FROM account_recoveries WHERE id=?').run(id);
        appendAudit(this.store, target.id, `club:${recovery.club}`, 'confirm_recovery', target.id, {
          requestedBy: recovery.requested_by,
          email: recovery.email,
        });
      },
    );
  }
}
