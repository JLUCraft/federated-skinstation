import { registerMuaLogin, type MuaLoginServices, type MuaOAuthConfig } from './mua-login.js';
export { muaSubject } from './mua-login.js';
import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { isSecretName, type SecretState } from './secret-state.js';
import { registerMemberFeatures } from './mua-member.js';
import type { LocalIdentity } from './permissions.js';
import { boundedValue, boundedJson, field, record } from './validate.js';
import { Store, digest, now, requireThat } from './store.js';

export interface MuaConfig {
  apiRoot: string;
  /** Explicit administrator pin; never learn this key from an incoming request. */
  hostPublicKey?: string;
  oauth?: MuaOAuthConfig;
  member?: {
    keyEnv: string;
    storageKeyEnv?: string;
    adminAccounts?: string[];
    oauthSigningKey?: string;
    oauthBackendPublicKey?: string;
  };
}

export function yggdrasilRoot(
  apiRoot: string,
  mode: 'all' | 'only' | 'excludes',
  codes: string[] = [],
): string {
  const base = new URL(apiRoot);
  requireThat(
    base.protocol === 'https:' && !base.username && !base.password && !base.search && !base.hash,
  );
  requireThat(mode === 'all' ? codes.length === 0 : codes.length > 0);
  requireThat(codes.length <= 128 && codes.every((code) => /^[A-Z0-9]{1,16}$/.test(code)));
  return `${apiRoot.replace(/\/$/, '')}/yggdrasil${mode === 'all' ? '' : `/${mode}/${[...new Set(codes)].sort().join('_')}`}`;
}

/** Matches UnionHostVerify.php: exact body || timestamp || nonce, RSA-SHA256. */
export function verifyHost(
  db: Store,
  publicKey: string,
  raw: Buffer,
  headers: Record<string, unknown>,
  now: number,
): void {
  const timestamp = field(headers['x-message-timestamp'], 20);
  const nonce = field(headers['x-message-nonce'], 256);
  const signature = field(headers['x-message-signature'], 4096);
  requireThat(/^\d+(\.\d+)?$/.test(timestamp));
  requireThat(
    Number(timestamp) >= now - 10 && Number(timestamp) <= now + 30,
    'Expired MUA request',
  );
  requireThat(
    verify(
      'RSA-SHA256',
      Buffer.concat([raw, Buffer.from(timestamp + nonce)]),
      publicKey,
      Buffer.from(signature, 'base64'),
    ),
    'Invalid MUA signature',
  );
  db.transaction(() => {
    db.db.prepare('DELETE FROM mua_nonces WHERE expires<=?').run(now);
    requireThat(
      !db.db.prepare('SELECT 1 FROM mua_nonces WHERE nonce=?').get(digest(nonce)),
      'Replayed MUA request',
    );
    db.db.prepare('INSERT INTO mua_nonces VALUES(?,?)').run(digest(nonce), now + 60);
  });
}

