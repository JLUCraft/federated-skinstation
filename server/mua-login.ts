import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  muaAdmissionSchema,
  muaEnrollmentSchema,
  muaEnrollmentConfirmationSchema,
  type MuaAdmission,
  type MuaEnrollment,
  type MuaEnrollmentConfirmation,
  type MuaIdentityState,
} from '../shared/contracts/generated.js';
import type { Authentication } from '../shared/http.js';
import { OAUTH_TOKEN_CLIENT_PREFIX } from '../shared/oauth.js';
import type { School } from './school.js';
import { appendAudit, type LocalIdentity } from './permissions.js';
import { accountId, digest, now, requireThat, secret, type Account, type Store } from './store.js';
import { bearer, field, record } from './validate.js';

const FLOW_SECONDS = 300;
const ADMISSION_SECONDS = 900;
const MAX_PENDING_FLOWS = 10000;
const STATE_COOKIE = 'mua_state';
const SESSION_COOKIE = 'mua_admission';

export interface MuaOAuthConfig {
  clientId: string;
  clientSecretEnv: string;
}
export interface MuaLoginServices {
  schools: Record<string, School>;
  mail: (email: string, code: string) => Promise<void>;
  signIn: (account: Account) => Authentication;
}
interface Identity {
  subject: string;
  account: string | null;
  state: MuaIdentityState;
  nickname: string | null;
  email: string | null;
}
interface Admission extends Identity {
  revision: number | null;
  cookie: string;
}

export function muaSubject(user: Record<string, unknown>): string {
  const subject = field(user.sub);
  requireThat(/^[A-Z0-9]{1,16}:[^\s:]{1,128}$/.test(subject), 'Invalid MUA subject');
  return subject;
}
function cookie(request: FastifyRequest, name: string) {
  return request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(name + '='))
    ?.slice(name.length + 1);
}

