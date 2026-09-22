import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {registerMemberFeatures} from './mua-member.js';
import { boundedValue, boundedJson, field, record } from './validate.js';
import { Store, digest, requireThat, secret } from './store.js';

export interface MuaConfig {
  apiRoot: string;
  /** Explicit administrator pin; never learn this key from an incoming request. */
  hostPublicKey: string;
  oauth?: { clientId: string; clientSecretEnv: string };
  member?: { keyEnv: string; adminAccounts?:string[]; oauthSigningKey?:string };
}


/** OAuth subjects are opaque CODE:ID values. Email and nickname are NOT identifiers. */
export function muaSubject(user: Record<string, unknown>): string {
  const subject = field(user.sub);
  requireThat(/^[A-Z0-9]{1,16}:[^\s:]{1,128}$/.test(subject), 'Invalid MUA subject');
  return subject;
}

export function yggdrasilRoot(apiRoot: string, mode: 'all' | 'only' | 'excludes', codes: string[] = []): string {
  const base = new URL(apiRoot);
  requireThat(base.protocol === 'https:' && !base.username && !base.password && !base.search && !base.hash);
  requireThat(mode === 'all' ? codes.length === 0 : codes.length > 0);
  requireThat(codes.length <= 128 && codes.every(code => /^[A-Z0-9]{1,16}$/.test(code)));
  return `${apiRoot.replace(/\/$/, '')}/yggdrasil${mode === 'all' ? '' : `/${mode}/${[...new Set(codes)].sort().join('_')}`}`;
}

/** Matches UnionHostVerify.php: exact body || timestamp || nonce, RSA-SHA256. */
export function verifyHost(db: Store, publicKey: string, raw: Buffer, headers: Record<string, unknown>, now: number): void {
  const timestamp = field(headers['x-message-timestamp'], 20);
  const nonce = field(headers['x-message-nonce'], 256);
  const signature = field(headers['x-message-signature'], 4096);
  requireThat(/^\d+(\.\d+)?$/.test(timestamp));
  requireThat(Number(timestamp) >= now - 10 && Number(timestamp) <= now + 30, 'Expired MUA request');
  requireThat(verify('RSA-SHA256', Buffer.concat([raw, Buffer.from(timestamp + nonce)]), publicKey, Buffer.from(signature, 'base64')), 'Invalid MUA signature');
  db.transaction(() => {
    db.db.prepare('DELETE FROM mua_nonces WHERE expires<=?').run(now);
    requireThat(!db.db.prepare('SELECT 1 FROM mua_nonces WHERE nonce=?').get(digest(nonce)), 'Replayed MUA request');
    db.db.prepare('INSERT INTO mua_nonces VALUES(?,?)').run(digest(nonce), now + 60);
  });
}

