import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import {
  Store,
  requireThat,
  Rejected,
  digest,
  now,
  secret,
  verifyPassword,
  type Account,
} from './store.js';
import { bearer, field, record } from './validate.js';
const CHALLENGE_SECONDS = 300;
const MAX_PASSKEYS = 8;
const COOKIE = 'jlucraft_passkey';
type Credential = {
  id: string;
  account: string;
  public_key: Uint8Array;
  counter: number;
  name: string;
};
export function registerPasskeys(
  app: FastifyInstance,
  db: Store,
  origin: string,
  authorize: (a: Account) => Promise<void>,
) {
  const rpID = new URL(origin).hostname;
  db.db
    .exec(`CREATE TABLE IF NOT EXISTS passkeys(id TEXT PRIMARY KEY,account TEXT NOT NULL REFERENCES accounts(id),public_key BLOB NOT NULL,counter INTEGER NOT NULL,name TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS passkey_challenges(cookie TEXT PRIMARY KEY,challenge TEXT NOT NULL,kind TEXT NOT NULL,token TEXT REFERENCES tokens(hash) ON DELETE CASCADE,expires INTEGER NOT NULL);`);
  const token = (req: FastifyRequest) => {
    return bearer(req.headers.authorization);
  };
  const cookie = (req: FastifyRequest) =>
    req.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(COOKIE + '='))
      ?.slice(COOKIE.length + 1) ?? '';
  const originCheck = (req: FastifyRequest) =>
    requireThat(req.headers.origin === origin, 'Origin mismatch');
  const putCookie = (reply: FastifyReply, value: string, age: number) =>
    reply.header(
      'Set-Cookie',
      `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/api/passkeys; Max-Age=${age}${origin.startsWith('https:') ? '; Secure' : ''}`,
    );
  const begin = (
    req: FastifyRequest,
    reply: FastifyReply,
    challenge: string,
    kind: string,
    session?: string,
  ) => {
    const value = secret();
    db.transaction(() => {
      db.db
        .prepare('DELETE FROM passkey_challenges WHERE expires<=? OR cookie=?')
        .run(now(), digest(cookie(req)));
      db.db
        .prepare('INSERT INTO passkey_challenges VALUES(?,?,?,?,?)')
        .run(
          digest(value),
          challenge,
          kind,
          session ? digest(session) : null,
          now() + CHALLENGE_SECONDS,
        );
    });
    putCookie(reply, value, CHALLENGE_SECONDS);
  };
  const consume = (
    req: FastifyRequest,
    reply: FastifyReply,
    kind: string,
    session?: string,
  ) => {
    originCheck(req);
    putCookie(reply, '', 0);
    return db.transaction(() => {
      const row = db.db
        .prepare(
          'SELECT * FROM passkey_challenges WHERE cookie=? AND expires>?',
        )
        .get(digest(cookie(req)), now()) as
        { challenge: string; kind: string; token: string | null } | undefined;
      db.db
        .prepare('DELETE FROM passkey_challenges WHERE cookie=?')
        .run(digest(cookie(req)));
      requireThat(
        row &&
          row.kind === kind &&
          row.token === (session ? digest(session) : null),
        'Challenge expired',
      );
      return row.challenge;
    });
  };
  app.get('/api/passkeys', async (req) => {
    const a = db.token(token(req), undefined, now());
    return {
      items: db.db
        .prepare(
          'SELECT id,name,created FROM passkeys WHERE account=? ORDER BY created',
        )
        .all(a.id),
    };
  });
  app.post('/api/passkeys/register/options', async (req, reply) => {
    originCheck(req);
    const session = token(req),
      a = db.token(session, undefined, now()),
      b = record(req.body);
    db.rate(`passkey-register:${a.id}`, now(), 5, 60);
    requireThat(
      await verifyPassword(field(b.password, 1024), a.password),
      'Invalid credentials',
    );
    const keys = db.db
      .prepare('SELECT id FROM passkeys WHERE account=?')
      .all(a.id) as { id: string }[];
    requireThat(keys.length < MAX_PASSKEYS, 'Passkey limit reached');
    const options = await generateRegistrationOptions({
      rpName: 'JLUCraft',
      rpID,
      userID: new TextEncoder().encode(a.id),
      userName: a.email,
      attestationType: 'none',
      excludeCredentials: keys,
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    });
    // Password verification and options generation are asynchronous; recheck this session.
    db.token(session, undefined, now());
    begin(req, reply, options.challenge, 'register', session);
    return options;
  });
  app.post('/api/passkeys/register/verify', async (req, reply) => {
    const session = token(req),
      a = db.token(session, undefined, now()),
      b = record(req.body);
    const challenge = consume(req, reply, 'register', session);
    let result;
    try {
      result = await verifyRegistrationResponse({
        response: record(b.response) as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch {
      throw new Rejected('Passkey verification failed');
    }
    requireThat(
      result.verified && result.registrationInfo,
      'Passkey verification failed',
    );
    const name = field(b.name, 80).trim();
    requireThat(name.length > 0);
    await authorize(a);
    db.transaction(() => {
      db.token(session, undefined, now());
      const { n } = db.db
        .prepare('SELECT COUNT(*) n FROM passkeys WHERE account=?')
        .get(a.id) as { n: number };
      requireThat(n < MAX_PASSKEYS);
      const c = result.registrationInfo!.credential;
      requireThat(
        !db.db.prepare('SELECT 1 FROM passkeys WHERE id=?').get(c.id),
        'Passkey already registered',
      );
      db.db
        .prepare('INSERT INTO passkeys VALUES(?,?,?,?,?,?)')
        .run(c.id, a.id, Buffer.from(c.publicKey), c.counter, name, now());
    });
    return { ok: true };
  });
  app.post('/api/passkeys/login/options', async (req, reply) => {
    originCheck(req);
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
    });
    begin(req, reply, options.challenge, 'login');
    return options;
  });
  app.post('/api/passkeys/login/verify', async (req, reply) => {
    const challenge = consume(req, reply, 'login'),
      response = record(
        record(req.body).response,
      ) as unknown as AuthenticationResponseJSON;
    const c = db.db
      .prepare('SELECT * FROM passkeys WHERE id=?')
      .get(field(response.id, 2048)) as Credential | undefined;
    requireThat(c, 'Passkey verification failed');
    const a = db.account('id', c.account);
    requireThat(a);
    requireThat(
      response.response?.userHandle &&
        Buffer.from(response.response.userHandle, 'base64url').toString() ===
          a.id,
      'Passkey user mismatch',
    );
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: c.id,
          publicKey: new Uint8Array(c.public_key),
          counter: c.counter,
        },
      });
    } catch {
      throw new Rejected('Passkey verification failed');
    }
    requireThat(result.verified);
    await authorize(a);
    const accessToken = db.transaction(() => {
      const updated = db.db
        .prepare('UPDATE passkeys SET counter=? WHERE id=? AND counter=?')
        .run(result.authenticationInfo.newCounter, c.id, c.counter);
      requireThat(updated.changes === 1, 'Passkey changed; retry');
      return db.mint(a.id, secret(), now());
    });
    return {
      accessToken,
      selectedProfile: { id: db.profileId(a), name: a.name },
    };
  });
  app.delete('/api/passkeys/:id', async (req, reply) => {
    originCheck(req);
    const session = token(req),
      a = db.token(session, undefined, now());
    db.rate(`passkey-delete:${a.id}`, now(), 5, 60);
    requireThat(
      await verifyPassword(field(record(req.body).password, 1024), a.password),
      'Invalid credentials',
    );
    db.token(session, undefined, now());
    db.db
      .prepare('DELETE FROM passkeys WHERE id=? AND account=?')
      .run(field(record(req.params).id, 2048), a.id);
    return reply.code(204).send();
  });
}
