import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  createHash,
  createPublicKey,
  randomInt,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  Rejected,
  Store,
  digest,
  now,
  requireThat,
  secret,
  type Account,
} from './store.js';
import { bearer, field, record } from './validate.js';

/**
 * Yggdrasil Connect: the OpenID Connect device flow that MUA-compatible launchers use.
 * The launcher discovers it through `meta["feature.openid_configuration_url"]`.
 */
export const OAUTH_SCOPES = [
  'openid',
  'offline_access',
  'Yggdrasil.PlayerProfiles.Select',
  'Yggdrasil.Server.Join',
] as const;
type Scope = (typeof OAUTH_SCOPES)[number];
const isScope = (value: string): value is Scope =>
  (OAUTH_SCOPES as readonly string[]).includes(value);

/** Public client id shared by every launcher; the flow has no client secret. */
export const SHARED_CLIENT_ID = 'jlucraft-launcher';
const DEVICE_LIFETIME_SECONDS = 600;
const POLL_INTERVAL_SECONDS = 5;
const REFRESH_LIFETIME_SECONDS = 30 * 86400;
const ACCESS_LIFETIME_SECONDS = 86400;
const ID_TOKEN_LIFETIME_SECONDS = 3600;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
const USER_CODE_LENGTH = 8;
const MAX_FORM_BYTES = 16 * 1024;

/** RFC 8628 / RFC 6749 error, returned as HTTP 400 with a JSON body. */
class OAuthError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'invalid_client'
      | 'invalid_grant'
      | 'invalid_scope'
      | 'unsupported_grant_type'
      | 'authorization_pending'
      | 'slow_down'
      | 'access_denied'
      | 'expired_token',
  ) {
    super(code);
  }
}

interface DeviceRow {
  device: string;
  user_code: string;
  client: string;
  scope: string;
  expires: number;
  account: string | null;
  profile: string | null;
  denied: number;
  polled: number;
}
interface RefreshRow {
  account: string;
  profile: string;
  client: string;
  scope: string;
  expires: number;
}

const base64url = (value: Buffer | string) =>
  Buffer.from(value).toString('base64url');

function parseScope(value: unknown): Scope[] {
  const requested = typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
  if (!requested.every(isScope)) throw new OAuthError('invalid_scope');
  return requested;
}

const normalizeUserCode = (value: string) =>
  value.toUpperCase().replace(/[^A-Z0-9]/g, '');
const formatUserCode = (code: string) =>
  `${code.slice(0, USER_CODE_LENGTH / 2)}-${code.slice(USER_CODE_LENGTH / 2)}`;

