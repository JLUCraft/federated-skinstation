// Run after building the server acceptance-driver example; exercises the real Rust verifier and HTTP adapter.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { build } from '../server/app.js';
import { Store } from '../server/store.js';
const exec = promisify(execFile);
const binary = resolve(process.env.ACCEPTANCE_DRIVER ?? '../federated-server/target/debug/examples/acceptance-driver');
const server = binary;
const directory = await mkdtemp(join(tmpdir(), 'unified-identity-interop-'));
const run = async (...args: string[]) => (await exec(binary, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const file = async (name: string, value: unknown) => { const path = join(directory, name); await writeFile(path, JSON.stringify(value), {mode: 0o600}); return path; };
let host: ReturnType<typeof spawn> | undefined;
let bridge: ReturnType<typeof spawn> | undefined;
let app: Awaited<ReturnType<typeof build>> | undefined;
let index = 0;
try {
  const keys: Record<string, string> = {};
  for (const name of ['chair', 'node', 'verifier', 'member', 'new-phone']) keys[name] = await run('keygen', '--out', join(directory, name + '.key'));
  const founder = JSON.parse(await run('trust', 'founder', '--member', 'chair-person', '--club', 'school', '--peer', keys.chair));
  const genesis = await file('genesis.json', {federation: 'isolated-interop', founders: [founder], quorum: 1});
  const pin = await run('trust', 'digest', '--genesis', genesis);
  const config = await file('node.json', {node: {key: join(directory, 'node.key'), listen: ['/ip4/127.0.0.1/tcp/0']}, services: {identity: {
    genesis, genesis_hash: pin, log: join(directory, 'source.jsonl'), writer: true, source: null, max_staleness_seconds: 60,
  }}});
  host = spawn(server, ['run', '--config', config], {stdio: ['ignore', 'pipe', 'pipe']});
  let diagnostics = ''; host.stderr?.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
  const lines = createInterface({input: host.stdout!});
  const status = await new Promise<{peer: string; addresses: string[]}>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('identity writer startup timed out: ' + diagnostics)), 15_000);
    lines.on('line', line => { try { const value = JSON.parse(line); if (value.peer) { clearTimeout(timer); resolve(value); } } catch {} });
    host!.once('exit', () => { clearTimeout(timer); reject(new Error('identity writer exited: ' + diagnostics)); });
  });
  const cache = ['--genesis', genesis, '--genesis-hash', pin, '--log', join(directory, 'chair-cache.jsonl')];
  const target = ['--key', join(directory, 'chair.key'), '--address', status.addresses[0], '--peer', status.peer];
  const synchronize = async () => JSON.parse(await run('trust', 'sync', ...cache, ...target));
  const sign = async (record: unknown, key: string) => {
    const input = await file(`proposal-${index++}.json`, record), output = join(directory, `signed-${index++}.json`);
    await run('trust', 'sign', '--key', join(directory, key + '.key'), '--record', input, '--out', output);
    return JSON.parse(await readFile(output, 'utf8'));
  };
  const append = async (action: unknown, signers = ['chair']) => {
    await synchronize();
    const input = await file(`action-${index++}.json`, action), output = join(directory, `draft-${index++}.json`);
    await run('trust', 'draft', ...cache, '--action', input, '--out', output);
    let record = JSON.parse(await readFile(output, 'utf8'));
    for (const key of signers) record = await sign(record, key);
    await run('trust', 'submit', ...cache, ...target, '--record', await file(`submit-${index++}.json`, record));
  };
  await append({type: 'authorize_verifier', id: 'skin', club: 'school', device: keys.verifier, evidence: ['institutional_email', 'game_profile']});
  const tokenFile = join(directory, 'bridge-token.json');
  const bridgeConfig = await file('bridge.json', {bind:'127.0.0.1:0', key:join(directory,'verifier.key'), token:tokenFile,
    log:join(directory,'verifier-cache.jsonl'), address:status.addresses[0],peer:status.peer,club:'school',verifier:'skin'});
  bridge = spawn(binary, ['bridge', '--config', bridgeConfig, '--genesis', genesis], {stdio:['ignore','pipe','inherit']});
  const bridgeLines = createInterface({input:bridge.stdout!});
  const endpoint = await new Promise<string>((resolve,reject) => {
    const timer = setTimeout(()=>reject(new Error('bridge startup timeout')),15_000);
    bridgeLines.once('line', line=>{clearTimeout(timer);resolve(JSON.parse(line).url);});
    bridge!.once('exit',()=>{clearTimeout(timer);reject(new Error('bridge exited'));});
  });
  assert.equal((await fetch(endpoint + '/state', {method:'POST'})).status,401);
  const rsa = generateKeyPairSync('rsa', {modulusLength: 2048});
  await writeFile(join(directory, 'textures.pem'), rsa.privateKey.export({type: 'pkcs8', format: 'pem'}), {mode: 0o600});
  let code = '';
  app = await build({listen: '127.0.0.1', port: 0, origin: 'https://skin.example.test', database: join(directory, 'accounts.sqlite'), textures: join(directory, 'textures'), signingKey: join(directory, 'textures.pem'),  smtp: {host: 'unused', port: 465, from: 'test@invalid.test'}, schools: {school: {emailDomains: ['school.test'], identity: {
    endpoint, tokenFile, verifier: 'skin', club: 'school',
  }}}}, {mail: async (_, value) => { code = value; }});
  const account = {email: 'person@school.test', name: 'Person', school: 'school', password: 'isolated-test-password'};
  assert.equal((await app.inject({method: 'POST', url: '/api/email/start', payload: account})).statusCode, 202);
  assert.equal((await app.inject({method: 'POST', url: '/api/email/confirm', payload: {email: account.email, code}})).statusCode, 204);
  const login = (await app.inject({method: 'POST', url: '/authserver/authenticate', payload: {username: account.email, password: account.password, requestUser: true}})).json();
  const db = new Store(join(directory, 'accounts.sqlite'));
  db.db.prepare('UPDATE accounts SET verified_at=1 WHERE email=?').run(account.email); db.close();
  const post = async (url: string, payload: object) => app!.inject({method: 'POST', url, headers: {authorization: 'Bearer ' + login.accessToken}, payload});
  let activeDevice = "member";
  const propose = async (kind: string) => {
    const result = await post('/api/identity/proposal', {holder: keys[activeDevice], kind});
    assert.equal(result.statusCode, 200, result.body); return result.json();
  };
  const membership = await propose('membership');
  const member = membership.action.member;
  assert.equal((await post('/api/identity/confirm', {record: membership})).statusCode, 403);
  const verified = await post('/api/identity/confirm', {record: await sign(membership, 'member')});
  assert.equal(verified.statusCode, 200, verified.body);
  const profile = await propose('profile');
  const bound = await post('/api/identity/confirm', {record: await sign(profile, 'member')});
  assert.equal(bound.statusCode, 200, bound.body);
  await append({type: 'bind_device', member, device: keys['new-phone']}, ['member', 'new-phone']);
  const devicePending = await sign(await propose('profile'), 'member');
  await append({type: 'revoke_device', member, device: keys.member}, ['new-phone']);
  const revokedDevice = await post('/api/identity/confirm', {record: devicePending});
  assert.equal(revokedDevice.statusCode, 403, revokedDevice.body);
  activeDevice = 'new-phone';
  const pending = await sign(await propose('profile'), 'new-phone');
  await append({type: 'revoke_membership', member, club: 'school'});
  const restoration = await post('/api/identity/confirm', {record: pending});
  assert.equal(restoration.statusCode, 403, restoration.body);
  const invalidated = await post('/authserver/validate', {accessToken: login.accessToken});
  assert.equal(invalidated.statusCode, 403, invalidated.body);
  const deniedLogin = await app.inject({method: 'POST', url: '/authserver/authenticate', payload: {username: account.email, password: account.password}});
  assert.equal(deniedLogin.statusCode, 403, deniedLogin.body);
  await app.close(); app = undefined;
  // Skin site is now offline. A chair uses exactly the same log and verifier rules.
  await append({type: 'confirm_member', member, club: 'school', device: null, evidence: 'manual', verifier: null});
  await synchronize();
  const state = JSON.parse(await run('trust', 'inspect', ...cache));
  assert.equal(state.devices[keys['new-phone']], member);
  assert.ok(state.revoked_devices.includes(keys.member));
  assert.ok(state.memberships.some((value: string[]) => value[0] === member && value[1] === 'school'));
  console.log('PASS: actual skin HTTP → Rust log; old verification retained; possession required; explicit revocation enforced; offline manual recovery and stable identity on device replacement.');
} finally {
  await app?.close();
  if (bridge && bridge.exitCode === null) { const exit = once(bridge, 'exit'); bridge.kill('SIGTERM'); await exit; }
  if (host && host.exitCode === null) { const exit = once(host, 'exit'); host.kill('SIGTERM'); await exit; }
  await rm(directory, {recursive: true, force: true});
}
