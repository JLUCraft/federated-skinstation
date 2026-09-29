import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import multipart from '@fastify/multipart';
import { STATUS_CODES } from 'node:http';
import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  randomUUID,
} from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import nodemailer from 'nodemailer';
import { peerIdFromString } from '@libp2p/peer-id';
import {
  Store,
  Rejected,
  requireThat,
  secret,
  digest,
  encodePassword,
  verifyPassword,
  accountId,
  type Account,
} from './store.js';
import { field, record, boundedJson } from './validate.js';
import { createRequire } from 'node:module';

const VERSION = createRequire(import.meta.url)('../package.json')
  .version as string;
import { type School } from './federation.js';
import {
  identityProposal,
  confirmIdentity,
  authorizeAccount,
} from './unified-identity.js';
import { registerMua, type MuaConfig } from './mua.js';
import { registerWardrobe } from './wardrobe.js';
import { registerMicrosoft, type MicrosoftConfig } from './microsoft.js';
import { registerPasskeys } from './passkeys.js';
import { registerProfiles } from './profiles.js';
import { SecretState } from './secret-state.js';

export interface Config {
  trustProxy?: string[];
  listen: string;
  port: number;
  origin: string;
  database: string;
  textures: string;
  signingKey: string;
  schools: Record<string, School>;
  peers: Array<{ origin: string; publicKey: string }>;
  smtp: { host: string; port: number; from: string };
  webRoot?: string;
  mua?: MuaConfig;
  microsoft?: MicrosoftConfig;
}
interface Profile {
  id: string;
  name: string;
  properties?: Array<{ name: string; value: string; signature?: string }>;
}
const now = () => Math.floor(Date.now() / 1000);
const text = field;
const obj = record;
const bearer = (header: unknown) => {
  const value = text(header, 2048);
  requireThat(value.startsWith('Bearer '));
  return value.slice(7);
};
export async function build(
  config: Config,
  dependencies: {
    mail?: (email: string, code: string) => Promise<void>;
    muaFetch?: typeof fetch;
    microsoftFetch?: typeof fetch;
  } = {},
) {
  const origin = new URL(config.origin);
  requireThat(
    origin.protocol === 'https:' ||
      origin.hostname === '127.0.0.1' ||
      origin.hostname === 'localhost',
    'HTTPS origin required',
  );
  requireThat(config.peers.length <= 32);
  for (const peer of config.peers) {
    const url = new URL(peer.origin);
    requireThat(url.protocol === 'https:' || url.hostname === '127.0.0.1');
    createPublicKey(peer.publicKey);
  }
  const key = createPrivateKey(await readFile(config.signingKey));
  requireThat(key.asymmetricKeyType === 'rsa', 'RSA signing key required');
  const secrets = config.mua?.member
    ? SecretState.fromEnvironment(config.mua.member.storageKeyEnv)
    : undefined;
  const db = new Store(config.database);
  await mkdir(config.textures, { recursive: true });
  const app = Fastify({
    trustProxy: config.trustProxy ?? false,
    logger: {
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body'],
      serializers: {
        req: (req) => ({
          method: req.method,
          url: req.url.split('?')[0],
          remoteAddress: req.ip,
        }),
      },
    },
    bodyLimit: 64 * 1024,
  });
  app.addHook('onClose', async () => db.close());
  app.addHook('onSend', async (request, reply, payload) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Authlib-Injector-API-Location', config.origin + '/')
      .header('X-Frame-Options', 'DENY')
      .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (request.url.startsWith('/portal/'))
      reply.header(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: ${config.peers.map((peer) => new URL(peer.origin).origin).join(' ')}; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
      );
    else if (!request.url.startsWith('/textures/'))
      reply.header('Cache-Control', 'no-store');
    return payload;
  });
  const authorize = async (account: Account) => {
    const school = config.schools[account.school];
    requireThat(school);
    await authorizeAccount(db, account, school);
  };
  app.addHook('preHandler', async (req) => {
    if (
      req.url === '/authserver/invalidate' ||
      req.url === '/authserver/signout'
    )
      return;
    const header = req.headers.authorization;
    const body =
      req.body && typeof req.body === 'object'
        ? (req.body as Record<string, unknown>)
        : undefined;
    const token = header?.startsWith('Bearer ')
      ? header.slice(7)
      : typeof body?.accessToken === 'string'
        ? body.accessToken
        : undefined;
    if (token) await authorize(db.token(token, undefined, now()));
  });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    db.db.prepare('SELECT 1').get();
    return { status: 'ok' };
  });
  await app.register(rateLimit, { max: 120, timeWindow: 60_000 });
  await app.register(multipart, {
    limits: {
      files: 1,
      fields: 1,
      parts: 2,
      fileSize: 1024 * 1024,
      fieldSize: 32,
      fieldNameSize: 32,
    },
  });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as { statusCode?: number };
    const status =
      e.statusCode === 429
        ? 429
        : error instanceof Rejected
          ? error.statusCode
          : e.statusCode && e.statusCode < 500
            ? e.statusCode
            : 500;
    reply.code(status).send({
      error:
        error instanceof Rejected
          ? error.code
          : (STATUS_CODES[status] ?? 'Internal Server Error'),
      errorMessage:
        status === 500
          ? 'Service temporarily unavailable'
          : error instanceof Rejected
            ? error.message
            : 'Invalid request.',
    });
  });
  let texturePem: string | undefined;
  let textureSigningKey = key;
  const signingKey = () => {
    if (config.mua?.member) {
      const encrypted = (
        db.db
          .prepare("SELECT value FROM mua_state WHERE name='textureKey'")
          .get() as { value: string } | undefined
      )?.value;
      const pem = encrypted
        ? secrets?.open('textureKey', encrypted)
        : undefined;
      if (pem && pem !== texturePem) {
        textureSigningKey = createPrivateKey(pem);
        texturePem = pem;
      }
    }
    return textureSigningKey;
  };
  const profile = (
    account: Account,
    signed = true,
    id = db.profileId(account),
  ): Profile => {
    const selected = db.ownProfile(account, id);
    const textures: Record<string, unknown> = {};
    const saved = db.textures(account, id);
    for (const texture of saved)
      textures[texture.kind.toUpperCase()] = {
        url: `${config.origin}/textures/${texture.hash}`,
        ...(texture.kind === 'skin'
          ? { metadata: { model: texture.model } }
          : {}),
      };
    const value = Buffer.from(
      JSON.stringify({
        timestamp: Date.now(),
        profileId: selected.id,
        profileName: selected.name,
        textures,
      }),
    ).toString('base64');
    return {
      id: selected.id,
      name: selected.name,
      properties: [
        { name: 'uploadableTextures', value: 'skin,cape' },
        {
          name: 'textures',
          value,
          ...(signed
            ? {
                signature: sign(
                  'RSA-SHA1',
                  Buffer.from(value),
                  signingKey(),
                ).toString('base64'),
              }
            : {}),
        },
      ],
    };
  };
  const loginReply = (
    a: Account,
    token: string,
    client: string,
    requestUser = false,
  ) => ({
    accessToken: token,
    clientToken: client,
    ...(db.selectedProfile(token, a)
      ? {
          selectedProfile: db
            .profiles(a)
            .map(({ id, name }) => ({ id, name }))
            .find((p) => p.id === db.selectedProfile(token, a)),
        }
      : {}),
    availableProfiles: db.profiles(a).map(({ id, name }) => ({ id, name })),
    ...(requestUser ? { user: { id: a.id, properties: [] } } : {}),
  });
  const mail = async (email: string, code: string, purpose: string) => {
    if (dependencies.mail) return dependencies.mail(email, code);
    const transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      requireTLS: true,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    try {
      await transport.sendMail({
        from: config.smtp.from,
        to: email,
        subject: `JLUCraft ${purpose}`,
        text: `${purpose}验证码（15 分钟内有效）：${code}\n若非本人发起，请忽略。`,
      });
    } finally {
      transport.close();
    }
  };
  app.post(
    '/api/password/start',
    { config: { rateLimit: { max: 5, timeWindow: 3600000 } } },
    async (req, reply) => {
      const email = text(obj(req.body).email).toLowerCase();
      const code = db.passwordReset(email, now());
      if (code) await mail(email, code, '重置密码');
      return reply.code(202).send({
        message: 'If the account exists, a verification email has been sent',
      });
    },
  );
  app.post(
    '/api/password/confirm',
    { config: { rateLimit: { max: 10, timeWindow: 900000 } } },
    async (req, reply) => {
      const body = obj(req.body);
      const email = text(body.email).toLowerCase();
      db.resetPassword(
        email,
        text(body.code),
        await encodePassword(text(body.password, 1024)),
        now(),
      );
      return reply.code(204).send();
    },
  );
  registerProfiles(app, db);
  registerPasskeys(app, db, config.origin, authorize);
  registerWardrobe(app, db, {
    origin: config.origin,
    peers: config.peers,
    key,
    save: async (account, item, bytes) => {
      const hash = await saveTexture(
        account,
        item.kind,
        bytes,
        item.model,
        false,
      );
      db.db
        .prepare(
          'UPDATE wardrobe SET title=? WHERE account=? AND kind=? AND hash=? AND model=?',
        )
        .run(item.title, account.id, item.kind, hash, item.model);
    },
  });
  if (config.microsoft)
    await registerMicrosoft(
      app,
      db,
      config.microsoft,
      config.origin,
      authorize,
      dependencies.microsoftFetch,
    );
  app.get('/api/capabilities', async () => ({
    schools: Object.keys(config.schools),
    microsoft: !!config.microsoft,
    muaOAuth: !!config.mua?.oauth,
    muaMember: !!config.mua?.member,
    muaProvider: !!config.mua?.member?.oauthSigningKey,
  }));
  const muaDomains = (): string[] => {
    if (!config.mua?.member) return [];
    const row = db.db
      .prepare("SELECT value FROM mua_state WHERE name='servers'")
      .get() as { value: string } | undefined;
    if (!row) return [];
    return Object.values(
      JSON.parse(row.value) as Record<string, { bs_root: string }>,
    ).map((server) => new URL(server.bs_root).hostname);
  };
  app.get('/', async () => ({
    meta: {
      serverName: 'JLUCraft Federation',
      implementationName: 'federated-skinstation',
      implementationVersion: VERSION,
      links: {
        homepage: config.origin + '/portal/',
        register: config.origin + '/portal/',
      },
    },
    skinDomains: [
      ...new Set([
        origin.hostname,
        ...config.peers.map((p) => new URL(p.origin).hostname),
        ...muaDomains(),
      ]),
    ],
    signaturePublickey: createPublicKey(signingKey()).export({
      type: 'spki',
      format: 'pem',
    }),
  }));
  app.post(
    '/api/email/start',
    { config: { rateLimit: { max: 5, timeWindow: 3600000 } } },
    async (req, reply) => {
      const body = obj(req.body);
      const email = text(body.email).toLowerCase();
      const schoolId = text(body.school);
      const school = config.schools[schoolId];
      requireThat(
        school &&
          school.emailDomains.some(
            (d) =>
              email.split('@').length === 2 &&
              email.split('@')[1] === d.toLowerCase(),
          ),
        'Unsupported school email',
      );
      const password = text(body.password, 1024);
      const name = text(body.name, 16);
      requireThat(/^[a-zA-Z0-9_]+$/.test(name));
      let account = db.account('email', email);
      if (account) {
        requireThat(
          account.school === schoolId &&
            (await verifyPassword(password, account.password)),
        );
      } else {
        account = {
          id: accountId(),
          name,
          email,
          school: schoolId,
          password: await encodePassword(password),
          verified_at: 0,
        };
      }
      const code = db.challenge(account, now());
      await mail(email, code, '学校邮箱验证');
      return reply.code(202).send({ message: 'Verification email sent' });
    },
  );
  app.post('/api/email/confirm', async (req, reply) => {
    const body = obj(req.body);
    db.confirm(text(body.email).toLowerCase(), text(body.code), now());
    return reply.code(204).send();
  });
  app.post(
    '/authserver/authenticate',
    { config: { rateLimit: { max: 20, timeWindow: 60000 } } },
    async (req) => {
      const body = obj(req.body);
      const email = text(body.username).toLowerCase();
      db.rate(`login:${digest(email)}`, now(), 10, 60);
      const a = db.account('email', email);
      requireThat(
        a && (await verifyPassword(text(body.password, 1024), a.password)),
        'Invalid credentials',
      );
      await authorize(a);
      const client =
        body.clientToken === undefined ? accountId() : text(body.clientToken);
      return loginReply(
        a,
        db.transaction(() =>
          db.mint(a.id, client, now(), db.profiles(a).length === 1),
        ),
        client,
        body.requestUser === true,
      );
    },
  );
  app.post('/authserver/refresh', async (req) => {
    const b = obj(req.body);
    const client =
      b.clientToken === undefined ? undefined : text(b.clientToken);
    const result = db.refresh(
      text(b.accessToken),
      client,
      b.selectedProfile ? text(obj(b.selectedProfile).id) : undefined,
      now(),
    );
    return loginReply(
      result.account,
      result.token,
      result.client,
      b.requestUser === true,
    );
  });
  app.post('/authserver/validate', async (req, reply) => {
    const b = obj(req.body);
    db.token(
      text(b.accessToken),
      b.clientToken === undefined ? undefined : text(b.clientToken),
      now(),
    );
    return reply.code(204).send();
  });
  app.post('/authserver/invalidate', async (req, reply) => {
    const b = obj(req.body);
    const token = text(b.accessToken);
    db.invalidate(token);
    return reply.code(204).send();
  });
  app.post('/authserver/signout', async (req, reply) => {
    const b = obj(req.body);
    const email = text(b.username).toLowerCase();
    db.rate(`login:${digest(email)}`, now(), 10, 60);
    const a = db.account('email', email);
    requireThat(
      a && (await verifyPassword(text(b.password, 1024), a.password)),
    );
    db.db.prepare('DELETE FROM tokens WHERE account=?').run(a.id);
    return reply.code(204).send();
  });
  app.post('/sessionserver/session/minecraft/join', async (req, reply) => {
    const b = obj(req.body);
    db.join(
      text(b.accessToken),
      text(b.selectedProfile),
      text(b.serverId, 64),
      now(),
      req.ip,
    );
    return reply.code(204).send();
  });
  app.get('/federation/hasJoined', async (req, reply) => {
    const q = obj(req.query);
    const username = text(q.username, 16),
      serverId = text(q.serverId, 64),
      nonce = text(q.nonce, 128);
    const a = db.joined(
      username,
      serverId,
      now(),
      q.ip === undefined ? undefined : text(q.ip, 64),
    );
    if (!a) return reply.code(204).send();
    await authorize(a);
    const payload = Buffer.from(
      JSON.stringify({
        username,
        serverId,
        nonce,
        expires: now() + 15,
        profile: profile(a, true, db.profileNamed(username)!.profile.id),
      }),
    );
    return {
      payload: payload.toString('base64'),
      signature: sign('RSA-SHA256', payload, key).toString('base64'),
    };
  });
  app.get('/sessionserver/session/minecraft/hasJoined', async (req, reply) => {
    const q = obj(req.query);
    const username = text(q.username, 16),
      serverId = text(q.serverId, 64);
    const local = db.joined(
      username,
      serverId,
      now(),
      q.ip === undefined ? undefined : text(q.ip, 64),
    );
    if (local) await authorize(local);
    const found: Profile[] = local
      ? [profile(local, true, db.profileNamed(username)!.profile.id)]
      : [];
    const responses = await Promise.all(
      config.peers.map(async (peer) => {
        const nonce = secret();
        const url = new URL(`${peer.origin}/federation/hasJoined`);
        url.search = new URLSearchParams({
          username,
          serverId,
          nonce,
          ...(q.ip === undefined ? {} : { ip: text(q.ip, 64) }),
        }).toString();
        const response = await fetch(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        });
        if (response.status === 204) return undefined;
        const proof = await boundedJson(response);
        const payload = Buffer.from(text(proof.payload, 65536), 'base64');
        requireThat(
          verify(
            'RSA-SHA256',
            payload,
            peer.publicKey,
            Buffer.from(text(proof.signature, 4096), 'base64'),
          ),
        );
        const claim = obj(JSON.parse(payload.toString()));
        requireThat(
          claim.username === username &&
            claim.serverId === serverId &&
            claim.nonce === nonce &&
            typeof claim.expires === 'number' &&
            claim.expires >= now() &&
            claim.expires <= now() + 30,
        );
        const p = claim.profile as Profile;
        requireThat(
          p &&
            /^[a-f0-9]{32}$/.test(p.id) &&
            p.name === username &&
            Array.isArray(p.properties),
        );
        for (const property of p.properties ?? []) {
          if (property.name === 'uploadableTextures') continue;
          requireThat(property.name === 'textures');
          const texture = obj(
            JSON.parse(Buffer.from(property.value, 'base64').toString()),
          );
          requireThat(texture.profileId === p.id);
          for (const item of Object.values(obj(texture.textures))) {
            const u = new URL(text(obj(item).url, 2048));
            requireThat(
              u.origin === new URL(peer.origin).origin,
              'Foreign texture origin',
            );
          }
          property.signature = sign(
            'RSA-SHA1',
            Buffer.from(property.value),
            signingKey(),
          ).toString('base64');
        }
        return p;
      }),
    );
    found.push(...responses.filter((p): p is Profile => p !== undefined));
    requireThat(found.length <= 1, 'Ambiguous federated identity');
    return found[0] ?? reply.code(204).send();
  });
  app.get(
    '/sessionserver/session/minecraft/profile/:id',
    async (req, reply) => {
      const a = db.profile(text(obj(req.params).id, 32));
      return a
        ? profile(
            a,
            obj(req.query).unsigned === 'false',
            text(obj(req.params).id, 32),
          )
        : reply.code(204).send();
    },
  );
  for (const path of [
    '/api/profiles/minecraft',
    '/minecraftservices/minecraft/profile/lookup/bulk/byname',
  ])
    app.post(path, async (req) => {
      requireThat(Array.isArray(req.body) && req.body.length <= 100);
      const profiles = req.body
        .map((n) => db.profileNamed(text(n, 16)))
        .filter((a): a is NonNullable<typeof a> => !!a);
      return [
        ...new Map(
          profiles.map(({ profile: p }) => [p.id, { id: p.id, name: p.name }]),
        ).values(),
      ];
    });
  for (const path of [
    '/api/users/profiles/minecraft/:name',
    '/minecraftservices/minecraft/profile/lookup/name/:name',
  ])
    app.get(path, async (req, reply) => {
      const found = db.profileNamed(text(obj(req.params).name, 16));
      return found
        ? { id: found.profile.id, name: found.profile.name }
        : reply.code(204).send();
    });
  app.get('/api/me', async (req) => {
    const a = db.token(bearer(req.headers.authorization), undefined, now());
    return {
      id: a.id,
      profileId: db.profileId(a),
      name: a.name,
      school: a.school,
      verifiedAt: a.verified_at,
      profiles: db
        .profiles(a)
        .map((p) => ({ ...p, textures: db.textures(a, p.id) })),
      textures: db.db
        .prepare('SELECT kind,hash,model FROM profile_textures WHERE account=?')
        .all(a.id),
      muaAdmin: config.mua?.member?.adminAccounts?.includes(a.id) ?? false,
    };
  });
  app.post('/api/identity/proposal', async (req) => {
    const account = db.token(
      bearer(req.headers.authorization),
      undefined,
      now(),
    );
    const body = obj(req.body);
    const holder = text(body.holder);
    try {
      peerIdFromString(holder);
    } catch {
      throw new Rejected('Invalid holder.', 400, 'Bad Request');
    }
    const school = config.schools[account.school];
    requireThat(school);
    requireThat(body.kind === 'membership' || body.kind === 'profile');
    return identityProposal(
      db,
      account,
      holder,
      school,
      body.kind === 'profile',
      body.profileId === undefined
        ? db.profileId(account)
        : db.ownProfile(account, text(body.profileId, 32)).id,
    );
  });
  app.post('/api/identity/confirm', async (req) => {
    const account = db.token(
      bearer(req.headers.authorization),
      undefined,
      now(),
    );
    const school = config.schools[account.school];
    requireThat(school);
    const record = obj(req.body).record;
    const action = obj(obj(record).action);
    const profileId =
      action.type === 'bind_game_profile'
        ? db.ownProfile(account, text(action.profile, 32)).id
        : db.profileId(account);
    return confirmIdentity(db, account, school, record, profileId);
  });
  const saveTexture = async (
    account: Account,
    kind: 'skin' | 'cape',
    input: Buffer,
    model = 'default',
    apply = true,
    profileId = db.profileId(account),
  ) => {
    requireThat(
      input.length >= 24 &&
        input
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    );
    const width = input.readUInt32BE(16),
      height = input.readUInt32BE(20);
    requireThat(
      width > 0 && width <= 1024 && height > 0 && height <= 1024,
      'Invalid texture dimensions',
    );
    const normal =
      width % 64 === 0 &&
      (height === width / 2 || (kind === 'skin' && height === width));
    const padded =
      kind === 'cape' && width % 22 === 0 && height === (width / 22) * 17;
    requireThat(normal || padded, 'Invalid texture dimensions');
    let png: PNG = PNG.sync.read(input, { checkCRC: true });
    if (padded) {
      const scale = width / 22;
      requireThat(64 * scale <= 1024 && 32 * scale <= 1024);
      const canvas = new PNG({ width: 64 * scale, height: 32 * scale });
      PNG.bitblt(png, canvas, 0, 0, width, height, 0, 0);
      png = canvas;
    }
    const bytes = PNG.sync.write(png);
    const hash = (await import('node:crypto'))
      .createHash('sha256')
      .update(bytes)
      .digest('hex');
    await authorize(account);
    const temporary = resolve(config.textures, `${hash}.tmp.${randomUUID()}`);
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
      // Publish complete immutable bytes before creating a database reference.
      // A crash may leave an unreferenced blob, never a reference to partial bytes.
      await rename(temporary, resolve(config.textures, hash));
      db.transaction(() => {
        if (apply) db.setTexture(account, profileId, kind, hash, model);
        db.db
          .prepare(
            'INSERT OR IGNORE INTO wardrobe(id,account,title,kind,hash,model) VALUES(?,?,?,?,?,?)',
          )
          .run(randomUUID(), account.id, '', kind, hash, model);
      });
    } finally {
      await rm(temporary, { force: true });
    }
    return hash;
  };
  for (const method of ['PUT', 'DELETE'] as const)
    app.route({
      method,
      url: '/api/user/profile/:uuid/:kind',
      handler: async (req, reply) => {
        let a: Account;
        try {
          a = db.token(bearer(req.headers.authorization), undefined, now());
        } catch {
          throw new Rejected('Invalid token.', 401, 'Unauthorized');
        }
        const params = obj(req.params);
        db.ownProfile(a, text(params.uuid));
        requireThat(params.kind === 'skin' || params.kind === 'cape');
        const kind = params.kind;
        if (method === 'DELETE')
          db.transaction(() => {
            db.removeTexture(a, text(params.uuid), kind);
          });
        else {
          requireThat(req.isMultipart());
          let file: Buffer | undefined;
          let model = 'default';
          for await (const part of req.parts()) {
            if (part.type === 'file') {
              requireThat(
                part.fieldname === 'file' && part.mimetype === 'image/png',
              );
              file = await part.toBuffer();
            } else {
              requireThat(
                part.fieldname === 'model' &&
                  (part.value === '' ||
                    part.value === 'slim' ||
                    part.value === 'default'),
              );
              model = part.value === 'slim' ? 'slim' : 'default';
            }
          }
          requireThat(file);
          await saveTexture(a, kind, file, model, true, text(params.uuid));
        }
        return reply.code(204).send();
      },
    });
  app.get('/textures/:hash', async (req, reply) => {
    const hash = text(obj(req.params).hash, 64);
    requireThat(/^[0-9a-f]{64}$/.test(hash));
    return reply
      .type('image/png')
      .header('X-Content-Type-Options', 'nosniff')
      .send(await readFile(resolve(config.textures, hash)));
  });
  if (config.mua) {
    try {
      await registerMua(
        app,
        db,
        config.mua,
        config.origin,
        authorize,
        dependencies.muaFetch,
        secrets,
      );
    } catch (error) {
      await app.close();
      throw error;
    }
  }
  if (config.webRoot)
    await app.register(staticFiles, {
      root: resolve(config.webRoot),
      prefix: '/portal/',
    });
  return app;
}
