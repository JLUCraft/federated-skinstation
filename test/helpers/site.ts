import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { build, type Config } from '../../server/app.js';
import type { MuaConfig } from '../../server/mua.js';
import type { Authentication } from '../../shared/http.js';
import type { OperationsSettings } from '../../shared/contracts/generated.js';
export type Login = Authentication & Required<Pick<Authentication, 'selectedProfile' | 'user'>>;
export async function site(
  mua?: MuaConfig,
  muaFetch?: typeof fetch,
  organization?: string,
  aiFetch?: typeof fetch,
  operations?: { settings: OperationsSettings; transport: typeof fetch },
) {
  const dir = await mkdtemp(join(tmpdir(), 'jlu-contract-'));
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(join(dir, 'key.pem'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  if (mua?.member?.oauthSigningKey) mua.member.oauthSigningKey = join(dir, 'key.pem');
  if (mua?.member) {
    mua.member.storageKeyEnv = 'JLU_TEST_STORAGE_KEY';
    process.env.JLU_TEST_STORAGE_KEY = randomBytes(32).toString('hex');
  }
  let code = '';
  const config: Config = {
    organization,
    listen: '127.0.0.1',
    port: 0,
    origin: 'https://skin.example.test',
    database: join(dir, 'db'),
    textures: join(dir, 'textures'),
    signingKey: join(dir, 'key.pem'),
    schools: { jlu: { emailDomains: ['school.test'] } },
    smtp: { host: 'unused', port: 465, from: 'test@example.test' },
    mua,
    operations: operations?.settings,
  };
  const create = () =>
    build(config, {
      mail: async (_email: string, value: string) => {
        code = value;
      },
      muaFetch,
      aiFetch,
      operationsFetch: operations?.transport,
    });
  let app = await create().catch(async (error) => {
    await rm(dir, { recursive: true, force: true });
    throw error;
  });
  const post = (url: string, payload: object, remoteAddress = '127.0.0.1') =>
    app.inject({ method: 'POST', url, payload, remoteAddress });
  type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  function requestJson<Result = unknown>(
    login: Login,
    method: Method,
    url: string,
    payload?: object,
    status?: 200,
  ): Promise<Result>;
  function requestJson<Result = unknown>(
    login: Login,
    method: Method,
    url: string,
    payload: object | undefined,
    status: number,
  ): Promise<Result>;
  async function requestJson(
    login: Login,
    method: Method,
    url: string,
    payload?: object,
    status = 200,
  ): Promise<unknown> {
    const response = await app.inject({
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${login.accessToken}` },
    });
    assert.equal(response.statusCode, status, response.body);
    if (status === 200) assert.ok(response.body, 'Expected a JSON response');
    return response.body ? response.json<unknown>() : undefined;
  }
  async function enroll(name: string, remoteAddress = '127.0.0.1') {
    const account = {
      email: name.toLowerCase() + '@school.test',
      name,
      school: 'jlu',
      password: 'password-for-contract-testing',
    };
    const start = await post('/api/email/start', account, remoteAddress);
    if (start.statusCode !== 202) throw new Error(start.body);
    await post('/api/email/confirm', { email: account.email, code }, remoteAddress);
    return (
      await post(
        '/authserver/authenticate',
        {
          username: account.email,
          password: account.password,
          requestUser: true,
        },
        remoteAddress,
      )
    ).json<Login>();
  }
  return {
    get app() {
      return app;
    },
    dir,
    keys,
    config,
    verificationCode: () => code,
    post,
    enroll,
    requestJson,
    restart: async () => {
      await app.close();
      app = await create();
    },
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
