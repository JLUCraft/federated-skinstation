// The Rust client is the schema/signature/replay authority; this adapter only attests verified accounts.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Rejected, requireThat, type Account, type Store } from './store.js';
import { record, field } from './validate.js';
import type { School } from './school.js';
const exec = promisify(execFile);
const MAX_OUTPUT = 8 * 1024 * 1024;
export interface UnifiedVerification {
  unionctl: string; genesis: string; genesisHash: string; log: string;
  address: string; peer: string; verifier: string; club: string;
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
function cache(config: UnifiedVerification): string[] {
  return ['--genesis', config.genesis, '--genesis-hash', config.genesisHash, '--log', config.log];
}
function target(config: UnifiedVerification, school: School): string[] {
  return ['--key', school.issuerKey, '--address', config.address, '--peer', config.peer];
}
async function invoke(config: UnifiedVerification, args: string[]): Promise<string> {
  try {
    return (await exec(config.unionctl, ['trust', ...args], {timeout: 30_000, maxBuffer: MAX_OUTPUT})).stdout;
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
    if (stderr.trimEnd().endsWith('Error: access denied')) throw new Rejected('Identity action is not authorized');
    throw new Rejected('Identity authority is temporarily unavailable; synchronize and retry', 503, 'Service Unavailable');
  }
}
async function run(config: UnifiedVerification, args: string[]): Promise<unknown> {
  return JSON.parse(await invoke(config, args));
}
function accountMember(db: Store, account: Account, verifiedMember?: string): string {
  const existing = db.db.prepare('SELECT member FROM identity_members WHERE account=?').get(account.id) as {member: string} | undefined;
  if (existing) { requireThat(!verifiedMember || existing.member === verifiedMember, 'Device belongs to another member'); return existing.member; }
  const member = verifiedMember ?? randomUUID();
  db.db.prepare('INSERT INTO identity_members(account,member,confirmed) VALUES(?,?,0)').run(account.id, member);
  return member;
}
async function currentState(config: UnifiedVerification, school: School): Promise<Record<string, unknown>> {
  await run(config, ['sync', ...cache(config), ...target(config, school)]);
  return record(await run(config, ['inspect', ...cache(config)]));
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
  await serialized(config.log, async () => {
    const state = await currentState(config, school);
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
  return serialized(config.log, async () => {
    const state = await currentState(config, school);
    const devices = record(state.devices);
    const revoked = state.revoked_devices as string[];
    requireThat(Array.isArray(revoked) && !revoked.includes(holder), 'Device revoked');
    const member = accountMember(db, account, typeof devices[holder] === 'string' ? devices[holder] : undefined);
    const action = profile
      ? { type: 'bind_game_profile', member, club: config.club, profile: gameProfile }
      : { type: 'confirm_member', member, club: config.club, device: holder, evidence: 'institutional_email', verifier: config.verifier };
    const directory = await mkdtemp(join(dirname(config.log), 'identity-proposal-'));
    try {
      const input = join(directory, 'action.json'), output = join(directory, 'record.json');
      await writeFile(input, JSON.stringify(action), { mode: 0o600 });
      await invoke(config, ['draft', ...cache(config), '--action', input, '--out', output]);
      return JSON.parse(await readFile(output, 'utf8'));
    } finally { await rm(directory, {recursive: true, force: true}); }
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
  return serialized(config.log, async () => {
    const state = await currentState(config, school);
    const checkpoint = record(state.checkpoint);
    requireThat(proposal.genesis === checkpoint.genesis && proposal.previous === checkpoint.head && proposal.sequence === Number(checkpoint.sequence) + 1, 'Identity proposal is stale; create a new proposal');
    requireThat(!hasMembership(state.revoked_memberships, mapping.member, config.club), 'Federation membership revoked');
    if (action.type === 'confirm_member') {
      requireThat(Array.isArray(state.revoked_devices) && !state.revoked_devices.includes(action.device), 'Device revoked');
    } else {
      requireThat(hasMembership(state.memberships, mapping.member, config.club), 'Federation membership required');
    }
    // Submit verifies signatures and the exact log head atomically, including later revocations.
    const directory = await mkdtemp(join(dirname(config.log), 'identity-confirm-'));
    try {
      const input = join(directory, 'proposal.json'), signed = join(directory, 'signed.json');
      await writeFile(input, JSON.stringify(proposal), {mode: 0o600});
      await invoke(config, ['sign', '--key', school.issuerKey, '--record', input, '--out', signed]);
      const checkpoint = await run(config, ['submit', ...cache(config), ...target(config, school), '--record', signed]);
      db.db.prepare('UPDATE identity_members SET confirmed=1 WHERE account=? AND member=?').run(account.id, field(action.member));
      return {member: mapping.member, checkpoint};
    } finally { await rm(directory, {recursive: true, force: true}); }
  });
}
