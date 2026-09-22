import { readFile } from 'node:fs/promises';
import { privateKeyFromProtobuf, publicKeyFromProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import { randomUUID } from 'node:crypto';
import { requireThat, type Account } from './store.js';

export interface SignedDocument {payload:number[];key:number[];signature:number[]}
export interface Delegation {id:string;school:string;issuer:string;not_before:number;expires_at:number;max_credential_seconds:number;evidence:string[]}
export interface School {emailDomains:string[];issuerKey:string;delegation:string;roots:string[]}
const domain=Buffer.from('jlucraft/student-delegation/1\0');
export async function issueStudent(account:Account,holder:string,school:School,now:number,gameProfile=account.id) {
  const delegation=JSON.parse(await readFile(school.delegation,'utf8')) as SignedDocument;
  const publicKey=publicKeyFromProtobuf(Uint8Array.from(delegation.key));
  requireThat(school.roots.includes(peerIdFromPublicKey(publicKey).toString()),'Untrusted school root');
  requireThat(await publicKey.verify(Buffer.concat([domain,Buffer.from(delegation.payload)]),Uint8Array.from(delegation.signature)),'Invalid delegation');
  const claims=JSON.parse(Buffer.from(delegation.payload).toString('utf8')) as Delegation;
  const issuer=privateKeyFromProtobuf(await readFile(school.issuerKey));
  requireThat(claims.school===account.school&&claims.issuer===peerIdFromPublicKey(issuer.publicKey).toString(),'Delegation scope mismatch');
  requireThat(claims.not_before<=now&&claims.expires_at>now&&claims.max_credential_seconds>0&&claims.evidence.includes('institutional_email'));
  requireThat(account.verified_at>0&&now-account.verified_at<180*86400,'School email must be reverified');
  const payload=Buffer.from(JSON.stringify({id:randomUUID(),school:account.school,subject:account.id,game_profile:gameProfile,holder,evidence:'institutional_email',verified_at:account.verified_at,issued_at:now,expires_at:Math.min(now+3600,now+claims.max_credential_seconds,claims.expires_at)}));
  const signature=await issuer.sign(Buffer.concat([Buffer.from('jlucraft/student-credential/1\0'),payload]));
  // Rust libp2p public-key protobuf: Ed25519 type=1, 32-byte raw public key.
  const { publicKeyToProtobuf }=await import('@libp2p/crypto/keys');
  return {delegation,student:{payload:[...payload],key:[...publicKeyToProtobuf(issuer.publicKey)],signature:[...signature]}};
}