export async function registerMua(app: FastifyInstance, db: Store, config: MuaConfig, origin: string, fetcher: typeof fetch = fetch) {
  yggdrasilRoot(config.apiRoot, 'all');
  requireThat(createPublicKey(config.hostPublicKey).asymmetricKeyType === 'rsa');
  db.db.exec(`CREATE TABLE IF NOT EXISTS mua_state(name TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mua_nonces(nonce TEXT PRIMARY KEY,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mua_links(account TEXT PRIMARY KEY REFERENCES accounts(id),subject TEXT UNIQUE NOT NULL,verified_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mua_oauth(state TEXT PRIMARY KEY,cookie TEXT NOT NULL,token TEXT NOT NULL REFERENCES tokens(hash) ON DELETE CASCADE,expires INTEGER NOT NULL);`);
  const now = () => Math.floor(Date.now() / 1000);
  const root = config.apiRoot.replace(/\/$/, '');
  const fetchJson = async (path: string, init?: RequestInit) => boundedJson(await fetcher(`${root}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) }));

  const stored=(name:string)=> (db.db.prepare('SELECT value FROM mua_state WHERE name=?').get(name) as {value:string}|undefined)?.value;
  const save=(name:string,value:string)=>db.db.prepare('INSERT OR REPLACE INTO mua_state VALUES(?,?)').run(name,value);
  const memberKey=()=>{const key=stored('memberKey')??(config.member?process.env[config.member.keyEnv]:undefined);requireThat(key,'Member key missing');return key;};
  const memberFetch=async(path:string,init:RequestInit={})=>{
    requireThat(config.member,'Member integration not configured');
    const key=memberKey();
    const response=await fetcher(`${root}${path}`,{...init,headers:{...init.headers,'X-Union-Member-Key':key},redirect:'error',signal:AbortSignal.timeout(5000)});
    if(response.status===204)return {};
    return boundedValue(response);
  };
  app.get('/api/union/member',async(_req,reply)=>{reply.header('Access-Control-Allow-Origin','*');return {yggdrasilApiVersion:'jlucraft-0.2.0',serverListVersion:stored('serverListVersion')??null,privateKeyVersion:stored('privateKeyVersion')??null,enabledFeatures:['emailVerification',...(config.member?['unionBlacklist']:[]),...(config.member?.oauthSigningKey?['unionOAuth2']:[])]};});
  let synchronizing:Promise<void>|undefined;
  const performSync=async()=>{
    const revision=(db.db.prepare('SELECT revision FROM mua_sync WHERE id=1').get() as {revision:number}).revision;
    const accounts=db.db.prepare('SELECT * FROM accounts LIMIT 10001').all() as unknown as import('./store.js').Account[];
    requireThat(accounts.length<=10000,'Too many profiles for one sync');
    const profileList=Object.fromEntries(accounts.map(a=>[db.profileId(a),a.name]));
    requireThat(Buffer.byteLength(JSON.stringify(profileList))<=1024*1024,'Profile sync exceeds supported size');
    await memberFetch('/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profileList})});
    db.db.prepare('UPDATE mua_sync SET synced=?,attempts=0,next=0 WHERE id=1').run(revision);
  };
  const synchronize=()=>{
    if(!synchronizing)synchronizing=performSync().finally(()=>{synchronizing=undefined;});
    return synchronizing;
  };
  if(config.member){
    let inFlight:Promise<void>|undefined;
    let stopping=false;
    const timer=setInterval(()=>{
      if(stopping||inFlight)return;
      const job=db.db.prepare('SELECT revision,synced,attempts,next FROM mua_sync WHERE id=1').get() as {revision:number;synced:number;attempts:number;next:number};
      if(job.revision===job.synced||job.attempts>=12||job.next>now())return;
      inFlight=synchronize().catch(()=>{
        const attempts=job.attempts+1;
        db.db.prepare('UPDATE mua_sync SET attempts=?,next=? WHERE id=1').run(attempts,now()+Math.min(300,5*2**attempts));
        app.log.warn({attempt:attempts},'MUA profile synchronization deferred');
      }).finally(()=>{inFlight=undefined;});
    },5000);
    timer.unref();
    app.addHook('preClose',async()=>{stopping=true;clearInterval(timer);await inFlight;});
  }

  // Encapsulation preserves exact bytes without changing normal JSON route parsers.
  await app.register(async scope => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    scope.addHook('preHandler',async req=>{
      const raw=req.method==='GET'?Buffer.alloc(0):req.body;requireThat(Buffer.isBuffer(raw));verifyHost(db,config.hostPublicKey,raw,req.headers,now());
    });
    if(config.member){
      scope.get('/api/union/member/queryemail',async(req,reply)=>{const query=record(req.query);const account=db.account('name',field(query.username,16));return account?{email:account.email}:reply.code(204).send();});
      scope.post('/api/union/member/updatebackendkey',async(req,reply)=>{
        const body=record(JSON.parse((req.body as Buffer).toString('utf8')));
        save('memberKey',field(body.key,4096));db.db.prepare('UPDATE mua_sync SET attempts=0,next=0 WHERE id=1').run();return reply.code(204).send();
      });
      scope.post('/api/union/member/updatelist',async(_req,reply)=>{
        const response=record(await memberFetch('/serverlist'));requireThat(response.servers!==null&&typeof response.servers==='object');
        const servers=Object.values(response.servers as object);requireThat(servers.length<=1024);
        for(const entry of servers){const server=record(entry);const url=new URL(field(server.bs_root,2048));requireThat(url.protocol==='https:'&&!url.username&&!url.password);}
        requireThat(typeof response.version==='number'||typeof response.version==='string');
        db.transaction(()=>{save('servers',JSON.stringify(response.servers));save('serverListVersion',String(response.version));});return reply.code(204).send();
      });
      scope.post('/api/union/member/updateprivatekey',async(_req,reply)=>{
        const response=record(await memberFetch('/privatekey'));const pem=field(response.privateKey,16384);const key=createPrivateKey(pem);
        requireThat(key.asymmetricKeyType==='rsa'&&(key.asymmetricKeyDetails?.modulusLength??0)>=2048);
        requireThat(typeof response.privateKeyVersion==='number'||typeof response.privateKeyVersion==='string');
        db.transaction(()=>{save('textureKey',pem);save('privateKeyVersion',String(response.privateKeyVersion));});return reply.code(204).send();
      });
      scope.post('/api/union/member/sync',async(_req,reply)=>{await synchronize();return reply.code(204).send();});
      scope.post('/api/union/member/remapuuid',async(req,reply)=>{
        const body=record(JSON.parse((req.body as Buffer).toString('utf8')));const mapped=record(body.remapped_uuid);
        const entries=Object.entries(mapped);requireThat(entries.length<=1024&&entries.every(([old,value])=>/^[a-f0-9]{32}$/.test(old)&&typeof value==='string'&&/^[a-f0-9]{32}$/.test(value)));
        db.remapProfiles(mapped as Record<string,string>);return reply.code(204).send();
      });
    }
    scope.post('/api/union/member/diagnose', async req => {
      const body = record(JSON.parse((req.body as Buffer).toString('utf8')));
      return { nonce: body.nonce, timestamp: Date.now() / 1000 };
    });
  });

  if(config.member)await registerMemberFeatures(app,db,config,origin,memberFetch,memberKey,fetchJson);
  if (!config.oauth) return;
  const oauth = config.oauth;
  const callback = `${origin}/api/mua/callback`;
  const cookieOptions = `HttpOnly; SameSite=Lax; Path=/api/mua; Max-Age=300${new URL(origin).protocol === 'https:' ? '; Secure' : ''}`;
  app.post('/api/mua/link', async (req, reply) => {
    const header = field(req.headers.authorization, 2048); requireThat(header.startsWith('Bearer '));
    const token = header.slice(7); db.token(token, undefined, now());
    const state = secret(), cookie = secret();
    db.transaction(() => {
      db.db.prepare('DELETE FROM mua_oauth WHERE expires<=? OR token=?').run(now(), digest(token));
      db.db.prepare('INSERT INTO mua_oauth VALUES(?,?,?,?)').run(digest(state), digest(cookie), digest(token), now() + 300);
    });
    const url = new URL(`${root}/oauth2/authorize`);
    url.search = new URLSearchParams({ response_type: 'code', client_id: oauth.clientId, redirect_uri: callback, state }).toString();
    reply.header('Set-Cookie', `mua_state=${cookie}; ${cookieOptions}`).header('Cache-Control', 'no-store');
    return { url: url.toString() };
  });
  app.get('/api/mua/callback', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const query = record(req.query), state = field(query.state), code = field(query.code, 4096);
    const cookie = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('mua_state='))?.slice(10);
    requireThat(cookie);
    const token = db.transaction(() => {
      const row = db.db.prepare('SELECT token FROM mua_oauth WHERE state=? AND cookie=? AND expires>?').get(digest(state), digest(cookie), now()) as { token: string } | undefined;
      requireThat(row, 'Invalid OAuth state');
      db.db.prepare('DELETE FROM mua_oauth WHERE state=?').run(digest(state)); return row.token;
    });
    const clientSecret = process.env[oauth.clientSecretEnv]; requireThat(clientSecret, 'MUA client secret not configured');
    const response = await fetchJson('/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: oauth.clientId, client_secret: clientSecret, redirect_uri: callback, code }) });
    const accessToken = field(response.access_token, 8192);
    const user = await fetchJson('/oauth2/user', { headers: { Authorization: `Bearer ${accessToken}` } });
    const subject = muaSubject(user);
    db.transaction(() => {
      // A logout/expiry during the upstream round trip cancels the operation.
      const live = db.db.prepare('SELECT account FROM tokens WHERE hash=? AND expires>?').get(token, now()) as { account: string } | undefined;
      requireThat(live);
      const existing = db.db.prepare('SELECT subject FROM mua_links WHERE account=?').get(live.account) as {subject: string} | undefined;
      requireThat(!existing || existing.subject === subject, 'Unlink before replacing an identity');
      db.db.prepare('INSERT INTO mua_links VALUES(?,?,?) ON CONFLICT(account) DO UPDATE SET verified_at=excluded.verified_at').run(live.account, subject, now());
    });
    reply.header('Set-Cookie', `mua_state=; ${cookieOptions.replace('Max-Age=300', 'Max-Age=0')}`);
    return reply.redirect('/portal/');
  });
  app.get('/api/mua/link', async req => {
    const header = field(req.headers.authorization, 2048); requireThat(header.startsWith('Bearer '));
    const account = db.token(header.slice(7), undefined, now());
    const link = db.db.prepare('SELECT subject,verified_at FROM mua_links WHERE account=?').get(account.id);
    return { link: link ?? null, evidence: link ? 'mua_account_only' : null };
  });
  app.delete('/api/mua/link', async (req, reply) => {
    const header = field(req.headers.authorization, 2048); requireThat(header.startsWith('Bearer '));
    const account = db.token(header.slice(7), undefined, now());
    db.transaction(() => {
      db.db.prepare('DELETE FROM mua_oauth WHERE token IN (SELECT hash FROM tokens WHERE account=?)').run(account.id);
      db.db.prepare('DELETE FROM mua_links WHERE account=?').run(account.id);
    });
    return reply.code(204).send();
  });
}
