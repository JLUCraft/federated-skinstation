import { MAX_PROFILES, type GameProfile } from '../shared/profiles.js';
import { PASSWORD_RULES } from '../shared/identity.js';
import type { Texture } from '../shared/wardrobe.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
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
export function requireThat(value: unknown, message = 'Request rejected'): asserts value {
  if (!value) throw new Rejected(message);
}
export interface Account {
  id: string;
  name: string;
  email: string;
  school: string;
  password: string;
  verified_at: number;
  disabled?: number;
  credential_revision?: number;
}
export async function encodePassword(password: string) {
  requireThat(
    password.length >= PASSWORD_RULES.minLength &&
      Buffer.byteLength(password) <= PASSWORD_RULES.maxLength,
    `Use a password of ${PASSWORD_RULES.minLength}–${PASSWORD_RULES.maxLength} bytes`,
  );
  const salt = randomBytes(16).toString('hex');
  const hash = (await derive(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string) {
  if (Buffer.byteLength(password) > PASSWORD_RULES.maxLength) return false;
  const [kind, salt, value] = encoded.split('$');
  if (kind !== 'scrypt' || !salt || !value) return false;
  const expected = Buffer.from(value, 'hex');
  const actual = (await derive(password, salt, 64)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export const migrations: readonly { version: number; apply: (db: DatabaseSync) => void }[] = [
  {
    version: 1,
    apply(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,name TEXT UNIQUE COLLATE NOCASE NOT NULL,email TEXT UNIQUE COLLATE NOCASE NOT NULL,school TEXT NOT NULL,password TEXT NOT NULL,verified_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges(email TEXT PRIMARY KEY,token TEXT NOT NULL,expires INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY,client TEXT NOT NULL,account TEXT NOT NULL REFERENCES accounts(id),expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS joins(server TEXT NOT NULL,profile TEXT NOT NULL,token TEXT NOT NULL REFERENCES tokens(hash) ON DELETE CASCADE,expires INTEGER NOT NULL,ip TEXT,PRIMARY KEY(server,profile));
      CREATE TABLE IF NOT EXISTS mua_sync(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,synced INTEGER NOT NULL,attempts INTEGER NOT NULL,next INTEGER NOT NULL);
      INSERT OR IGNORE INTO mua_sync VALUES(1,0,0,0,0);
      CREATE TABLE IF NOT EXISTS profile_mappings(account TEXT PRIMARY KEY REFERENCES accounts(id),uuid TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS profile_remaps(old TEXT PRIMARY KEY,next TEXT NOT NULL,account TEXT NOT NULL REFERENCES accounts(id));
      CREATE TABLE IF NOT EXISTS password_resets(account TEXT PRIMARY KEY REFERENCES accounts(id),token TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(key TEXT PRIMARY KEY,window INTEGER NOT NULL,count INTEGER NOT NULL);`);
      db.exec(
        'CREATE TABLE IF NOT EXISTS identity_members(account TEXT PRIMARY KEY REFERENCES accounts(id),member TEXT NOT NULL,confirmed INTEGER NOT NULL DEFAULT 0)',
      );
      db.exec(
        'CREATE TABLE IF NOT EXISTS profile_textures(account TEXT NOT NULL REFERENCES accounts(id),kind TEXT NOT NULL,hash TEXT NOT NULL,model TEXT NOT NULL,PRIMARY KEY(account,kind))',
      );
      db.exec(`CREATE TABLE IF NOT EXISTS extra_profiles(id TEXT PRIMARY KEY,account TEXT NOT NULL REFERENCES accounts(id),name TEXT UNIQUE COLLATE NOCASE NOT NULL);
      CREATE TABLE IF NOT EXISTS extra_profile_textures(profile TEXT NOT NULL REFERENCES extra_profiles(id) ON DELETE CASCADE,kind TEXT NOT NULL,hash TEXT NOT NULL,model TEXT NOT NULL,PRIMARY KEY(profile,kind));
      CREATE TABLE IF NOT EXISTS token_profiles(token TEXT PRIMARY KEY REFERENCES tokens(hash) ON DELETE CASCADE,profile TEXT);`);
    },
  },
  {
    version: 2,
    apply(db) {
      db.exec(`
      ALTER TABLE accounts ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1));
      ALTER TABLE identity_members ADD COLUMN legacy_member TEXT GENERATED ALWAYS AS (member) VIRTUAL;
      CREATE TABLE clubs(id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL,school TEXT NOT NULL);
      CREATE INDEX clubs_school ON clubs(school);
      CREATE TABLE memberships(account TEXT NOT NULL REFERENCES accounts(id),club TEXT NOT NULL REFERENCES clubs(id),status TEXT NOT NULL CHECK(status IN ('active','revoked')),source TEXT NOT NULL CHECK(source IN ('email_domain','chair','import')),roles TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(roles) AND json_type(roles)='array'),since INTEGER NOT NULL,revoked_at INTEGER,PRIMARY KEY(account,club),CHECK((status='active' AND revoked_at IS NULL) OR (status='revoked' AND revoked_at IS NOT NULL)));
      CREATE INDEX memberships_club_status ON memberships(club,status);
      CREATE TRIGGER memberships_permanent BEFORE UPDATE ON memberships WHEN OLD.status='revoked' BEGIN SELECT RAISE(ABORT,'Membership revocation is permanent'); END;
      CREATE TRIGGER memberships_no_replace BEFORE INSERT ON memberships WHEN EXISTS(SELECT 1 FROM memberships WHERE account=NEW.account AND club=NEW.club) BEGIN SELECT RAISE(ABORT,'Existing memberships cannot be replaced'); END;
      CREATE TRIGGER memberships_no_delete BEFORE DELETE ON memberships BEGIN SELECT RAISE(ABORT,'Revoke memberships instead of deleting them'); END;
      CREATE TABLE chairs(club TEXT PRIMARY KEY REFERENCES clubs(id),account TEXT NOT NULL REFERENCES accounts(id),epoch INTEGER NOT NULL CHECK(epoch>=1),updated_at INTEGER NOT NULL,FOREIGN KEY(account,club) REFERENCES memberships(account,club));
      CREATE TABLE successions(id TEXT PRIMARY KEY,club TEXT NOT NULL REFERENCES clubs(id),proposed_by TEXT NOT NULL REFERENCES accounts(id),nominee TEXT NOT NULL REFERENCES accounts(id),status TEXT NOT NULL CHECK(status IN ('open','accepted','rejected')),epoch INTEGER NOT NULL CHECK(epoch>=1),created_at INTEGER NOT NULL,closed_at INTEGER);
      CREATE INDEX successions_club_status ON successions(club,status);
      CREATE TABLE succession_votes(id TEXT PRIMARY KEY,succession TEXT NOT NULL REFERENCES successions(id),account TEXT NOT NULL REFERENCES accounts(id),kind TEXT NOT NULL CHECK(kind IN ('approve','reject')),UNIQUE(succession,account));
      CREATE TABLE services(id TEXT PRIMARY KEY,club TEXT NOT NULL REFERENCES clubs(id),client_id TEXT UNIQUE NOT NULL,public_key TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES accounts(id),created_at INTEGER NOT NULL);
      CREATE INDEX services_club ON services(club);
      CREATE TABLE grants(id TEXT PRIMARY KEY,principal_kind TEXT NOT NULL CHECK(principal_kind IN ('user','service')),principal TEXT NOT NULL,scope TEXT NOT NULL,permission TEXT NOT NULL,granted_by TEXT NOT NULL,granted_at INTEGER NOT NULL,revoked_at INTEGER,revoked_by TEXT);
      CREATE INDEX grants_principal_scope ON grants(principal_kind,principal,scope) WHERE revoked_at IS NULL;
      CREATE TABLE audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,actor_kind TEXT NOT NULL,actor TEXT NOT NULL,scope TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,payload_digest TEXT NOT NULL,prev_hash TEXT NOT NULL,hash TEXT UNIQUE NOT NULL);
      CREATE TRIGGER audit_append BEFORE INSERT ON audit WHEN NEW.seq != (SELECT COALESCE(MAX(seq),0)+1 FROM audit) OR NEW.prev_hash != COALESCE((SELECT hash FROM audit ORDER BY seq DESC LIMIT 1),'') OR EXISTS(SELECT 1 FROM audit WHERE hash=NEW.hash) BEGIN SELECT RAISE(ABORT,'Audit must extend the current head'); END;
      CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;
      CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;
      CREATE TABLE identity_seeds(name TEXT PRIMARY KEY);
    `);
    },
  },
  {
    version: 3,
    apply(db) {
      db.exec(`
      INSERT OR IGNORE INTO identity_seeds SELECT 'site_admins'
        WHERE EXISTS(SELECT 1 FROM grants WHERE principal_kind='user' AND granted_by='config' AND scope='global' AND permission='admin');
      INSERT OR IGNORE INTO identity_seeds SELECT 'mua_admins'
        WHERE EXISTS(SELECT 1 FROM grants WHERE principal_kind='user' AND granted_by='config' AND scope='service:mua' AND permission='admin');
      DELETE FROM identity_seeds WHERE name='admins';
    `);
    },
  },
  {
    version: 4,
    apply(db) {
      db.exec(`
      ALTER TABLE accounts ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE account_recoveries(
        id TEXT PRIMARY KEY, account TEXT UNIQUE NOT NULL REFERENCES accounts(id),
        club TEXT NOT NULL REFERENCES clubs(id), requested_by TEXT NOT NULL REFERENCES accounts(id),
        email TEXT NOT NULL COLLATE NOCASE, token TEXT NOT NULL, expires INTEGER NOT NULL
      );
    `);
    },
  },
  {
    version: 5,
    apply(db) {
      db.exec(`
      CREATE TABLE game_resources(id TEXT PRIMARY KEY,club TEXT NOT NULL REFERENCES clubs(id),definition TEXT NOT NULL CHECK(json_valid(definition)));
      CREATE TABLE leagues(id TEXT PRIMARY KEY,club TEXT NOT NULL REFERENCES clubs(id),resource TEXT NOT NULL REFERENCES game_resources(id),state TEXT NOT NULL CHECK(json_valid(state)));
      CREATE INDEX leagues_resource ON leagues(resource);
      CREATE TABLE seasons(id TEXT PRIMARY KEY,club TEXT NOT NULL REFERENCES clubs(id),title TEXT NOT NULL);
      CREATE TABLE season_leagues(season TEXT NOT NULL REFERENCES seasons(id),league TEXT PRIMARY KEY REFERENCES leagues(id));
      CREATE TABLE league_scores(league TEXT NOT NULL REFERENCES leagues(id),event TEXT NOT NULL,payload TEXT NOT NULL,received_at INTEGER NOT NULL,PRIMARY KEY(league,event));
      CREATE TABLE league_disputes(id TEXT PRIMARY KEY,league TEXT NOT NULL REFERENCES leagues(id),account TEXT NOT NULL REFERENCES accounts(id),reason TEXT NOT NULL,created_at INTEGER NOT NULL,resolution TEXT,reviewer TEXT REFERENCES accounts(id),resolved_at INTEGER);
      CREATE UNIQUE INDEX league_disputes_open ON league_disputes(league,account) WHERE resolution IS NULL;
    `);
    },
  },
  {
    version: 6,
    apply(db) {
      db.exec(`
      CREATE TABLE office_artifacts(id TEXT PRIMARY KEY,club TEXT NOT NULL REFERENCES clubs(id),owner TEXT NOT NULL REFERENCES accounts(id),title TEXT NOT NULL,mime TEXT NOT NULL,content BLOB NOT NULL,parent TEXT REFERENCES office_artifacts(id),created_at INTEGER NOT NULL);
      CREATE TRIGGER office_artifacts_no_update BEFORE UPDATE ON office_artifacts BEGIN SELECT RAISE(ABORT,'Artifacts are immutable'); END;
      CREATE TABLE activities(id TEXT PRIMARY KEY,club TEXT NOT NULL REFERENCES clubs(id),state TEXT NOT NULL CHECK(json_valid(state)));
      CREATE TABLE event_artifacts(event TEXT NOT NULL REFERENCES activities(id),artifact TEXT NOT NULL REFERENCES office_artifacts(id),PRIMARY KEY(event,artifact));
      CREATE TABLE event_attendance(event TEXT NOT NULL REFERENCES activities(id),account TEXT NOT NULL REFERENCES accounts(id),club TEXT NOT NULL REFERENCES clubs(id),signed_up_at INTEGER NOT NULL,checked_in_at INTEGER,PRIMARY KEY(event,account));
      CREATE TABLE activity_tasks(id TEXT PRIMARY KEY,event TEXT NOT NULL REFERENCES activities(id),title TEXT NOT NULL,due_ms INTEGER,assignee TEXT REFERENCES accounts(id),done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)));
      CREATE TABLE activity_notices(id TEXT PRIMARY KEY,event TEXT NOT NULL REFERENCES activities(id),task TEXT UNIQUE NOT NULL REFERENCES activity_tasks(id),account TEXT NOT NULL REFERENCES accounts(id),due_ms INTEGER NOT NULL,acknowledged_at INTEGER);
      CREATE TABLE approval_templates(id TEXT PRIMARY KEY,club TEXT NOT NULL REFERENCES clubs(id),definition TEXT NOT NULL CHECK(json_valid(definition)));
      CREATE TABLE workflows(id TEXT PRIMARY KEY,club TEXT NOT NULL REFERENCES clubs(id),event TEXT NOT NULL REFERENCES activities(id),state TEXT NOT NULL CHECK(json_valid(state)));
      CREATE INDEX workflows_event ON workflows(event);
    `);
    },
  },
  {
    version: 7,
    apply(db) {
      db.exec(`
      CREATE TABLE point_policy(id INTEGER PRIMARY KEY CHECK(id=1),daily_member_cap TEXT NOT NULL);
      CREATE TABLE activity_sources(id TEXT PRIMARY KEY,config TEXT NOT NULL CHECK(json_valid(config)),last_window_end_ms INTEGER NOT NULL);
      CREATE TABLE activity_source_days(source TEXT NOT NULL REFERENCES activity_sources(id),day INTEGER NOT NULL,points TEXT NOT NULL,active_slices INTEGER NOT NULL,afk_slices INTEGER NOT NULL,PRIMARY KEY(source,day));
      CREATE TABLE activity_member_days(account TEXT NOT NULL REFERENCES accounts(id),day INTEGER NOT NULL,points TEXT NOT NULL,active_slices INTEGER NOT NULL,afk_slices INTEGER NOT NULL,PRIMARY KEY(account,day));
      CREATE TABLE activity_receipts(id TEXT PRIMARY KEY,source TEXT NOT NULL REFERENCES activity_sources(id),payload TEXT NOT NULL CHECK(json_valid(payload)),receipt TEXT NOT NULL CHECK(json_valid(receipt)));
      CREATE TABLE point_balances(account TEXT NOT NULL REFERENCES accounts(id),club TEXT NOT NULL REFERENCES clubs(id),available TEXT NOT NULL,PRIMARY KEY(account,club));
      CREATE TABLE point_ledger(seq INTEGER PRIMARY KEY AUTOINCREMENT,club TEXT NOT NULL REFERENCES clubs(id),account TEXT NOT NULL REFERENCES accounts(id),kind TEXT NOT NULL,reference TEXT NOT NULL,credit INTEGER NOT NULL CHECK(credit IN (0,1)),amount TEXT NOT NULL,balance TEXT NOT NULL,at INTEGER NOT NULL,UNIQUE(club,account,kind,reference));
      CREATE INDEX point_ledger_account ON point_ledger(account,seq);
      CREATE TRIGGER point_ledger_no_update BEFORE UPDATE ON point_ledger BEGIN SELECT RAISE(ABORT,'Point entries are immutable'); END;
      CREATE TRIGGER point_ledger_no_delete BEFORE DELETE ON point_ledger BEGIN SELECT RAISE(ABORT,'Point entries are immutable'); END;
      CREATE TABLE point_allowances(scope TEXT PRIMARY KEY,club TEXT NOT NULL REFERENCES clubs(id),account TEXT NOT NULL REFERENCES accounts(id),epoch INTEGER NOT NULL,remaining TEXT NOT NULL);
    `);
    },
  },
  {
    version: 8,
    apply(db) {
      db.exec(`
      ALTER TABLE office_artifacts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'club' CHECK(visibility IN ('club','private'));
      CREATE TABLE artifact_readers(artifact TEXT NOT NULL REFERENCES office_artifacts(id),account TEXT NOT NULL REFERENCES accounts(id),PRIMARY KEY(artifact,account));
      CREATE TABLE ai_pricing(model TEXT PRIMARY KEY,pricing TEXT NOT NULL CHECK(json_valid(pricing)));
      CREATE TABLE ai_jobs(id TEXT PRIMARY KEY,payer TEXT NOT NULL REFERENCES accounts(id),club TEXT NOT NULL REFERENCES clubs(id),scope TEXT,state TEXT NOT NULL CHECK(json_valid(state)));
      CREATE INDEX ai_jobs_payer ON ai_jobs(payer);
      CREATE TABLE point_escrows(job TEXT PRIMARY KEY REFERENCES ai_jobs(id),account TEXT NOT NULL REFERENCES accounts(id),club TEXT NOT NULL REFERENCES clubs(id),amount TEXT NOT NULL);
      CREATE INDEX point_escrows_account ON point_escrows(account,club);
      CREATE TABLE ai_totals(id INTEGER PRIMARY KEY CHECK(id=1),burned TEXT NOT NULL);
      INSERT INTO ai_totals VALUES(1,'0');
    `);
    },
  },
  {
    version: 9,
    apply(db) {
      db.exec(`
      CREATE TABLE event_plans(event TEXT PRIMARY KEY REFERENCES activities(id),state TEXT NOT NULL CHECK(json_valid(state)));
      CREATE TABLE club_planning_profiles(club TEXT PRIMARY KEY REFERENCES clubs(id),kind TEXT NOT NULL CHECK(kind IN ('official','independent')));
      CREATE TABLE event_reservations(event TEXT NOT NULL REFERENCES activities(id),resource TEXT NOT NULL REFERENCES game_resources(id),endpoint TEXT NOT NULL,opens_ms INTEGER NOT NULL,ends_ms INTEGER NOT NULL,PRIMARY KEY(event,resource));
      CREATE INDEX event_reservations_endpoint ON event_reservations(endpoint,ends_ms);
      CREATE TABLE planning_documents(artifact TEXT NOT NULL REFERENCES office_artifacts(id),event TEXT NOT NULL REFERENCES activities(id),plan TEXT NOT NULL,club TEXT NOT NULL REFERENCES clubs(id),audience TEXT NOT NULL CHECK(audience IN ('club','personal','event')),PRIMARY KEY(artifact,event,plan,club,audience));
    `);
    },
  },
  {
    version: 10,
    apply(db) {
      db.exec(`
      CREATE TABLE event_games(event TEXT NOT NULL REFERENCES activities(id),plan TEXT NOT NULL,resource TEXT NOT NULL REFERENCES game_resources(id),league TEXT UNIQUE NOT NULL REFERENCES leagues(id),PRIMARY KEY(event,resource));
      CREATE TABLE event_settlements(event TEXT PRIMARY KEY REFERENCES activities(id),plan TEXT NOT NULL,settled_at INTEGER NOT NULL);
      CREATE TABLE event_awards(event TEXT NOT NULL REFERENCES event_settlements(event),account TEXT NOT NULL REFERENCES accounts(id),club TEXT NOT NULL REFERENCES clubs(id),rank INTEGER NOT NULL CHECK(rank>=1),points TEXT NOT NULL,material TEXT,delivered_by TEXT REFERENCES accounts(id),received_at INTEGER,PRIMARY KEY(event,account));
    `);
    },
  },
];
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000');
      this.transaction(() => {
        const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
        for (const migration of migrations) {
          if (migration.version <= version) continue;
          migration.apply(this.db);
          this.db.exec(`PRAGMA user_version=${migration.version}`);
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
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
      const old = this.db.prepare('SELECT window,count FROM attempts WHERE key=?').get(key) as
        | { window: number; count: number }
        | undefined;
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
  confirm(email: string, code: string, now: number, onVerified?: (account: string) => void) {
    this.rate(`confirm:${digest(email)}`, now, 10, 900);
    this.transaction(() => {
      const row = this.db
        .prepare('SELECT payload FROM challenges WHERE email=? AND token=? AND expires>?')
        .get(email, digest(code), now) as { payload: string } | undefined;
      requireThat(row, 'Invalid or expired verification');
      const a = JSON.parse(row.payload) as Account;
      const collision = this.profileNamed(a.name);
      if (collision && collision.account.email !== a.email)
        throw new Rejected('Profile name already in use', 409, 'Name Conflict');
      this.db
        .prepare(
          'INSERT INTO accounts(id,name,email,school,password,verified_at) VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET verified_at=excluded.verified_at',
        )
        .run(a.id, a.name, a.email, a.school, a.password, now);
      this.db.prepare('DELETE FROM challenges WHERE email=?').run(email);
      onVerified?.(this.account('email', email)!.id);
      this.db.prepare('UPDATE mua_sync SET revision=revision+1,attempts=0,next=0 WHERE id=1').run();
    });
  }
  profileId(account: Account): string {
    return (
      (
        this.db.prepare('SELECT uuid FROM profile_mappings WHERE account=?').get(account.id) as
          | { uuid: string }
          | undefined
      )?.uuid ?? account.id
    );
  }
  profile(uuid: string): Account | undefined {
    const mapped = this.db
      .prepare('SELECT account FROM profile_mappings WHERE uuid=?')
      .get(uuid) as { account: string } | undefined;
    if (mapped) return this.account('id', mapped.account);
    const extra = this.db.prepare('SELECT account FROM extra_profiles WHERE id=?').get(uuid) as
      | { account: string }
      | undefined;
    if (extra) return this.account('id', extra.account);
    const account = this.account('id', uuid);
    return account && this.profileId(account) === uuid ? account : undefined;
  }
  profiles(account: Account): GameProfile[] {
    const extra = this.db
      .prepare('SELECT id,name FROM extra_profiles WHERE account=? ORDER BY rowid')
      .all(account.id) as { id: string; name: string }[];
    return [
      { id: this.profileId(account), name: account.name, primary: true },
      ...extra.map((p) => ({ ...p, primary: false })),
    ];
  }
  profileNamed(name: string): { account: Account; profile: GameProfile } | undefined {
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
    const extra = this.db.prepare('SELECT * FROM extra_profiles WHERE name=?').get(name) as
      | { id: string; name: string; account: string }
      | undefined;
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
      requireThat(this.profiles(account).length < MAX_PROFILES, 'Profile limit reached');
      requireThat(!this.profileNamed(name), 'Profile name already in use');
      const id = accountId();
      this.db.prepare('INSERT INTO extra_profiles VALUES(?,?,?)').run(id, account.id, name);
      this.db.prepare('UPDATE mua_sync SET revision=revision+1,attempts=0,next=0 WHERE id=1').run();
      return { id, name, primary: false };
    });
  }
  renameProfile(account: Account, id: string, name: string) {
    requireThat(/^[a-zA-Z0-9_]{1,16}$/.test(name), 'Invalid profile name');
    this.transaction(() => {
      const profile = this.ownProfile(account, id);
      requireThat(!profile.primary, 'Primary name is managed by account identity');
      const collision = this.profileNamed(name);
      requireThat(!collision || collision.profile.id === id, 'Profile name already in use');
      this.db.prepare('UPDATE extra_profiles SET name=? WHERE id=?').run(name, id);
      this.db
        .prepare(
          'DELETE FROM tokens WHERE hash IN (SELECT token FROM token_profiles WHERE profile=?)',
        )
        .run(id);
      this.db.prepare('UPDATE mua_sync SET revision=revision+1,attempts=0,next=0 WHERE id=1').run();
    });
  }
  deleteProfile(account: Account, id: string) {
    this.transaction(() => {
      requireThat(!this.ownProfile(account, id).primary, 'Primary profile cannot be deleted');
      this.db
        .prepare(
          'DELETE FROM tokens WHERE hash IN (SELECT token FROM token_profiles WHERE profile=?)',
        )
        .run(id);
      this.db.prepare('DELETE FROM extra_profiles WHERE id=?').run(id);
      this.db.prepare('UPDATE mua_sync SET revision=revision+1,attempts=0,next=0 WHERE id=1').run();
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
      .all(p.primary ? account.id : id) as Texture[];
  }
  setTexture(account: Account, id: string, kind: string, hash: string, model: string) {
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
            this.setTexture(account, next, texture.kind, texture.hash, texture.model);
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
  resetPassword(email: string, code: string, passwordHash: string, now: number) {
    this.rate(`reset-confirm:${digest(email)}`, now, 10, 900);
    this.transaction(() => {
      const account = this.account('email', email);
      requireThat(account);
      const row = this.db
        .prepare('SELECT 1 FROM password_resets WHERE account=? AND token=? AND expires>?')
        .get(account.id, digest(code), now);
      requireThat(row, 'Invalid or expired verification');
      this.db.prepare('UPDATE accounts SET password=? WHERE id=?').run(passwordHash, account.id);
      this.db.prepare('DELETE FROM password_resets WHERE account=?').run(account.id);
      this.revokeSessions(account.id);
      this.db.prepare('DELETE FROM challenges WHERE email=?').run(email);
    });
  }
  requireCredentials(account: Account) {
    const current = this.account('id', account.id);
    requireThat(current?.disabled === 0, 'Account disabled');
    requireThat(
      current.credential_revision === account.credential_revision,
      'Credentials changed; sign in again',
    );
  }
  mint(account: Account, client: string, now: number, selectProfile = true) {
    requireThat(client.length <= 256);
    this.requireCredentials(account);
    const token = secret();
    this.db.prepare('DELETE FROM tokens WHERE expires<=?').run(now);
    this.db
      .prepare(
        'DELETE FROM tokens WHERE hash IN (SELECT hash FROM tokens WHERE account=? ORDER BY expires DESC LIMIT -1 OFFSET 9)',
      )
      .run(account.id);
    this.db
      .prepare('INSERT INTO tokens VALUES(?,?,?,?)')
      .run(digest(token), client, account.id, now + 86400);
    if (!selectProfile)
      this.db.prepare('INSERT INTO token_profiles VALUES(?,NULL)').run(digest(token));
    return token;
  }
  revokeSessions(account: string) {
    this.db
      .prepare('UPDATE accounts SET credential_revision = credential_revision + 1 WHERE id=?')
      .run(account);
    this.db.prepare('DELETE FROM tokens WHERE account=?').run(account);
    for (const table of ['oauth_refresh', 'oauth_devices']) {
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
        this.db.prepare(`DELETE FROM ${table} WHERE account=?`).run(account);
    }
  }
  token(token: string, client: string | undefined, now: number) {
    const row = this.db
      .prepare('SELECT account,client FROM tokens WHERE hash=? AND expires>?')
      .get(digest(token), now) as { account: string; client: string } | undefined;
    requireThat(row && (client === undefined || row.client === client), 'Invalid token');
    const account = this.account('id', row.account);
    requireThat(account?.disabled === 0, 'Account disabled');
    return account;
  }
  refresh(token: string, client: string | undefined, profile: string | undefined, now: number) {
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
      const next = this.mint(a, stored.client, now);
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
  join(token: string, profile: string, server: string, now: number, ip?: string) {
    requireThat(server.length > 0 && server.length <= 64);
    const account = this.token(token, undefined, now);
    this.ownProfile(account, profile);
    requireThat(this.selectedProfile(token, account) === profile, 'Token profile mismatch');
    this.db.prepare('DELETE FROM joins WHERE expires<=?').run(now);
    this.db
      .prepare('INSERT OR REPLACE INTO joins(server,profile,token,expires,ip) VALUES(?,?,?,?,?)')
      .run(server, profile, digest(token), now + 30, ip ?? null);
  }
  joined(name: string, server: string, now: number, ip?: string) {
    const foundProfile = this.profileNamed(name);
    if (!foundProfile) return undefined;
    const a = foundProfile.account;
    if (a.disabled !== 0) return undefined;
    const found = this.db
      .prepare(
        'SELECT 1 FROM joins j JOIN tokens t ON t.hash=j.token WHERE j.server=? AND j.profile=? AND j.expires>? AND t.expires>? AND (? IS NULL OR j.ip=?)',
      )
      .get(server, foundProfile.profile.id, now, now, ip ?? null, ip ?? null);
    return found ? a : undefined;
  }
}
export const accountId = () => randomUUID().replaceAll('-', '');
