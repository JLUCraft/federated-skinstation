import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {requireThat,type Store} from './store.js';

const IV_BYTES=12;
const TAG_BYTES=16;
const HEADER_BYTES=IV_BYTES+TAG_BYTES;
const PREFIX='sealed:v1:';
const NAMES:readonly string[]=['memberKey','textureKey'];
export const isSecretName=(name:string)=>NAMES.includes(name);

/** A separate deployment secret, never the MUA member key or a signing key. */
export class SecretState {
  private constructor(private readonly key:Buffer){}
  static fromEnvironment(name:string|undefined):SecretState {
    const value=name?process.env[name]:undefined;
    requireThat(value&&/^[a-fA-F0-9]{64}$/.test(value),'MUA storage key requires an environment variable containing 32 random bytes in hex');
    return new SecretState(Buffer.from(value,'hex'));
  }
  seal(name:string,value:string):string {
    const iv=randomBytes(IV_BYTES),cipher=createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from('jlucraft/mua/state/1/'+name));
    const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
    return PREFIX+Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
  }
  open(name:string,value:string):string {
    requireThat(value.startsWith(PREFIX),'Invalid encrypted MUA state');
    const bytes=Buffer.from(value.slice(PREFIX.length),'base64');
    requireThat(bytes.length>HEADER_BYTES,'Invalid encrypted MUA state');
    const decipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,IV_BYTES));
    decipher.setAAD(Buffer.from('jlucraft/mua/state/1/'+name));
    decipher.setAuthTag(bytes.subarray(IV_BYTES,HEADER_BYTES));
    return Buffer.concat([decipher.update(bytes.subarray(HEADER_BYTES)),decipher.final()]).toString('utf8');
  }
  validate(db:Store):void {
    const get=db.db.prepare('SELECT value FROM mua_state WHERE name=?');
    for(const name of NAMES){
      const value=(get.get(name) as {value:string}|undefined)?.value;
      if(value!==undefined)this.open(name,value);
    }
  }
}
