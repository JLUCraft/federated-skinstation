import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const digest = (value:string) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('hex');
export class Rejected extends Error {
  constructor(message='Request rejected',readonly statusCode=403,readonly code='ForbiddenOperationException'){super(message);}
}
export function requireThat(value:unknown,message='Request rejected'):asserts value {if(!value)throw new Rejected(message);}
export interface Account {id:string;name:string;email:string;school:string;password:string;verified_at:number}
export async function encodePassword(password:string) {
  requireThat(password.length>=12 && Buffer.byteLength(password)<=1024,'Use a password of 12–1024 bytes');
  const salt=randomBytes(16).toString('hex');
  const hash=await derive(password,salt,64) as Buffer;
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
export async function verifyPassword(password:string,encoded:string) {
  if(Buffer.byteLength(password)>1024)return false;
  const [kind,salt,value]=encoded.split('$');if(kind!=='scrypt'||!salt||!value)return false;
  const expected=Buffer.from(value,'hex');const actual=await derive(password,salt,64) as Buffer;
  return expected.length===actual.length && timingSafeEqual(expected,actual);
}
export class Store {
  readonly db:DatabaseSync;
  constructor(path:string) {
    this.db=new DatabaseSync(path);
    const version=(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
    const tables=(this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as {n:number}).n;
    if((tables>0&&version!==1)||(tables===0&&version!==0&&version!==1)){this.db.close();throw new Error('Unsupported database schema; only schema 1 is accepted');}
    if(tables>0){
      const expected:Record<string,string[]>={accounts:['id','name','email','school','password','verified_at'],joins:['server','profile','token','expires','ip'],profile_textures:['account','kind','hash','model']};
      for(const [table,columns] of Object.entries(expected))if(JSON.stringify((this.db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(c=>c.name))!==JSON.stringify(columns)){this.db.close();throw new Error('Unsupported database schema layout');}
    }
    this.db.exec(`PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,name TEXT UNIQUE COLLATE NOCASE NOT NULL,email TEXT UNIQUE COLLATE NOCASE NOT NULL,school TEXT NOT NULL,password TEXT NOT NULL,verified_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges(email TEXT PRIMARY KEY,token TEXT NOT NULL,expires INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY,client TEXT NOT NULL,account TEXT NOT NULL REFERENCES accounts(id),expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS joins(server TEXT NOT NULL,profile TEXT NOT NULL,token TEXT NOT NULL REFERENCES tokens(hash) ON DELETE CASCADE,expires INTEGER NOT NULL,ip TEXT,PRIMARY KEY(server,profile));
      CREATE TABLE IF NOT EXISTS mua_sync(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,synced INTEGER NOT NULL,attempts INTEGER NOT NULL,next INTEGER NOT NULL);
      INSERT OR IGNORE INTO mua_sync VALUES(1,0,0,0,0);
      CREATE TABLE IF NOT EXISTS profile_mappings(account TEXT PRIMARY KEY REFERENCES accounts(id),uuid TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS profile_remaps(old TEXT PRIMARY KEY,next TEXT NOT NULL,account TEXT NOT NULL REFERENCES accounts(id));
      CREATE TABLE IF NOT EXISTS password_resets(account TEXT PRIMARY KEY REFERENCES accounts(id),token TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(key TEXT PRIMARY KEY,window INTEGER NOT NULL,count INTEGER NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS profile_textures(account TEXT NOT NULL REFERENCES accounts(id),kind TEXT NOT NULL,hash TEXT NOT NULL,model TEXT NOT NULL,PRIMARY KEY(account,kind))');
    this.db.exec('PRAGMA user_version=1');
  }
  close(){this.db.close();}
  transaction<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  account(field:'id'|'email'|'name',value:string):Account|undefined {
    const query={id:'SELECT * FROM accounts WHERE id=?',email:'SELECT * FROM accounts WHERE email=?',name:'SELECT * FROM accounts WHERE name=?'}[field];
    return this.db.prepare(query).get(value) as Account|undefined;
  }
  rate(key:string,now:number,max:number,window:number) {
    this.transaction(()=>{
      this.db.prepare('DELETE FROM attempts WHERE window<?').run(now-3600);
      const old=this.db.prepare('SELECT window,count FROM attempts WHERE key=?').get(key) as {window:number;count:number}|undefined;
      const count=old&&now-old.window<window?old.count:0;requireThat(count<max,'Too many attempts');
      this.db.prepare('INSERT OR REPLACE INTO attempts VALUES(?,?,?)').run(key,count===0?now:old!.window,count+1);
    });
  }
  challenge(account:Account,now:number) {
    this.rate(`email:${digest(account.email)}`,now,3,3600);
    this.db.prepare('DELETE FROM challenges WHERE expires<=?').run(now);
    const code=secret();this.db.prepare('INSERT OR REPLACE INTO challenges VALUES(?,?,?,?)').run(account.email,digest(code),now+900,JSON.stringify(account));return code;
  }
  confirm(email:string,code:string,now:number) {
    this.rate(`confirm:${digest(email)}`,now,10,900);
    this.transaction(()=>{
      const row=this.db.prepare('SELECT payload FROM challenges WHERE email=? AND token=? AND expires>?').get(email,digest(code),now) as {payload:string}|undefined;
      requireThat(row,'Invalid or expired verification');const a=JSON.parse(row.payload) as Account;
      this.db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET verified_at=excluded.verified_at').run(a.id,a.name,a.email,a.school,a.password,now);
      this.db.prepare('DELETE FROM challenges WHERE email=?').run(email);
      this.db.prepare('UPDATE mua_sync SET revision=revision+1,attempts=0,next=0 WHERE id=1').run();
    });
  }
  profileId(account:Account):string {
    return (this.db.prepare('SELECT uuid FROM profile_mappings WHERE account=?').get(account.id) as {uuid:string}|undefined)?.uuid??account.id;
  }
  profile(uuid:string):Account|undefined {
    const mapped=this.db.prepare('SELECT account FROM profile_mappings WHERE uuid=?').get(uuid) as {account:string}|undefined;
    if(mapped)return this.account('id',mapped.account);
    const account=this.account('id',uuid);
    return account&&this.profileId(account)===uuid?account:undefined;
  }
  remapProfiles(mapping:Record<string,string>) {
    this.transaction(()=>{
      const updates=Object.entries(mapping).map(([old,next])=>{
        requireThat(/^[a-f0-9]{32}$/.test(old)&&/^[a-f0-9]{32}$/.test(next));
        const receipt=this.db.prepare('SELECT next,account FROM profile_remaps WHERE old=?').get(old) as {next:string;account:string}|undefined;
        if(receipt?.next===next){
          const previous=this.account('id',receipt.account);
          if(previous&&this.profileId(previous)===next)return {account:previous,next,old,applied:true};
        }
        const account=this.profile(old);requireThat(account,'Unknown profile');
        const collision=this.profile(next);requireThat(!collision||collision.id===account.id,'Profile collision');
        return {account,next,old,applied:false};
      });
      requireThat(new Set(updates.map(u=>u.next)).size===updates.length);
      for(const {account,next,old,applied} of updates){
        if(applied||old===next)continue;
        this.db.prepare('INSERT OR REPLACE INTO profile_remaps VALUES(?,?,?)').run(old,next,account.id);
        this.db.prepare('INSERT INTO profile_mappings VALUES(?,?) ON CONFLICT(account) DO UPDATE SET uuid=excluded.uuid').run(account.id,next);
        this.db.prepare('DELETE FROM tokens WHERE account=?').run(account.id);
      }
    });
  }
  passwordReset(email:string,now:number) {
    this.rate(`reset:${digest(email)}`,now,3,3600);
    this.db.prepare('DELETE FROM password_resets WHERE expires<=?').run(now);
    const account=this.account('email',email);if(!account)return undefined;
    const code=secret();
    this.db.prepare('INSERT OR REPLACE INTO password_resets VALUES(?,?,?)').run(account.id,digest(code),now+900);
    return code;
  }
  resetPassword(email:string,code:string,passwordHash:string,now:number) {
    this.rate(`reset-confirm:${digest(email)}`,now,10,900);
    this.transaction(()=>{
      const account=this.account('email',email);requireThat(account);
      const row=this.db.prepare('SELECT 1 FROM password_resets WHERE account=? AND token=? AND expires>?').get(account.id,digest(code),now);
      requireThat(row,'Invalid or expired verification');
      this.db.prepare('UPDATE accounts SET password=? WHERE id=?').run(passwordHash,account.id);
      this.db.prepare('DELETE FROM password_resets WHERE account=?').run(account.id);
      this.db.prepare('DELETE FROM tokens WHERE account=?').run(account.id);
      this.db.prepare('DELETE FROM challenges WHERE email=?').run(email);
    });
  }
  mint(account:string,client:string,now:number) {
    requireThat(client.length<=256);const token=secret();
    this.db.prepare('DELETE FROM tokens WHERE expires<=?').run(now);
    this.db.prepare('DELETE FROM tokens WHERE hash IN (SELECT hash FROM tokens WHERE account=? ORDER BY expires DESC LIMIT -1 OFFSET 9)').run(account);
    this.db.prepare('INSERT INTO tokens VALUES(?,?,?,?)').run(digest(token),client,account,now+86400);return token;
  }
  token(token:string,client:string|undefined,now:number) {
    const row=this.db.prepare('SELECT account,client FROM tokens WHERE hash=? AND expires>?').get(digest(token),now) as {account:string;client:string}|undefined;
    requireThat(row && (client===undefined||row.client===client),'Invalid token');const account=this.account('id',row.account);requireThat(account);return account;
  }
  refresh(token:string,client:string|undefined,profile:string|undefined,now:number) {
    return this.transaction(()=>{
      const a=this.token(token,client,now);
      if(profile!==undefined)throw new Rejected('Access token already has a profile assigned.',400,'IllegalArgumentException');
      const stored=this.db.prepare('SELECT client FROM tokens WHERE hash=?').get(digest(token)) as {client:string};
      const next=this.mint(a.id,stored.client,now);this.invalidate(token);return {account:a,token:next,client:stored.client};
    });
  }
  invalidate(token:string){this.db.prepare('DELETE FROM tokens WHERE hash=?').run(digest(token));}
  join(token:string,profile:string,server:string,now:number,ip?:string) {
    requireThat(server.length>0&&server.length<=64);const account=this.token(token,undefined,now);requireThat(this.profileId(account)===profile);
    this.db.prepare('DELETE FROM joins WHERE expires<=?').run(now);
    this.db.prepare('INSERT OR REPLACE INTO joins(server,profile,token,expires,ip) VALUES(?,?,?,?,?)').run(server,profile,digest(token),now+30,ip??null);
  }
  joined(name:string,server:string,now:number,ip?:string) {
    const a=this.account('name',name);if(!a)return undefined;
    const found=this.db.prepare('SELECT 1 FROM joins j JOIN tokens t ON t.hash=j.token WHERE j.server=? AND j.profile=? AND j.expires>? AND t.expires>? AND (? IS NULL OR j.ip=?)').get(server,this.profileId(a),now,now,ip??null,ip??null);
    return found?a:undefined;
  }
}
export const accountId = () => randomUUID().replaceAll('-','');
