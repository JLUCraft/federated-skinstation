// The Rust client is the schema/signature/replay authority; this adapter only attests verified accounts.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Rejected, requireThat, type Account, type Store } from './store.js';
import { record, field } from './validate.js';
import type { School } from './school.js';
const MAX_OUTPUT = 8 * 1024 * 1024;
export interface UnifiedVerification {
  endpoint: string; tokenFile: string; verifier: string; club: string;
}
const queues = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work); queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
function configuration(school: School): UnifiedVerification {
  requireThat(school.identity, 'Unified identity verifier is not configured');
  return school.identity;
}
async function run(config: UnifiedVerification, operation: 'state' | 'draft' | 'confirm', body?: unknown): Promise<unknown> {
  try {
    const base = new URL(config.endpoint);
    requireThat(base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname)
      && !base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'Identity bridge must be a loopback URL');
    const token: unknown = JSON.parse(await readFile(config.tokenFile, 'utf8'));
    requireThat(typeof token === 'string' && token.length >= 32, 'Invalid identity bridge token');
    const response = await fetch(new URL(operation, base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 403) throw new Rejected('Identity action is not authorized');
    if (!response.ok) throw new Error('Identity bridge unavailable');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty identity response');
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read(); if (done) break;
        length += value.length;
        if (length > MAX_OUTPUT) throw new Error('Identity response too large');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof Rejected) throw error;
    throw new Rejected('Identity authority is temporarily unavailable; synchronize and retry', 503, 'Service Unavailable');
  }
}
function accountMember(db: Store, account: Account, verifiedMember?: string): string {
  const existing = db.db.prepare('SELECT member FROM identity_members WHERE account=?').get(account.id) as {member: string} | undefined;
  if (existing) { requireThat(!verifiedMember || existing.member === verifiedMember, 'Device belongs to another member'); return existing.member; }
  const member = verifiedMember ?? randomUUID();
  db.db.prepare('INSERT INTO identity_members(account,member,confirmed) VALUES(?,?,0)').run(account.id, member);
  return member;
}
async function currentState(config: UnifiedVerification): Promise<Record<string, unknown>> {
  return record(await run(config, 'state'));
}
function hasMembership(entries: unknown, member: string, club: string): boolean {
  requireThat(Array.isArray(entries), 'Invalid identity state');
  return entries.some(entry => Array.isArray(entry) && entry[0] === member && entry[1] === club);
}
/** Unbound skin accounts are not federation members. Bound accounts must honor revocation. */
export async function authorizeAccount(db: Store, account: Account, school: School): Promise<void> {
  const mapping = db.db.prepare('SELECT member,confirmed FROM identity_members WHERE account=?').get(account.id) as {member: string; confirmed: number} | undefined;
  if (!mapping) return;
  const config = configuration(school);
  await serialized(config.endpoint, async () => {
    const state = await currentState(config);
    const revoked = hasMembership(state.revoked_memberships, mapping.member, config.club);
    const active = hasMembership(state.memberships, mapping.member, config.club);
    if (revoked || (mapping.confirmed === 1 && !active)) {
      db.db.prepare('DELETE FROM tokens WHERE account=?').run(account.id);
      throw new Rejected('Federation membership revoked', 403, 'Membership Revoked');
    }
  });
}
export async function identityProposal(db: Store, account: Account, holder: string, school: School, profile: boolean, gameProfile: string): Promise<unknown> {
  const config = configuration(school);
  // Email verification has no age cutoff; explicit revocation still blocks authorization.
  requireThat(account.verified_at > 0, 'Account identity has not been verified');
  return serialized(config.endpoint, async () => {
    const state = await currentState(config);
    const devices = record(state.devices);
    const revoked = state.revoked_devices as string[];
    requireThat(Array.isArray(revoked) && !revoked.includes(holder), 'Device revoked');
    const member = accountMember(db, account, typeof devices[holder] === 'string' ? devices[holder] : undefined);
    const action = profile
      ? { type: 'bind_game_profile', member, club: config.club, profile: gameProfile }
      : { type: 'confirm_member', member, club: config.club, device: holder, evidence: 'institutional_email', verifier: config.verifier };
    return run(config, 'draft', action);
  });
}
export async function confirmIdentity(db: Store, account: Account, school: School, proposed: unknown, gameProfile: string): Promise<unknown> {
  const config = configuration(school);
  requireThat(account.verified_at > 0, 'Account identity has not been verified');
  const proposal = record(proposed), action = record(proposal.action);
  const mapping = db.db.prepare('SELECT member FROM identity_members WHERE account=?').get(account.id) as {member: string} | undefined;
  requireThat(mapping && action.member === mapping.member && action.club === config.club, 'Account identity scope mismatch');
  requireThat(
    (action.type === 'confirm_member' && action.evidence === 'institutional_email' && action.verifier === config.verifier && typeof action.device === 'string') ||
    (action.type === 'bind_game_profile' && action.profile === gameProfile), 'Unsupported identity attestation');
  requireThat(Array.isArray(proposal.signatures) && proposal.signatures.length > 0, 'Device possession signature required');
  return serialized(config.endpoint, async () => {
    const state = await currentState(config);
    const checkpoint = record(state.checkpoint);
    requireThat(proposal.genesis === checkpoint.genesis && proposal.previous === checkpoint.head && proposal.sequence === Number(checkpoint.sequence) + 1, 'Identity proposal is stale; create a new proposal');
    requireThat(!hasMembership(state.revoked_memberships, mapping.member, config.club), 'Federation membership revoked');
    if (action.type === 'confirm_member') {
      requireThat(Array.isArray(state.revoked_devices) && !state.revoked_devices.includes(action.device), 'Device revoked');
    } else {
      requireThat(hasMembership(state.memberships, mapping.member, config.club), 'Federation membership required');
    }
    // Submit verifies signatures and the exact log head atomically, including later revocations.
    const committed = await run(config, 'confirm', proposal);
    db.db.prepare('UPDATE identity_members SET confirmed=1 WHERE account=? AND member=?').run(account.id, field(action.member));
    return {member: mapping.member, checkpoint: committed};
  });
}
