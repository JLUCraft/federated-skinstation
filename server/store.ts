import { MAX_PROFILES, type GameProfile } from '../shared/profiles.js';
import { DatabaseSync } from 'node:sqlite';
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('hex');
export class Rejected extends Error {
  constructor(
    message = 'Request rejected',
    readonly statusCode = 403,
    readonly code = 'ForbiddenOperationException',
  ) {
    super(message);
  }
}
/** Current Unix time in whole seconds; token and challenge expiry use this clock. */
export const now = () => Math.floor(Date.now() / 1000);
export function requireThat(
  value: unknown,
  message = 'Request rejected',
): asserts value {
  if (!value) throw new Rejected(message);
}
export interface Account {
  id: string;
  name: string;
  email: string;
  school: string;
  password: string;
  verified_at: number;
}
export async function encodePassword(password: string) {
  requireThat(
    password.length >= 12 && Buffer.byteLength(password) <= 1024,
    'Use a password of 12–1024 bytes',
  );
  const salt = randomBytes(16).toString('hex');
  const hash = (await derive(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string) {
  if (Buffer.byteLength(password) > 1024) return false;
  const [kind, salt, value] = encoded.split('$');
  if (kind !== 'scrypt' || !salt || !value) return false;
  const expected = Buffer.from(value, 'hex');
  const actual = (await derive(password, salt, 64)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    const version = (
      this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    ).user_version;
    const tables = (
      this.db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .get() as { n: number }
    ).n;
    if (
      (tables > 0 && version !== 1) ||
      (tables === 0 && version !== 0 && version !== 1)
    ) {
      this.db.close();
      throw new Error('Unsupported database schema; only schema 1 is accepted');
    }
    if (tables > 0) {
      const expected: Record<string, string[]> = {
        accounts: ['id', 'name', 'email', 'school', 'password', 'verified_at'],
        joins: ['server', 'profile', 'token', 'expires', 'ip'],
        profile_textures: ['account', 'kind', 'hash', 'model'],
      };
      for (const [table, columns] of Object.entries(expected))
        if (
          JSON.stringify(
            (
              this.db.prepare(`PRAGMA table_info(${table})`).all() as {
                name: string;
              }[]
            ).map((c) => c.name),
          ) !== JSON.stringify(columns)
        ) {
          this.db.close();
          throw new Error('Unsupported database schema layout');
        }
    }
    this.db
      .exec(`PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,name TEXT UNIQUE COLLATE NOCASE NOT NULL,email TEXT UNIQUE COLLATE NOCASE NOT NULL,school TEXT NOT NULL,password TEXT NOT NULL,verified_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges(email TEXT PRIMARY KEY,token TEXT NOT NULL,expires INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY,client TEXT NOT NULL,account TEXT NOT NULL REFERENCES accounts(id),expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS joins(server TEXT NOT NULL,profile TEXT NOT NULL,token TEXT NOT NULL REFERENCES tokens(hash) ON DELETE CASCADE,expires INTEGER NOT NULL,ip TEXT,PRIMARY KEY(server,profile));
      CREATE TABLE IF NOT EXISTS mua_sync(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,synced INTEGER NOT NULL,attempts INTEGER NOT NULL,next INTEGER NOT NULL);
      INSERT OR IGNORE INTO mua_sync VALUES(1,0,0,0,0);
      CREATE TABLE IF NOT EXISTS profile_mappings(account TEXT PRIMARY KEY REFERENCES accounts(id),uuid TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS profile_remaps(old TEXT PRIMARY KEY,next TEXT NOT NULL,account TEXT NOT NULL REFERENCES accounts(id));
      CREATE TABLE IF NOT EXISTS password_resets(account TEXT PRIMARY KEY REFERENCES accounts(id),token TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(key TEXT PRIMARY KEY,window INTEGER NOT NULL,count INTEGER NOT NULL);`);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS identity_members(account TEXT PRIMARY KEY REFERENCES accounts(id),member TEXT NOT NULL,confirmed INTEGER NOT NULL DEFAULT 0)',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS profile_textures(account TEXT NOT NULL REFERENCES accounts(id),kind TEXT NOT NULL,hash TEXT NOT NULL,model TEXT NOT NULL,PRIMARY KEY(account,kind))',
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS extra_profiles(id TEXT PRIMARY KEY,account TEXT NOT NULL REFERENCES accounts(id),name TEXT UNIQUE COLLATE NOCASE NOT NULL);
      CREATE TABLE IF NOT EXISTS extra_profile_textures(profile TEXT NOT NULL REFERENCES extra_profiles(id) ON DELETE CASCADE,kind TEXT NOT NULL,hash TEXT NOT NULL,model TEXT NOT NULL,PRIMARY KEY(profile,kind));
      CREATE TABLE IF NOT EXISTS token_profiles(token TEXT PRIMARY KEY REFERENCES tokens(hash) ON DELETE CASCADE,profile TEXT);`);
    this.db.exec('PRAGMA user_version=1');
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  account(field: 'id' | 'email' | 'name', value: string): Account | undefined {
    const query = {
      id: 'SELECT * FROM accounts WHERE id=?',
      email: 'SELECT * FROM accounts WHERE email=?',
      name: 'SELECT * FROM accounts WHERE name=?',
    }[field];
    return this.db.prepare(query).get(value) as Account | undefined;
  }
  rate(key: string, now: number, max: number, window: number) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM attempts WHERE window<?').run(now - 3600);
      const old = this.db
        .prepare('SELECT window,count FROM attempts WHERE key=?')
        .get(key) as { window: number; count: number } | undefined;
      const count = old && now - old.window < window ? old.count : 0;
      requireThat(count < max, 'Too many attempts');
      this.db
        .prepare('INSERT OR REPLACE INTO attempts VALUES(?,?,?)')
        .run(key, count === 0 ? now : old!.window, count + 1);
    });
  }
  challenge(account: Account, now: number) {
    this.rate(`email:${digest(account.email)}`, now, 3, 3600);
    this.db.prepare('DELETE FROM challenges WHERE expires<=?').run(now);
    const code = secret();
    this.db
      .prepare('INSERT OR REPLACE INTO challenges VALUES(?,?,?,?)')
      .run(account.email, digest(code), now + 900, JSON.stringify(account));
    return code;
  }
  confirm(email: string, code: string, now: number) {
    this.rate(`confirm:${digest(email)}`, now, 10, 900);
    this.transaction(() => {
      const row = this.db
        .prepare(
          'SELECT payload FROM challenges WHERE email=? AND token=? AND expires>?',
        )
        .get(email, digest(code), now) as { payload: string } | undefined;
      requireThat(row, 'Invalid or expired verification');
      const a = JSON.parse(row.payload) as Account;
      const collision = this.profileNamed(a.name);
      if (collision && collision.account.email !== a.email)
        throw new Rejected('Profile name already in use', 409, 'Name Conflict');
      this.db
        .prepare(
          'INSERT INTO accounts VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET verified_at=excluded.verified_at',
        )
        .run(a.id, a.name, a.email, a.school, a.password, now);
      this.db.prepare('DELETE FROM challenges WHERE email=?').run(email);
      this.db
        .prepare(
          'UPDATE mua_sync SET revision=revision+1,attempts=0,next=0 WHERE id=1',
        )
        .run();
    });
  }
  profileId(account: Account): string {
    return (
      (
        this.db
          .prepare('SELECT uuid FROM profile_mappings WHERE account=?')
          .get(account.id) as { uuid: string } | undefined
      )?.uuid ?? account.id
    );
  }
  profile(uuid: string): Account | undefined {
    const mapped = this.db
      .prepare('SELECT account FROM profile_mappings WHERE uuid=?')
      .get(uuid) as { account: string } | undefined;
    if (mapped) return this.account('id', mapped.account);
    const extra = this.db
      .prepare('SELECT account FROM extra_profiles WHERE id=?')
      .get(uuid) as { account: string } | undefined;
    if (extra) return this.account('id', extra.account);
    const account = this.account('id', uuid);
    return account && this.profileId(account) === uuid ? account : undefined;
  }
  profiles(account: Account): GameProfile[] {
    const extra = this.db
      .prepare(
        'SELECT id,name FROM extra_profiles WHERE account=? ORDER BY rowid',
      )
      .all(account.id) as { id: string; name: string }[];
    return [
      { id: this.profileId(account), name: account.name, primary: true },
      ...extra.map((p) => ({ ...p, primary: false })),
    ];
  }
  profileNamed(
    name: string,
  ): { account: Account; profile: GameProfile } | undefined {
    const primary = this.account('name', name);
    if (primary)
      return {
        account: primary,
        profile: {
          id: this.profileId(primary),
          name: primary.name,
          primary: true,
        },
      };
    const extra = this.db
      .prepare('SELECT * FROM extra_profiles WHERE name=?')
      .get(name) as { id: string; name: string; account: string } | undefined;
    const account = extra && this.account('id', extra.account);
    return extra && account
      ? { account, profile: { id: extra.id, name: extra.name, primary: false } }
      : undefined;
  }
  ownProfile(account: Account, id: string): GameProfile {
    const profile = this.profiles(account).find((p) => p.id === id);
    requireThat(profile, 'Profile not owned');
    return profile;
  }
  createProfile(account: Account, name: string) {
    requireThat(/^[a-zA-Z0-9_]{1,16}$/.test(name), 'Invalid profile name');
    return this.transaction(() => {
      requireThat(
        this.profiles(account).length < MAX_PROFILES,
        'Profile limit reached',
      );
      requireThat(!this.profileNamed(name), 'Profile name already in use');
      const id = accountId();
      this.db
        .prepare('INSERT INTO extra_profiles VALUES(?,?,?)')
        .run(id, account.id, name);
      this.db
        .prepare(
          'UPDATE mua_sync SET revision=revision+1,attempts=0,next=0 WHERE id=1',
        )
        .run();
      return { id, name, primary: false };
    });
  }
  renameProfile(account: Account, id: string, name: string) {
    requireThat(/^[a-zA-Z0-9_]{1,16}$/.test(name), 'Invalid profile name');
    this.transaction(() => {
      const profile = this.ownProfile(account, id);
      requireThat(
        !profile.primary,
        'Primary name is managed by account identity',
      );
      const collision = this.profileNamed(name);
      requireThat(
        !collision || collision.profile.id === id,
        'Profile name already in use',
      );
      this.db
        .prepare('UPDATE extra_profiles SET name=? WHERE id=?')
        .run(name, id);
      this.db
        .prepare(
          'DELETE FROM tokens WHERE hash IN (SELECT token FROM token_profiles WHERE profile=?)',
        )
        .run(id);
      this.db
        .prepare(
          'UPDATE mua_sync SET revision=revision+1,attempts=0,next=0 WHERE id=1',
        )
        .run();
    });
  }
  deleteProfile(account: Account, id: string) {
    this.transaction(() => {
      requireThat(
        !this.ownProfile(account, id).primary,
        'Primary profile cannot be deleted',
      );
      this.db
        .prepare(
          'DELETE FROM tokens WHERE hash IN (SELECT token FROM token_profiles WHERE profile=?)',
        )
        .run(id);
      this.db.prepare('DELETE FROM extra_profiles WHERE id=?').run(id);
      this.db
        .prepare(
          'UPDATE mua_sync SET revision=revision+1,attempts=0,next=0 WHERE id=1',
        )
        .run();
    });
  }
  textures(account: Account, id = this.profileId(account)) {
    const p = this.ownProfile(account, id);
    return this.db
      .prepare(
        p.primary
          ? 'SELECT kind,hash,model FROM profile_textures WHERE account=?'
          : 'SELECT kind,hash,model FROM extra_profile_textures WHERE profile=?',
      )
      .all(p.primary ? account.id : id) as {
      kind: string;
      hash: string;
      model: string;
    }[];
  }
  setTexture(
    account: Account,
    id: string,
    kind: string,
    hash: string,
    model: string,
  ) {
    const p = this.ownProfile(account, id);
    this.db
      .prepare(
        p.primary
          ? 'INSERT OR REPLACE INTO profile_textures VALUES(?,?,?,?)'
          : 'INSERT OR REPLACE INTO extra_profile_textures VALUES(?,?,?,?)',
      )
      .run(p.primary ? account.id : id, kind, hash, model);
  }
  removeTexture(account: Account, id: string, kind: string) {
    const p = this.ownProfile(account, id);
    this.db
      .prepare(
        p.primary
          ? 'DELETE FROM profile_textures WHERE account=? AND kind=?'
          : 'DELETE FROM extra_profile_textures WHERE profile=? AND kind=?',
      )
      .run(p.primary ? account.id : id, kind);
  }
  selectedProfile(token: string, account: Account): string | undefined {
    const selected = this.db
      .prepare('SELECT profile FROM token_profiles WHERE token=?')
      .get(digest(token)) as { profile: string | null } | undefined;
    return selected ? (selected.profile ?? undefined) : this.profileId(account);
  }
  remapProfiles(mapping: Record<string, string>) {
    this.transaction(() => {
      const updates = Object.entries(mapping).map(([old, next]) => {
        requireThat(/^[a-f0-9]{32}$/.test(old) && /^[a-f0-9]{32}$/.test(next));
        const receipt = this.db
          .prepare('SELECT next,account FROM profile_remaps WHERE old=?')
          .get(old) as { next: string; account: string } | undefined;
        if (receipt?.next === next) {
          const previous = this.account('id', receipt.account);
          if (previous && this.profiles(previous).some((p) => p.id === next))
            return { account: previous, next, old, applied: true };
        }
        const account = this.profile(old);
        requireThat(account, 'Unknown profile');
        const collision = this.profile(next);
        requireThat(!collision || old === next, 'Profile collision');
        return { account, next, old, applied: false };
      });
      requireThat(new Set(updates.map((u) => u.next)).size === updates.length);
      for (const { account, next, old, applied } of updates) {
        if (applied || old === next) continue;
        this.db
          .prepare('INSERT OR REPLACE INTO profile_remaps VALUES(?,?,?)')
          .run(old, next, account.id);
        const profile = this.ownProfile(account, old);
        if (profile.primary)
          this.db
            .prepare(
              'INSERT INTO profile_mappings VALUES(?,?) ON CONFLICT(account) DO UPDATE SET uuid=excluded.uuid',
            )
            .run(account.id, next);
        else {
          const textures = this.textures(account, old);
          this.db.prepare('DELETE FROM extra_profiles WHERE id=?').run(old);
          this.db
            .prepare('INSERT INTO extra_profiles VALUES(?,?,?)')
            .run(next, account.id, profile.name);
          for (const texture of textures)
            this.setTexture(
              account,
              next,
              texture.kind,
              texture.hash,
              texture.model,
            );
        }
        this.db.prepare('DELETE FROM tokens WHERE account=?').run(account.id);
      }
    });
  }
  passwordReset(email: string, now: number) {
    this.rate(`reset:${digest(email)}`, now, 3, 3600);
    this.db.prepare('DELETE FROM password_resets WHERE expires<=?').run(now);
    const account = this.account('email', email);
    if (!account) return undefined;
    const code = secret();
    this.db
      .prepare('INSERT OR REPLACE INTO password_resets VALUES(?,?,?)')
      .run(account.id, digest(code), now + 900);
    return code;
  }
  resetPassword(
    email: string,
    code: string,
    passwordHash: string,
    now: number,
  ) {
    this.rate(`reset-confirm:${digest(email)}`, now, 10, 900);
    this.transaction(() => {
      const account = this.account('email', email);
      requireThat(account);
      const row = this.db
        .prepare(
          'SELECT 1 FROM password_resets WHERE account=? AND token=? AND expires>?',
        )
        .get(account.id, digest(code), now);
      requireThat(row, 'Invalid or expired verification');
      this.db
        .prepare('UPDATE accounts SET password=? WHERE id=?')
        .run(passwordHash, account.id);
      this.db
        .prepare('DELETE FROM password_resets WHERE account=?')
        .run(account.id);
      this.db.prepare('DELETE FROM tokens WHERE account=?').run(account.id);
      this.db.prepare('DELETE FROM challenges WHERE email=?').run(email);
    });
  }
  mint(account: string, client: string, now: number, selectProfile = true) {
    requireThat(client.length <= 256);
    const token = secret();
    this.db.prepare('DELETE FROM tokens WHERE expires<=?').run(now);
    this.db
      .prepare(
        'DELETE FROM tokens WHERE hash IN (SELECT hash FROM tokens WHERE account=? ORDER BY expires DESC LIMIT -1 OFFSET 9)',
      )
      .run(account);
    this.db
      .prepare('INSERT INTO tokens VALUES(?,?,?,?)')
      .run(digest(token), client, account, now + 86400);
    if (!selectProfile)
      this.db
        .prepare('INSERT INTO token_profiles VALUES(?,NULL)')
        .run(digest(token));
    return token;
  }
  token(token: string, client: string | undefined, now: number) {
    const row = this.db
      .prepare('SELECT account,client FROM tokens WHERE hash=? AND expires>?')
      .get(digest(token), now) as
      { account: string; client: string } | undefined;
    requireThat(
      row && (client === undefined || row.client === client),
      'Invalid token',
    );
    const account = this.account('id', row.account);
    requireThat(account);
    return account;
  }
  refresh(
    token: string,
    client: string | undefined,
    profile: string | undefined,
    now: number,
  ) {
    return this.transaction(() => {
      const a = this.token(token, client, now);
      const selected = this.selectedProfile(token, a);
      if (profile !== undefined && selected !== undefined)
        throw new Rejected(
          'Access token already has a profile assigned.',
          400,
          'IllegalArgumentException',
        );
      const stored = this.db
        .prepare('SELECT client FROM tokens WHERE hash=?')
        .get(digest(token)) as { client: string };
      if (profile !== undefined) this.ownProfile(a, profile);
      const next = this.mint(a.id, stored.client, now);
      this.db
        .prepare('INSERT INTO token_profiles VALUES(?,?)')
        .run(digest(next), profile ?? selected ?? null);
      this.invalidate(token);
      return { account: a, token: next, client: stored.client };
    });
  }
  invalidate(token: string) {
    this.db.prepare('DELETE FROM tokens WHERE hash=?').run(digest(token));
  }
  join(
    token: string,
    profile: string,
    server: string,
    now: number,
    ip?: string,
  ) {
    requireThat(server.length > 0 && server.length <= 64);
    const account = this.token(token, undefined, now);
    this.ownProfile(account, profile);
    requireThat(
      this.selectedProfile(token, account) === profile,
      'Token profile mismatch',
    );
    this.db.prepare('DELETE FROM joins WHERE expires<=?').run(now);
    this.db
      .prepare(
        'INSERT OR REPLACE INTO joins(server,profile,token,expires,ip) VALUES(?,?,?,?,?)',
      )
      .run(server, profile, digest(token), now + 30, ip ?? null);
  }
  joined(name: string, server: string, now: number, ip?: string) {
    const foundProfile = this.profileNamed(name);
    if (!foundProfile) return undefined;
    const a = foundProfile.account;
    const found = this.db
      .prepare(
        'SELECT 1 FROM joins j JOIN tokens t ON t.hash=j.token WHERE j.server=? AND j.profile=? AND j.expires>? AND t.expires>? AND (? IS NULL OR j.ip=?)',
      )
      .get(server, foundProfile.profile.id, now, now, ip ?? null, ip ?? null);
    return found ? a : undefined;
  }
}
export const accountId = () => randomUUID().replaceAll('-', '');
