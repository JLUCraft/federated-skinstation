import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Store, digest, requireThat, secret, type Account } from './store.js';
import { boundedJson, field, record } from './validate.js';

export interface MicrosoftConfig {
  clientId: string;
  clientSecretEnv: string;
}
const AUTH_ROOT = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const MINECRAFT_ROOT = 'https://api.minecraftservices.com';
const OAUTH_SECONDS = 300;
const RESULT_SECONDS = 60;
const bearer = (value: string | undefined) => {
  requireThat(value && value.startsWith('Bearer '));
  return value.slice(7);
};
const now = () => Math.floor(Date.now() / 1000);
const cookieValue = (header: string | undefined, name: string) =>
  header
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? '';

/** A profile is accepted only after the Microsoft -> Xbox -> Minecraft server exchanges. */
export async function minecraftIdentity(
  code: string,
  verifier: string,
  config: MicrosoftConfig,
  redirect: string,
  fetcher: typeof fetch,
) {
  const clientSecret = process.env[config.clientSecretEnv];
  requireThat(clientSecret, 'Microsoft login is not configured');
  const json = async (url: string, init?: RequestInit) =>
    boundedJson(
      await fetcher(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      }),
    );
  const post = (url: string, body: unknown) =>
    json(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const oauth = await json(`${AUTH_ROOT}/token`, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
    }),
  });
  const xbox = await post('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${field(oauth.access_token, 16384)}`,
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
  const xsts = await post('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [field(xbox.Token, 16384)] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  });
  const claims = record(xsts.DisplayClaims);
  requireThat(
    Array.isArray(claims.xui) && claims.xui.length === 1,
    'Invalid Xbox identity',
  );
  const hash = field(record(claims.xui[0]).uhs, 128);
  const minecraft = await post(
    `${MINECRAFT_ROOT}/authentication/login_with_xbox`,
    {
      identityToken: `XBL3.0 x=${hash};${field(xsts.Token, 16384)}`,
    },
  );
  const headers = {
    Authorization: `Bearer ${field(minecraft.access_token, 16384)}`,
  };
  const entitlements = await json(`${MINECRAFT_ROOT}/entitlements/mcstore`, {
    headers,
  });
  requireThat(
    Array.isArray(entitlements.items) &&
      entitlements.items.some((item) =>
        ['game_minecraft', 'product_minecraft'].includes(
          String(record(item).name),
        ),
      ),
    'Minecraft Java ownership required',
  );
  const profile = await json(`${MINECRAFT_ROOT}/minecraft/profile`, {
    headers,
  });
  const id = field(profile.id, 32),
    name = field(profile.name, 16);
  requireThat(
    /^[a-f0-9]{32}$/.test(id) && /^[a-zA-Z0-9_]{1,16}$/.test(name),
    'Invalid Minecraft profile',
  );
  return { id, name };
}

export async function registerMicrosoft(
  app: FastifyInstance,
  db: Store,
  config: MicrosoftConfig,
  origin: string,
  authorize: (account: Account) => Promise<void>,
  fetcher: typeof fetch = fetch,
) {
  requireThat(
    config.clientId &&
      config.clientSecretEnv &&
      process.env[config.clientSecretEnv],
    'Microsoft configuration incomplete',
  );
  const redirect = `${origin}/api/microsoft/callback`;
  const secure = new URL(origin).protocol === 'https:' ? '; Secure' : '';
  const cookie = (name: string, value: string, age: number) =>
    `${name}=${value}; Path=/api/microsoft/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`;
  const sameOrigin = (header: string | undefined) =>
    requireThat(!header || header === origin, 'Foreign request origin');
  db.db
    .exec(`CREATE TABLE IF NOT EXISTS microsoft_links(account TEXT PRIMARY KEY REFERENCES accounts(id),profile TEXT UNIQUE NOT NULL,name TEXT NOT NULL,verified_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS microsoft_oauth(state TEXT PRIMARY KEY,cookie TEXT NOT NULL,token TEXT REFERENCES tokens(hash) ON DELETE CASCADE,verifier TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS microsoft_results(cookie TEXT PRIMARY KEY,account TEXT NOT NULL REFERENCES accounts(id),token TEXT REFERENCES tokens(hash) ON DELETE CASCADE,profile TEXT NOT NULL,expires INTEGER NOT NULL);`);
  app.post('/api/microsoft/start', async (req, reply) => {
    sameOrigin(req.headers.origin);
    const body = record(req.body);
    requireThat(body.mode === 'link' || body.mode === 'login');
    let token: string | null = null;
    if (body.mode === 'link') {
      token = bearer(req.headers.authorization);
      await authorize(db.token(token, undefined, now()));
    }
    const state = secret(),
      browser = secret(),
      verifier = secret();
    db.transaction(() => {
      db.db
        .prepare('DELETE FROM microsoft_oauth WHERE expires<=? OR cookie=?')
        .run(now(), digest(cookieValue(req.headers.cookie, 'microsoft_state')));
      db.db
        .prepare('INSERT INTO microsoft_oauth VALUES(?,?,?,?,?)')
        .run(
          digest(state),
          digest(browser),
          token ? digest(token) : null,
          verifier,
          now() + OAUTH_SECONDS,
        );
    });
    const url = new URL(`${AUTH_ROOT}/authorize`);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: redirect,
      response_mode: 'query',
      scope: 'XboxLive.signin',
      state,
      prompt: 'select_account',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    reply.header(
      'Set-Cookie',
      cookie('microsoft_state', browser, OAUTH_SECONDS),
    );
    return { url: url.toString() };
  });
  app.get('/api/microsoft/callback', async (req, reply) => {
    const query = record(req.query);
    const state = field(query.state),
      browser = cookieValue(req.headers.cookie, 'microsoft_state');
    const pending = db.transaction(() => {
      const row = db.db
        .prepare(
          'SELECT token,verifier FROM microsoft_oauth WHERE state=? AND cookie=? AND expires>?',
        )
        .get(digest(state), digest(browser), now()) as
        { token: string | null; verifier: string } | undefined;
      requireThat(row, 'Invalid or expired Microsoft login');
      db.db
        .prepare('DELETE FROM microsoft_oauth WHERE state=?')
        .run(digest(state));
      return row;
    });
    reply.header('Set-Cookie', cookie('microsoft_state', '', 0));
    if (query.error)
      return reply.redirect(`${origin}/portal/?microsoft=cancelled`);
    try {
      const profile = await minecraftIdentity(
        field(query.code, 4096),
        pending.verifier,
        config,
        redirect,
        fetcher,
      );
      let account: Account | undefined;
      if (pending.token) {
        const session = db.db
          .prepare('SELECT account FROM tokens WHERE hash=? AND expires>?')
          .get(pending.token, now()) as { account: string } | undefined;
        requireThat(session, 'Login session expired');
        account = db.account('id', session.account);
      } else {
        const link = db.db
          .prepare('SELECT account FROM microsoft_links WHERE profile=?')
          .get(profile.id) as { account: string } | undefined;
        requireThat(
          link,
          'Link this Microsoft account from your profile first',
        );
        account = db.account('id', link.account);
      }
      requireThat(account);
      await authorize(account);
      const resultCookie = secret();
      db.transaction(() => {
        if (pending.token) {
          requireThat(
            db.db
              .prepare(
                'SELECT 1 FROM tokens WHERE hash=? AND account=? AND expires>?',
              )
              .get(pending.token, account.id, now()),
            'Login session expired',
          );
          const collision = db.db
            .prepare('SELECT account FROM microsoft_links WHERE profile=?')
            .get(profile.id) as { account: string } | undefined;
          requireThat(
            !collision || collision.account === account.id,
            'Minecraft account already linked',
          );
          const previous = db.db
            .prepare('SELECT profile FROM microsoft_links WHERE account=?')
            .get(account.id) as { profile: string } | undefined;
          requireThat(
            !previous || previous.profile === profile.id,
            'Unlink the previous account first',
          );
          db.db
            .prepare(
              'INSERT INTO microsoft_links VALUES(?,?,?,?) ON CONFLICT(account) DO UPDATE SET name=excluded.name,verified_at=excluded.verified_at',
            )
            .run(account.id, profile.id, profile.name, now());
        }
        db.db
          .prepare('DELETE FROM microsoft_results WHERE expires<=?')
          .run(now());
        requireThat(
          db.db
            .prepare(
              'SELECT 1 FROM microsoft_links WHERE account=? AND profile=?',
            )
            .get(account.id, profile.id),
          'Microsoft link changed',
        );
        db.db
          .prepare(
            'UPDATE microsoft_links SET name=?,verified_at=? WHERE account=? AND profile=?',
          )
          .run(profile.name, now(), account.id, profile.id);
        db.db
          .prepare('INSERT INTO microsoft_results VALUES(?,?,?,?,?)')
          .run(
            digest(resultCookie),
            account.id,
            pending.token,
            profile.id,
            now() + RESULT_SECONDS,
          );
      });
      reply.header('Set-Cookie', [
        cookie('microsoft_state', '', 0),
        cookie('microsoft_result', resultCookie, RESULT_SECONDS),
      ]);
      return reply.redirect(`${origin}/portal/?microsoft=complete`);
    } catch {
      return reply.redirect(`${origin}/portal/?microsoft=failed`);
    }
  });
  app.post('/api/microsoft/complete', async (req, reply) => {
    sameOrigin(req.headers.origin);
    const result = db.transaction(() => {
      const key = digest(cookieValue(req.headers.cookie, 'microsoft_result'));
      const row = db.db
        .prepare(
          'SELECT account,token,profile FROM microsoft_results WHERE cookie=? AND expires>?',
        )
        .get(key, now()) as
        { account: string; token: string | null; profile: string } | undefined;
      requireThat(row, 'Invalid or expired Microsoft result');
      db.db.prepare('DELETE FROM microsoft_results WHERE cookie=?').run(key);
      return row;
    });
    const account = db.account('id', result.account);
    requireThat(account);
    await authorize(account);
    reply.header('Set-Cookie', cookie('microsoft_result', '', 0));
    if (result.token) {
      requireThat(
        db.db
          .prepare('SELECT 1 FROM tokens WHERE hash=? AND expires>?')
          .get(result.token, now()),
        'Login session expired',
      );
      // Return a fresh site session after the redirect; never expose upstream tokens.
    }
    return {
      accessToken: db.transaction(() => {
        requireThat(
          db.db
            .prepare(
              'SELECT 1 FROM microsoft_links WHERE account=? AND profile=?',
            )
            .get(account.id, result.profile),
          'Microsoft link changed',
        );
        return db.mint(account.id, secret(), now());
      }),
      selectedProfile: { id: db.profileId(account), name: account.name },
    };
  });
  app.get('/api/microsoft/link', async (req) => {
    const account = db.token(
      bearer(req.headers.authorization),
      undefined,
      now(),
    );
    return {
      link:
        db.db
          .prepare(
            'SELECT name,verified_at AS verifiedAt FROM microsoft_links WHERE account=?',
          )
          .get(account.id) ?? null,
    };
  });
  app.delete('/api/microsoft/link', async (req, reply) => {
    sameOrigin(req.headers.origin);
    const account = db.token(
      bearer(req.headers.authorization),
      undefined,
      now(),
    );
    db.transaction(() => {
      db.db
        .prepare('DELETE FROM microsoft_links WHERE account=?')
        .run(account.id);
      db.db
        .prepare('DELETE FROM microsoft_results WHERE account=?')
        .run(account.id);
      db.db
        .prepare(
          'DELETE FROM microsoft_oauth WHERE token IN (SELECT hash FROM tokens WHERE account=?)',
        )
        .run(account.id);
    });
    return reply.code(204).send();
  });
}
