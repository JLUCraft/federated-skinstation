import {constants,createHmac,createPrivateKey,createPublicKey,publicEncrypt,sign} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {Store,requireThat,digest,secret} from './store.js';
import {field,record} from './validate.js';
import type {MuaConfig} from './mua.js';

const now=()=>Math.floor(Date.now()/1000);
const string=field;
const object=record;
type MemberFetch=(path:string,init?:RequestInit)=>Promise<unknown>;

/** Local ownership is checked before every Union binding request; a UUID is never proof of ownership. */
export async function registerMemberFeatures(app:FastifyInstance,db:Store,config:MuaConfig,origin:string,memberFetch:MemberFetch,memberKey:()=>string,fetchJson:MemberFetch){
  const authenticate=(req:FastifyRequest)=>{
    const header=string(req.headers.authorization,2048);requireThat(header.startsWith('Bearer '));
    return db.token(header.slice(7),undefined,now());
  };
  const admin=(req:FastifyRequest)=>{const a=authenticate(req);requireThat(config.member?.adminAccounts?.includes(a.id),'Administrator required');return a;};
  const post=(path:string,payload:unknown)=>memberFetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  app.get('/api/mua/profiles',async req=>{
    const a=authenticate(req);const uuid=db.profileId(a);
    const [detail,duplicates]=await Promise.all([memberFetch('/profile/detail/'+uuid),memberFetch('/profile/unmapped/byname/'+encodeURIComponent(a.name))]);
    return {uuid,detail,duplicates};
  });
  for(const operation of ['bind','bindto','unbind','remapuuid'] as const)app.post('/api/mua/profiles/'+operation,async req=>{
    const a=authenticate(req);const b=object(req.body);const uuid=db.profileId(a);
    requireThat(b.uuid===undefined||b.uuid===uuid,'Profile is not owned by account');
    const payload=operation==='remapuuid'?{me:uuid,target:string(b.target,32)}:operation==='bindto'?{uuid,token:string(b.token,4096)}:{uuid};
    if(operation==='remapuuid')requireThat(/^[a-f0-9]{32}$/.test((payload as {target:string}).target));
    return post('/profile/'+operation,payload);
  });
  app.get('/api/mua/admin/blacklist',async req=>{
    admin(req);const q=object(req.query);const page=q.page===undefined?1:Number(q.page);
    requireThat(Number.isSafeInteger(page)&&page>=1&&page<=100000);
    const params=new URLSearchParams({page:String(page),q:q.q===undefined?'':string(q.q,256)});
    return memberFetch('/blacklist/query?'+params);
  });
  app.post('/api/mua/admin/blacklist',async req=>{
    admin(req);const b=object(req.body);const email=string(b.email).toLowerCase(),reason=string(b.reason,4096);requireThat(/^[^\s@]+@[^\s@]+$/.test(email));
    return post('/blacklist/restful',{email,reason});
  });
  for(const operation of ['invalidate','delete'] as const)app.post('/api/mua/admin/blacklist/:id/'+operation,async req=>{
    admin(req);const id=string(object(req.params).id,20);requireThat(/^\d+$/.test(id));
    return memberFetch(operation==='invalidate'?'/blacklist/invalidate/'+id:'/blacklist/restful/'+id,{method:operation==='invalidate'?'PUT':'DELETE'});
  });
  app.post('/api/mua/admin/synchronize',async req=>{admin(req);db.db.prepare('UPDATE mua_sync SET revision=revision+1,attempts=0,next=0 WHERE id=1').run();return {queued:true};});
  app.get('/api/mua/admin/status',async req=>{admin(req);return db.db.prepare('SELECT revision,synced,attempts,next FROM mua_sync WHERE id=1').get();});

  if(!config.member?.oauthSigningKey)return;
  const signer=createPrivateKey(await readFile(config.member.oauthSigningKey));
  requireThat(signer.asymmetricKeyType==='rsa'&&(signer.asymmetricKeyDetails?.modulusLength??0)>=2048);
  const root=config.apiRoot.replace(/\/$/,'');const allowedOrigin=new URL(root).origin;
  db.db.exec(`CREATE TABLE IF NOT EXISTS mua_subjects(uid INTEGER PRIMARY KEY AUTOINCREMENT,account TEXT UNIQUE NOT NULL REFERENCES accounts(id));
    CREATE TABLE IF NOT EXISTS mua_provider_requests(ticket TEXT PRIMARY KEY,query TEXT NOT NULL,expires INTEGER NOT NULL);`);
  app.get('/api/union/member/oauth2',async(_req,reply)=>{
    reply.header('Access-Control-Allow-Origin',allowedOrigin).header('Vary','Origin');
    return {signaturePublicKey:createPublicKey(signer).export({format:'pem',type:'spki'})};
  });
  app.get('/api/union/member/oauth2/grant',async(req,reply)=>{
    const query=object(req.query);requireThat(Object.keys(query).length<=16);
    const clean:Record<string,string>={};for(const [k,v] of Object.entries(query)){requireThat(k!=='userInfoToken'&&k.length<=64);clean[k]=string(v,4096);}
    const payload=JSON.stringify(clean);requireThat(Buffer.byteLength(payload)<=8192);
    const ticket=secret();db.transaction(()=>{
      db.db.prepare('DELETE FROM mua_provider_requests WHERE expires<=?').run(now());
      const {count}=db.db.prepare('SELECT COUNT(*) AS count FROM mua_provider_requests').get() as {count:number};requireThat(count<10000);
      db.db.prepare('INSERT INTO mua_provider_requests VALUES(?,?,?)').run(digest(ticket),payload,now()+300);
    });
    return reply.redirect(origin+'/portal/#mua-grant='+ticket);
  });
  app.post('/api/mua/authorize',async req=>{
    const account=authenticate(req);const body=object(req.body);requireThat(body.consent===true,'Explicit consent required');
    const ticket=string(body.ticket);const pending=db.db.prepare('SELECT query FROM mua_provider_requests WHERE ticket=? AND expires>?').get(digest(ticket),now()) as {query:string}|undefined;requireThat(pending,'Authorization request expired');
    const backend=object(await fetchJson('/oauth2/backend'));const publicKey=createPublicKey(string(backend.publicKey,16384));
    const bits=publicKey.asymmetricKeyDetails?.modulusLength??0;requireThat(publicKey.asymmetricKeyType==='rsa'&&bits>=2048&&bits<=8192);
    // The bearer may be revoked while the upstream request is in flight.
    authenticate(req);
    const uid=db.transaction(()=>{
      const consumed=db.db.prepare('DELETE FROM mua_provider_requests WHERE ticket=? AND expires>?').run(digest(ticket),now());requireThat(consumed.changes===1);
      db.db.prepare('INSERT OR IGNORE INTO mua_subjects(account) VALUES(?)').run(account.id);
      return (db.db.prepare('SELECT uid FROM mua_subjects WHERE account=?').get(account.id) as {uid:number}).uid;
    });
    const userInfo=Buffer.from(JSON.stringify({uid,nickname:account.name,email:account.email,expires_at:now()+600})).toString('base64');
    const mac=createHmac('sha256',memberKey()).update(userInfo).digest('hex');
    const signature=sign('RSA-SHA256',Buffer.from(userInfo+'.'+mac),signer).toString('base64');
    const plain=Buffer.from(JSON.stringify({userInfo,mac,signature}));const chunks:Buffer[]=[];const size=bits/8-11;
    // Union wire format uses concatenated PKCS#1 v1.5 RSA blocks, not JWT/OIDC.
    for(let offset=0;offset<plain.length;offset+=size)chunks.push(publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_PADDING},plain.subarray(offset,offset+size)));
    const url=new URL(root+'/oauth2/continue');url.search=new URLSearchParams({...JSON.parse(pending.query),userInfoToken:Buffer.concat(chunks).toString('base64')}).toString();
    return {url:url.toString()};
  });
}