export async function registerMua(
  app: FastifyInstance,
  db: Store,
  config: MuaConfig,
  origin: string,
  organization: string,
  identity: LocalIdentity,
  login: MuaLoginServices,
  fetcher: typeof fetch = fetch,
  secrets?: SecretState,
) {
  yggdrasilRoot(config.apiRoot, 'all');
  const hostPublicKey = config.hostPublicKey;
  if (config.member) requireThat(hostPublicKey, 'MUA member signing key required');
  if (hostPublicKey) requireThat(createPublicKey(hostPublicKey).asymmetricKeyType === 'rsa');
  db.db.exec(`CREATE TABLE IF NOT EXISTS mua_state(name TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mua_nonces(nonce TEXT PRIMARY KEY,expires INTEGER NOT NULL);`);
  if (config.member) {
    requireThat(secrets, 'MUA storage key required');
    secrets.validate(db);
  }
  const root = config.apiRoot.replace(/\/$/, '');
  const fetchJson = async (path: string, init?: RequestInit) =>
    boundedJson(
      await fetcher(`${root}${path}`, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      }),
    );

  const stored = (name: string) => {
    const value = (
      db.db.prepare('SELECT value FROM mua_state WHERE name=?').get(name) as
        | { value: string }
        | undefined
    )?.value;
    if (value !== undefined && isSecretName(name)) {
      requireThat(secrets);
      return secrets.open(name, value);
    }
    return value;
  };
  const save = (name: string, value: string) => {
    if (isSecretName(name)) {
      requireThat(secrets);
      value = secrets.seal(name, value);
    }
    return db.db.prepare('INSERT OR REPLACE INTO mua_state VALUES(?,?)').run(name, value);
  };
  const memberKey = () => {
    const key =
      stored('memberKey') ?? (config.member ? process.env[config.member.keyEnv] : undefined);
    requireThat(key, 'Member key missing');
    return key;
  };
  const memberFetch = async (path: string, init: RequestInit = {}) => {
    requireThat(config.member, 'Member integration not configured');
    const key = memberKey();
    const headers = new Headers(init.headers);
    headers.set('X-Union-Member-Key', key);
    const response = await fetcher(`${root}${path}`, {
      ...init,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 204) return {};
    return boundedValue(response);
  };
  app.get('/api/union/member/', async (_req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    return {
      yggdrasilApiVersion: `${organization}-0.2.0`,
      serverListVersion: stored('serverListVersion') ?? '0',
      privateKeyVersion: stored('privateKeyVersion') ?? '0',
      enabledFeatures: [
        'emailVerification',
        ...(config.member ? ['unionBlacklist'] : []),
        ...(config.member?.oauthSigningKey ? ['unionOAuth2'] : []),
      ],
    };
  });
  let synchronizing: Promise<void> | undefined;
  const performSync = async () => {
    const revision = (
      db.db.prepare('SELECT revision FROM mua_sync WHERE id=1').get() as {
        revision: number;
      }
    ).revision;
    const accounts = db.db
      .prepare('SELECT * FROM accounts LIMIT 10001')
      .all() as unknown as import('./store.js').Account[];
    requireThat(accounts.length <= 10000, 'Too many profiles for one sync');
    const profileList = Object.fromEntries(
      accounts.flatMap((a) => db.profiles(a).map((p) => [p.id, p.name])),
    );
    requireThat(
      Buffer.byteLength(JSON.stringify(profileList)) <= 1024 * 1024,
      'Profile sync exceeds supported size',
    );
    await memberFetch('/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileList }),
    });
    db.db.prepare('UPDATE mua_sync SET synced=?,attempts=0,next=0 WHERE id=1').run(revision);
  };
  const synchronize = () => {
    if (!synchronizing)
      synchronizing = performSync().finally(() => {
        synchronizing = undefined;
      });
    return synchronizing;
  };
  if (config.member) {
    let inFlight: Promise<void> | undefined;
    let stopping = false;
    const timer = setInterval(() => {
      if (stopping || inFlight) return;
      const job = db.db
        .prepare('SELECT revision,synced,attempts,next FROM mua_sync WHERE id=1')
        .get() as {
        revision: number;
        synced: number;
        attempts: number;
        next: number;
      };
      if (job.revision === job.synced || job.attempts >= 12 || job.next > now()) return;
      inFlight = synchronize()
        .catch(() => {
          const attempts = job.attempts + 1;
          db.db
            .prepare('UPDATE mua_sync SET attempts=?,next=? WHERE id=1')
            .run(attempts, now() + Math.min(300, 5 * 2 ** attempts));
          app.log.warn({ attempt: attempts }, 'MUA profile synchronization deferred');
        })
        .finally(() => {
          inFlight = undefined;
        });
    }, 5000);
    timer.unref();
    app.addHook('preClose', async () => {
      stopping = true;
      clearInterval(timer);
      await inFlight;
    });
  }

  // Encapsulation preserves exact bytes without changing normal JSON route parsers.
  if (hostPublicKey)
    await app.register(async (scope) => {
      scope.removeContentTypeParser('application/json');
      scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
        done(null, body),
      );
      scope.addHook('preHandler', async (req) => {
        const raw = req.method === 'GET' ? Buffer.alloc(0) : req.body;
        requireThat(Buffer.isBuffer(raw));
        verifyHost(db, hostPublicKey, raw, req.headers, now());
      });
      if (config.member) {
        scope.get('/api/union/member/queryemail', async (req, reply) => {
          const query = record(req.query);
          const account = db.profileNamed(field(query.username, 16))?.account;
          return account ? { email: account.email } : reply.code(204).send();
        });
        scope.post('/api/union/member/updatebackendkey', async (req, reply) => {
          const body = record(JSON.parse((req.body as Buffer).toString('utf8')));
          save('memberKey', field(body.key, 4096));
          db.db.prepare('UPDATE mua_sync SET attempts=0,next=0 WHERE id=1').run();
          return reply.code(204).send();
        });
        scope.post('/api/union/member/updatelist', async (_req, reply) => {
          const response = record(await memberFetch('/serverlist'));
          requireThat(response.servers !== null && typeof response.servers === 'object');
          const servers = Object.values(response.servers as object);
          requireThat(servers.length <= 1024);
          for (const entry of servers) {
            const server = record(entry);
            const url = new URL(field(server.bs_root, 2048));
            requireThat(url.protocol === 'https:' && !url.username && !url.password);
          }
          requireThat(typeof response.version === 'number' || typeof response.version === 'string');
          db.transaction(() => {
            save('servers', JSON.stringify(response.servers));
            save('serverListVersion', String(response.version));
          });
          return reply.code(204).send();
        });
        scope.post('/api/union/member/updateprivatekey', async (_req, reply) => {
          const response = record(await memberFetch('/privatekey'));
          const pem = field(response.privateKey, 16384);
          const key = createPrivateKey(pem);
          requireThat(
            key.asymmetricKeyType === 'rsa' &&
              (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048,
          );
          requireThat(
            typeof response.privateKeyVersion === 'number' ||
              typeof response.privateKeyVersion === 'string',
          );
          db.transaction(() => {
            save('textureKey', pem);
            save('privateKeyVersion', String(response.privateKeyVersion));
          });
          return reply.code(204).send();
        });
        scope.post('/api/union/member/sync', async (_req, reply) => {
          await synchronize();
          return reply.code(204).send();
        });
        scope.post('/api/union/member/remapuuid', async (req, reply) => {
          const body = record(JSON.parse((req.body as Buffer).toString('utf8')));
          const mapped = record(body.remapped_uuid);
          const entries = Object.entries(mapped);
          requireThat(
            entries.length <= 1024 &&
              entries.every(
                ([old, value]) =>
                  /^[a-f0-9]{32}$/.test(old) &&
                  typeof value === 'string' &&
                  /^[a-f0-9]{32}$/.test(value),
              ),
          );
          db.remapProfiles(mapped as Record<string, string>);
          return reply.code(204).send();
        });
      }
      scope.post('/api/union/member/diagnose', async (req) => {
        const body = record(JSON.parse((req.body as Buffer).toString('utf8')));
        return { nonce: body.nonce, timestamp: Date.now() / 1000 };
      });
    });

  if (config.member)
    await registerMemberFeatures(app, db, config, origin, memberFetch, memberKey, identity);
  if (config.oauth)
    registerMuaLogin(app, db, config.oauth, root, origin, identity, fetchJson, login);
}