export function registerMuaLogin(
  app: FastifyInstance,
  db: Store,
  oauth: MuaOAuthConfig,
  root: string,
  origin: string,
  identity: LocalIdentity,
  fetchJson: (path: string, init?: RequestInit) => Promise<Record<string, unknown>>,
  services: MuaLoginServices,
) {
  const callback = origin + '/api/mua/callback';
  const clientSecret = process.env[oauth.clientSecretEnv];
  requireThat(clientSecret && oauth.clientId, 'MUA client credentials not configured');
  const secure = new URL(origin).protocol === 'https:' ? '; Secure' : '';
  const putCookie = (reply: FastifyReply, name: string, value: string, lifetime: number) => {
    const previous = reply.getHeader('Set-Cookie');
    const cookies = Array.isArray(previous)
      ? previous.map(String)
      : previous
        ? [String(previous)]
        : [];
    reply.header('Set-Cookie', [
      ...cookies,
      `${name}=${value}; HttpOnly; SameSite=Lax; Path=/api/mua; Max-Age=${lifetime}${secure}`,
    ]);
  };
  const sameOrigin = (request: FastifyRequest) =>
    requireThat(request.headers.origin === origin, 'Same-origin browser request required');
  const browser = (request: FastifyRequest) => {
    const token = bearer(request.headers.authorization);
    const account = db.token(token, undefined, now());
    const source = db.db.prepare('SELECT client FROM tokens WHERE hash=?').get(digest(token)) as
      | { client: string }
      | undefined;
    requireThat(
      source && !source.client.startsWith(OAUTH_TOKEN_CLIENT_PREFIX),
      'Browser sign-in required',
    );
    requireThat(!db.oauthSession(token), 'Browser sign-in required');
    identity.authenticate(account.id);
    return { token, account };
  };
  const admission = (request: FastifyRequest): Admission => {
    const value = cookie(request, SESSION_COOKIE);
    requireThat(value, 'MUA sign-in expired');
    const row = db.db
      .prepare(`SELECT a.cookie,a.revision,i.subject,i.account,i.state,i.nickname,i.email
      FROM mua_admissions a JOIN mua_identities i ON i.subject=a.subject WHERE a.cookie=? AND a.expires>?`)
      .get(digest(value), now()) as Admission | undefined;
    requireThat(row && row.state !== 'detached', 'MUA sign-in expired');
    if (row.account) {
      const account = db.account('id', row.account);
      requireThat(
        account && account.credential_revision === row.revision,
        'Credentials changed; sign in again',
      );
      identity.authenticate(account.id);
    }
    return row;
  };
  const start = (request: FastifyRequest, reply: FastifyReply, token: string | null) => {
    sameOrigin(request);
    const state = secret(),
      proof = secret();
    db.transaction(() => {
      db.db
        .prepare('DELETE FROM mua_flows WHERE expires<=? OR cookie=?')
        .run(now(), digest(cookie(request, STATE_COOKIE) ?? ''));
      const count = db.db.prepare('SELECT COUNT(*) n FROM mua_flows').get() as { n: number };
      requireThat(count.n < MAX_PENDING_FLOWS, 'Too many pending MUA requests');
      db.db
        .prepare('INSERT INTO mua_flows VALUES(?,?,?,?)')
        .run(digest(state), digest(proof), token ? digest(token) : null, now() + FLOW_SECONDS);
    });
    putCookie(reply, STATE_COOKIE, proof, FLOW_SECONDS);
    const url = new URL(root + '/oauth2/authorize');
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: oauth.clientId,
      redirect_uri: callback,
      state,
    }).toString();
    return { url: url.href };
  };
  app.post(
    '/api/mua/login',
    { config: { rateLimit: { max: 10, timeWindow: 60000 } } },
    async (request, reply) => start(request, reply, null),
  );
  app.post('/api/mua/link', async (request, reply) =>
    start(request, reply, browser(request).token),
  );

  app.get('/api/mua/callback', async (request, reply) => {
    const query = record(request.query),
      state = field(query.state);
    const proof = cookie(request, STATE_COOKIE);
    requireThat(proof, 'Invalid OAuth state');
    const flow = db.transaction(() => {
      const row = db.db
        .prepare('SELECT token FROM mua_flows WHERE state=? AND cookie=? AND expires>?')
        .get(digest(state), digest(proof), now()) as { token: string | null } | undefined;
      requireThat(row, 'Invalid OAuth state');
      db.db.prepare('DELETE FROM mua_flows WHERE state=?').run(digest(state));
      return row;
    });
    putCookie(reply, STATE_COOKIE, '', 0);
    if (query.error !== undefined) return reply.redirect('/portal/?mua=denied');
    const response = await fetchJson('/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: oauth.clientId,
        client_secret: clientSecret,
        redirect_uri: callback,
        code: field(query.code, 4096),
      }),
    });
    const user = await fetchJson('/oauth2/user', {
      headers: { Authorization: 'Bearer ' + field(response.access_token, 8192) },
    });
    const subject = muaSubject(user),
      nickname = field(user.nickname, 256),
      email = field(user.email, 254);
    const value = secret();
    db.transaction(() => {
      const current = db.db
        .prepare('SELECT subject,account,state,nickname,email FROM mua_identities WHERE subject=?')
        .get(subject) as Identity | undefined;
      let account: Account | undefined;
      if (flow.token) {
        const live = db.db
          .prepare('SELECT account FROM tokens WHERE hash=? AND expires>?')
          .get(flow.token, now()) as { account: string } | undefined;
        requireThat(live, 'Link authorization expired');
        account = db.account('id', live.account);
        requireThat(account, 'Link authorization expired');
        identity.authenticate(account.id);
        requireThat(
          !current?.account || current.account === account.id,
          'MUA identity belongs to another account',
          409,
        );
        const attached = db.db
          .prepare("SELECT subject FROM mua_identities WHERE account=? AND state='linked'")
          .get(account.id) as { subject: string } | undefined;
        requireThat(
          !attached || attached.subject === subject,
          'Unlink before replacing an identity',
        );
      } else if (current?.account) {
        requireThat(current.state === 'linked', 'Reconnect MUA from your local account');
        account = db.account('id', current.account);
        requireThat(account, 'Account unavailable');
        identity.authenticate(account.id);
      }
      db.db
        .prepare(`INSERT INTO mua_identities(subject,account,state,nickname,email,verified_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(subject) DO UPDATE SET account=excluded.account,state=excluded.state,nickname=excluded.nickname,email=excluded.email,verified_at=excluded.verified_at`)
        .run(subject, account?.id ?? null, account ? 'linked' : 'pending', nickname, email, now());
      db.db.prepare('DELETE FROM mua_admissions WHERE expires<=?').run(now());
      const count = db.db.prepare('SELECT COUNT(*) n FROM mua_admissions').get() as { n: number };
      requireThat(count.n < MAX_PENDING_FLOWS, 'Too many pending MUA sign-ins');
      db.db
        .prepare('INSERT INTO mua_admissions VALUES(?,?,?,?)')
        .run(
          digest(value),
          subject,
          account?.credential_revision ?? null,
          now() + ADMISSION_SECONDS,
        );
      if (account)
        appendAudit(
          db,
          account.id,
          'global',
          flow.token ? 'mua.identity.link' : 'mua.signin',
          'mua:' + subject,
          {},
        );
    });
    putCookie(reply, SESSION_COOKIE, value, ADMISSION_SECONDS);
    return reply.redirect('/portal/?mua=login');
  });
  app.get(
    '/api/mua/session',
    { schema: { response: { 200: muaAdmissionSchema } } },
    async (request): Promise<MuaAdmission> => {
      const row = admission(request);
      return {
        status: row.account ? 'ready' : 'enrollment',
        subject: row.subject,
        nickname: row.nickname,
        email: row.email,
      };
    },
  );
  app.post('/api/mua/session', async (request, reply) => {
    sameOrigin(request);
    const result = db.transaction(() => {
      const row = admission(request);
      requireThat(row.account, 'Verify your school email first');
      const account = db.account('id', row.account);
      requireThat(account, 'Account unavailable');
      db.db.prepare('DELETE FROM mua_admissions WHERE cookie=?').run(row.cookie);
      return services.signIn(account);
    });
    putCookie(reply, SESSION_COOKIE, '', 0);
    return result;
  });
  app.post<{ Body: MuaEnrollment }>(
    '/api/mua/enrollment/start',
    {
      schema: { body: muaEnrollmentSchema },
      config: { rateLimit: { max: 5, timeWindow: 3600000 } },
    },
    async (request, reply) => {
      sameOrigin(request);
      const row = admission(request);
      requireThat(row.state === 'pending', 'MUA identity already enrolled');
      const email = request.body.email.trim().toLowerCase(),
        school = services.schools[request.body.school];
      requireThat(
        school &&
          email.split('@').length === 2 &&
          school.emailDomains.some((domain) => domain.toLowerCase() === email.split('@')[1]),
        'Unsupported school email',
      );
      requireThat(!db.account('email', email), 'Sign in to your existing account to link MUA', 409);
      requireThat(!db.profileNamed(request.body.name), 'Profile name already in use', 409);
      db.rate('mua-enrollment:' + digest(email), now(), 3, 3600000);
      const code = secret();
      const account: Account = {
        id: accountId(),
        name: request.body.name,
        email,
        school: request.body.school,
        password: null,
        verified_at: 0,
      };
      db.db
        .prepare(
          'INSERT INTO mua_enrollments VALUES(?,?,?,?) ON CONFLICT(cookie) DO UPDATE SET code=excluded.code,payload=excluded.payload,expires=excluded.expires',
        )
        .run(row.cookie, digest(code), JSON.stringify(account), now() + ADMISSION_SECONDS);
      await services.mail(email, code);
      return reply.code(202).send({ message: 'Verification email sent' });
    },
  );
  app.post<{ Body: MuaEnrollmentConfirmation }>(
    '/api/mua/enrollment/confirm',
    { schema: { body: muaEnrollmentConfirmationSchema } },
    async (request, reply) => {
      sameOrigin(request);
      const row = admission(request);
      db.rate('mua-enrollment-confirm:' + row.cookie, now(), 10, ADMISSION_SECONDS);
      db.transaction(() => {
        const live = admission(request);
        requireThat(live.state === 'pending', 'MUA identity already enrolled');
        const saved = db.db
          .prepare('SELECT payload FROM mua_enrollments WHERE cookie=? AND code=? AND expires>?')
          .get(live.cookie, digest(request.body.code), now()) as { payload: string } | undefined;
        requireThat(saved, 'Invalid or expired verification');
        const account = JSON.parse(saved.payload) as Account;
        requireThat(
          !db.account('email', account.email),
          'Sign in to your existing account to link MUA',
          409,
        );
        requireThat(!db.profileNamed(account.name), 'Profile name already in use', 409);
        db.db
          .prepare(
            'INSERT INTO accounts(id,name,email,school,password,verified_at) VALUES(?,?,?,?,NULL,?)',
          )
          .run(account.id, account.name, account.email, account.school, now());
        identity.enrollVerifiedEmail(account.id, services.schools);
        db.db
          .prepare(
            "UPDATE mua_identities SET account=?,state='linked' WHERE subject=? AND state='pending'",
          )
          .run(account.id, live.subject);
        db.db
          .prepare('DELETE FROM mua_admissions WHERE subject=? AND cookie!=?')
          .run(live.subject, live.cookie);
        db.db
          .prepare(
            'UPDATE mua_admissions SET revision=(SELECT credential_revision FROM accounts WHERE id=?) WHERE cookie=?',
          )
          .run(account.id, live.cookie);
        db.db.prepare('DELETE FROM mua_enrollments WHERE cookie=?').run(live.cookie);
        db.db.prepare('UPDATE mua_sync SET revision=revision+1,attempts=0,next=0 WHERE id=1').run();
        appendAudit(db, account.id, 'global', 'mua.identity.enroll', 'mua:' + live.subject, {});
      });
      return reply.code(204).send();
    },
  );
  app.get('/api/mua/link', async (request) => {
    const { account } = browser(request);
    const link = db.db
      .prepare("SELECT subject,verified_at FROM mua_identities WHERE account=? AND state='linked'")
      .get(account.id);
    return { link: link ?? null, evidence: link ? 'mua_account_only' : null };
  });
  app.delete('/api/mua/link', async (request, reply) => {
    sameOrigin(request);
    const { account } = browser(request);
    requireThat(
      account.password !== null ||
        db.db.prepare('SELECT 1 FROM passkeys WHERE account=? LIMIT 1').get(account.id),
      'Set a local password or passkey before unlinking MUA',
    );
    db.transaction(() => {
      db.db
        .prepare(
          'DELETE FROM mua_admissions WHERE subject IN (SELECT subject FROM mua_identities WHERE account=?)',
        )
        .run(account.id);
      db.db
        .prepare("UPDATE mua_identities SET state='detached' WHERE account=? AND state='linked'")
        .run(account.id);
      db.revokeSessions(account.id);
      appendAudit(db, account.id, 'global', 'mua.identity.unlink', account.id, {});
    });
    return reply.code(204).send();
  });
}