export function registerConnect(
  app: FastifyInstance,
  db: Store,
  options: {
    origin: string;
    key: KeyObject;
    authorize: (account: Account) => Promise<void>;
  },
) {
  const { origin, key } = options;
  db.db.exec(`CREATE TABLE IF NOT EXISTS oauth_devices(device TEXT PRIMARY KEY,user_code TEXT UNIQUE NOT NULL,client TEXT NOT NULL,scope TEXT NOT NULL,expires INTEGER NOT NULL,account TEXT REFERENCES accounts(id) ON DELETE CASCADE,profile TEXT,denied INTEGER NOT NULL DEFAULT 0,polled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS oauth_refresh(hash TEXT PRIMARY KEY,account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,profile TEXT NOT NULL,client TEXT NOT NULL,scope TEXT NOT NULL,expires INTEGER NOT NULL);`);

  const jwk = createPublicKey(key).export({ format: 'jwk' });
  const keyId = createHash('sha256')
    .update(createPublicKey(key).export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 16);

  // Token requests are form-encoded by OAuth clients; Fastify only parses JSON by default.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: MAX_FORM_BYTES },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );
  /** OAuth clients expect RFC 6749 error bodies rather than the site's own format. */
  const oauth =
    <Request extends FastifyRequest>(
      handler: (req: Request, reply: FastifyReply) => Promise<unknown>,
    ) =>
    async (req: Request, reply: FastifyReply) => {
      try {
        return await handler(req, reply);
      } catch (error) {
        if (error instanceof OAuthError)
          return reply.code(400).send({ error: error.code });
        throw error;
      }
    };

  app.get('/.well-known/openid-configuration', async () => ({
    issuer: origin,
    device_authorization_endpoint: `${origin}/api/oauth/device`,
    token_endpoint: `${origin}/api/oauth/token`,
    jwks_uri: `${origin}/api/oauth/jwks`,
    shared_client_id: SHARED_CLIENT_ID,
    scopes_supported: OAUTH_SCOPES,
    response_types_supported: ['code'],
    grant_types_supported: [
      'urn:ietf:params:oauth:grant-type:device_code',
      'refresh_token',
    ],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
  }));
  app.get('/api/oauth/jwks', async () => ({
    keys: [{ ...jwk, kid: keyId, use: 'sig', alg: 'RS256' }],
  }));

  app.post(
    '/api/oauth/device',
    { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    oauth(async (req, reply) => {
      const body = record(req.body);
      if (body.client_id !== SHARED_CLIENT_ID)
        throw new OAuthError('invalid_client');
      const scope = parseScope(body.scope);
      const device = secret();
      let userCode = '';
      for (let i = 0; i < USER_CODE_LENGTH; i++)
        userCode += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
      db.transaction(() => {
        db.db
          .prepare('DELETE FROM oauth_devices WHERE expires<=?')
          .run(now());
        db.db
          .prepare(
            'INSERT INTO oauth_devices(device,user_code,client,scope,expires) VALUES(?,?,?,?,?)',
          )
          .run(
            digest(device),
            userCode,
            SHARED_CLIENT_ID,
            scope.join(' '),
            now() + DEVICE_LIFETIME_SECONDS,
          );
      });
      const shown = formatUserCode(userCode);
      reply.header('Cache-Control', 'no-store');
      return {
        device_code: device,
        user_code: shown,
        verification_uri: `${origin}/portal/`,
        verification_uri_complete: `${origin}/portal/?user_code=${shown}`,
        expires_in: DEVICE_LIFETIME_SECONDS,
        interval: POLL_INTERVAL_SECONDS,
      };
    }),
  );

  const pending = (userCode: string) => {
    const row = db.db
      .prepare(
        'SELECT * FROM oauth_devices WHERE user_code=? AND expires>? AND account IS NULL AND denied=0',
      )
      .get(normalizeUserCode(userCode), now()) as DeviceRow | undefined;
    if (!row) throw new Rejected('Unknown or expired code', 404, 'Not Found');
    return row;
  };
  app.get('/api/oauth/device', async (req) => {
    const owner = db.token(bearer(req.headers.authorization), undefined, now());
    await options.authorize(owner);
    const row = pending(field(record(req.query).user_code, 32));
    return { scopes: row.scope.split(' ') };
  });
  app.post(
    '/api/oauth/device/decision',
    { config: { rateLimit: { max: 10, timeWindow: 900_000 } } },
    async (req, reply) => {
      const owner = db.token(bearer(req.headers.authorization), undefined, now());
      await options.authorize(owner);
      const body = record(req.body);
      requireThat(typeof body.approve === 'boolean');
      const row = pending(field(body.userCode, 32));
      const profile =
        body.profileId === undefined
          ? db.profileId(owner)
          : db.ownProfile(owner, field(body.profileId, 32)).id;
      db.db
        .prepare(
          body.approve
            ? 'UPDATE oauth_devices SET account=?,profile=? WHERE device=?'
            : 'UPDATE oauth_devices SET denied=1 WHERE device=?',
        )
        .run(
          ...(body.approve
            ? [owner.id, profile, row.device]
            : [row.device]),
        );
      return reply.code(204).send();
    },
  );

  const idToken = (account: Account, profile: string, client: string) => {
    const selected = db.ownProfile(account, profile);
    const issued = now();
    const encode = (part: object) => base64url(JSON.stringify(part));
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT', kid: keyId })}.${encode({
      iss: origin,
      sub: account.id,
      aud: client,
      iat: issued,
      exp: issued + ID_TOKEN_LIFETIME_SECONDS,
      selectedProfile: { id: selected.id, name: selected.name },
      availableProfiles: db.profiles(account).map(({ id, name }) => ({ id, name })),
    })}`;
    return `${unsigned}.${base64url(sign('RSA-SHA256', Buffer.from(unsigned), key))}`;
  };
  /** Issue the token set for one account profile; the refresh token is single-use. */
  const issue = (
    account: Account,
    profile: string,
    client: string,
    scope: string,
  ) => {
    const scopes = scope.split(' ');
    const access = db.transaction(() => {
      const token = db.mint(account.id, `oauth:${client}`, now(), false);
      db.db
        .prepare('UPDATE token_profiles SET profile=? WHERE token=?')
        .run(profile, digest(token));
      return token;
    });
    let refresh = '';
    if (scopes.includes('offline_access')) {
      refresh = secret();
      db.db
        .prepare('INSERT INTO oauth_refresh VALUES(?,?,?,?,?,?)')
        .run(
          digest(refresh),
          account.id,
          profile,
          client,
          scope,
          now() + REFRESH_LIFETIME_SECONDS,
        );
    }
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_LIFETIME_SECONDS,
      refresh_token: refresh,
      scope,
      ...(scopes.includes('openid')
        ? { id_token: idToken(account, profile, client) }
        : {}),
    };
  };

  app.post(
    '/api/oauth/token',
    { config: { rateLimit: { max: 60, timeWindow: 60_000 } } },
    oauth(async (req, reply) => {
      const body = record(req.body);
      if (body.client_id !== SHARED_CLIENT_ID)
        throw new OAuthError('invalid_client');
      reply.header('Cache-Control', 'no-store');
      if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        const hash = digest(field(body.device_code, 128));
        const result = db.transaction(() => {
          const row = db.db
            .prepare('SELECT * FROM oauth_devices WHERE device=?')
            .get(hash) as DeviceRow | undefined;
          if (!row || row.client !== SHARED_CLIENT_ID)
            throw new OAuthError('invalid_grant');
          if (row.expires <= now()) {
            db.db.prepare('DELETE FROM oauth_devices WHERE device=?').run(hash);
            throw new OAuthError('expired_token');
          }
          if (row.denied) {
            db.db.prepare('DELETE FROM oauth_devices WHERE device=?').run(hash);
            throw new OAuthError('access_denied');
          }
          if (!row.account || !row.profile) {
            const tooFast = now() - row.polled < POLL_INTERVAL_SECONDS;
            db.db
              .prepare('UPDATE oauth_devices SET polled=? WHERE device=?')
              .run(now(), hash);
            // Returned rather than thrown: a throw would roll back the poll timestamp.
            return tooFast ? 'slow_down' : 'authorization_pending';
          }
          db.db.prepare('DELETE FROM oauth_devices WHERE device=?').run(hash);
          return { account: row.account, profile: row.profile, scope: row.scope };
        });
        if (typeof result === 'string') throw new OAuthError(result);
        const account = db.account('id', result.account);
        requireThat(account);
        await options.authorize(account);
        return issue(account, result.profile, SHARED_CLIENT_ID, result.scope);
      }
      if (body.grant_type === 'refresh_token') {
        const hash = digest(field(body.refresh_token, 128));
        const row = db.transaction(() => {
          const found = db.db
            .prepare('SELECT * FROM oauth_refresh WHERE hash=? AND expires>?')
            .get(hash, now()) as RefreshRow | undefined;
          if (!found || found.client !== SHARED_CLIENT_ID)
            throw new OAuthError('invalid_grant');
          db.db.prepare('DELETE FROM oauth_refresh WHERE hash=?').run(hash);
          return found;
        });
        const account = db.account('id', row.account);
        if (!account || !db.profiles(account).some((p) => p.id === row.profile))
          throw new OAuthError('invalid_grant');
        await options.authorize(account);
        return issue(account, row.profile, SHARED_CLIENT_ID, row.scope);
      }
      throw new OAuthError('unsupported_grant_type');
    }),
  );
}
