import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  oAuthAuthorizationDecisionSchema,
  type OAuthAuthorizationDecision,
  type OAuthAuthorizationReview,
  type OAuthClientRegistration,
  type OAuthGrantList,
} from '../shared/contracts/generated.js';
import {
  MCP_PATH,
  OAUTH_PATHS,
  agentScopes,
  mcpScopeAllows,
  parseOAuthScopes,
} from '../shared/oauth.js';
import { OAuthError, oauthRoute } from './oauth.js';
import { appendAudit } from './permissions.js';
import { digest, now, requireThat, secret, type Account, type Store } from './store.js';
import { bearer, field, record } from './validate.js';

export const AGENT_ACCESS_LIFETIME = 3600;
const AUTHORIZATION_LIFETIME = 600;
interface Client {
  id: string;
  name: string;
  redirects: string;
}
interface Authorization {
  request: string;
  client: string;
  redirect: string;
  resource: string;
  scope: string;
  challenge: string;
  state: string | null;
  nonce: string | null;
  expires: number;
  account: string | null;
  decision: string | null;
  code: string | null;
  session: string | null;
  used: number;
}
export interface RefreshGrant {
  account: string;
  profile: string | null;
  client: string;
  scope: string;
  expires: number;
  session: string | null;
}
export type IssueTokens = (
  account: Account,
  profile: string | null,
  client: string,
  scope: string,
  session?: string,
  nonce?: string | null,
) => Record<string, unknown>;

function equalSecret(expected: string, actual: string) {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}
function redirectUri(value: unknown) {
  const text = field(value, 2048);
  let uri: URL;
  try {
    uri = new URL(text);
  } catch {
    throw new OAuthError('invalid_client_metadata');
  }
  if (
    uri.username ||
    uri.password ||
    uri.hash ||
    !(
      uri.protocol === 'https:' ||
      (uri.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(uri.hostname))
    )
  )
    throw new OAuthError('invalid_client_metadata');
  if (['code', 'state', 'error'].some((key) => uri.searchParams.has(key)))
    throw new OAuthError('invalid_client_metadata');
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code <= 32 || code === 127) throw new OAuthError('invalid_client_metadata');
  }
  return text;
}

export class AgentOAuth {
  readonly resource: string;
  constructor(
    private readonly db: Store,
    private readonly origin: string,
    private readonly authorize: (account: Account) => Promise<void>,
  ) {
    this.resource = origin + MCP_PATH;
  }
  client(value: unknown): Client {
    const found =
      typeof value === 'string'
        ? (this.db.db.prepare('SELECT * FROM oauth_clients WHERE id=?').get(value) as
            | Client
            | undefined)
        : undefined;
    if (!found) throw new OAuthError('invalid_client');
    return found;
  }
  private pending(value: unknown): Authorization {
    const row = this.db.db
      .prepare('SELECT * FROM oauth_authorizations WHERE request=? AND expires>? AND used=0')
      .get(digest(field(value, 128)), now()) as Authorization | undefined;
    requireThat(row, 'Authorization expired');
    return row;
  }
  private async owner(request: FastifyRequest) {
    const account = this.db.token(bearer(request.headers.authorization), undefined, now());
    await this.authorize(account);
    return account;
  }
  private redirect(row: Authorization, result: { code: string } | { error: string }) {
    const uri = new URL(row.redirect);
    for (const [key, value] of Object.entries(result)) uri.searchParams.set(key, value);
    if (row.state !== null) uri.searchParams.set('state', row.state);
    return uri.href;
  }
  revoke(session: string, account?: string) {
    const row = this.db.db
      .prepare('SELECT account,client FROM oauth_sessions WHERE id=?')
      .get(session);
    if (!row || (account !== undefined && row.account !== account)) return;
    this.db.db.prepare('DELETE FROM oauth_sessions WHERE id=?').run(session);
    appendAudit(this.db, String(row.account), 'global', 'oauth.revoke', session, {
      client: row.client,
    });
  }
  register(app: FastifyInstance) {
    app.post<{ Body: OAuthClientRegistration }>(
      OAUTH_PATHS.register,
      { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
      oauthRoute(async (request, reply) => {
        const body = record(request.body);
        if (
          !Array.isArray(body.redirect_uris) ||
          !body.redirect_uris.length ||
          body.redirect_uris.length > 10
        )
          throw new OAuthError('invalid_client_metadata');
        if (
          (body.token_endpoint_auth_method !== undefined &&
            body.token_endpoint_auth_method !== 'none') ||
          (body.grant_types !== undefined &&
            (!Array.isArray(body.grant_types) ||
              !body.grant_types.every(
                (grant: unknown) => grant === 'authorization_code' || grant === 'refresh_token',
              ))) ||
          (body.response_types !== undefined &&
            (!Array.isArray(body.response_types) ||
              body.response_types.length !== 1 ||
              body.response_types[0] !== 'code'))
        )
          throw new OAuthError('invalid_client_metadata');
        const redirects = [...new Set(body.redirect_uris.map(redirectUri))];
        const id = secret();
        const name = body.client_name === undefined ? id : field(body.client_name, 128);
        this.db.db
          .prepare('INSERT INTO oauth_clients VALUES(?,?,?,?)')
          .run(id, name, JSON.stringify(redirects), now());
        return reply.code(201).send({
          client_id: id,
          client_name: name,
          redirect_uris: redirects,
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        });
      }),
    );
    app.get(
      OAUTH_PATHS.authorize,
      oauthRoute(async (request, reply) => {
        const query = record(request.query);
        const client = this.client(query.client_id);
        if (
          query.response_type !== 'code' ||
          query.code_challenge_method !== 'S256' ||
          typeof query.code_challenge !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge)
        )
          throw new OAuthError('invalid_request');
        const redirect = field(query.redirect_uri, 2048);
        const redirects = JSON.parse(client.redirects) as string[];
        if (!redirects.includes(redirect)) throw new OAuthError('invalid_request');
        if (query.resource !== this.resource) throw new OAuthError('invalid_target');
        const scopes = parseOAuthScopes(query.scope, agentScopes);
        if (!scopes || !mcpScopeAllows(scopes, false)) throw new OAuthError('invalid_scope');
        const id = secret();
        this.db.db.prepare('DELETE FROM oauth_authorizations WHERE expires<=?').run(now());
        this.db.db
          .prepare(
            'INSERT INTO oauth_authorizations(request,client,redirect,resource,scope,challenge,state,nonce,expires) VALUES(?,?,?,?,?,?,?,?,?)',
          )
          .run(
            digest(id),
            client.id,
            redirect,
            this.resource,
            scopes.join(' '),
            query.code_challenge,
            query.state === undefined ? null : field(query.state, 2048),
            query.nonce === undefined ? null : field(query.nonce, 256),
            now() + AUTHORIZATION_LIFETIME,
          );
        return reply.redirect(this.origin + '/portal/?authorization_request=' + id);
      }),
    );
    app.get(
      OAUTH_PATHS.review + '/:request',
      async (request): Promise<OAuthAuthorizationReview> => {
        const account = await this.owner(request);
        return this.db.transaction(() => {
          const row = this.pending(record(request.params).request);
          requireThat(
            row.account === null || row.account === account.id,
            'Authorization belongs to another account',
          );
          requireThat(row.session === null, 'Authorization already decided');
          const decision = createHmac('sha256', bearer(request.headers.authorization))
            .update(row.request)
            .digest('hex');
          this.db.db
            .prepare('UPDATE oauth_authorizations SET account=?,decision=? WHERE request=?')
            .run(account.id, digest(decision), row.request);
          const scopes = parseOAuthScopes(row.scope, agentScopes);
          requireThat(scopes);
          return {
            clientId: row.client,
            clientName: this.client(row.client).name,
            redirectUri: row.redirect,
            resource: row.resource,
            scopes,
            decisionToken: decision,
          };
        });
      },
    );
    app.post<{ Body: OAuthAuthorizationDecision }>(
      OAUTH_PATHS.review + '/:request',
      { schema: { body: oAuthAuthorizationDecisionSchema } },
      async (request) => {
        const account = await this.owner(request);
        return this.db.transaction(() => {
          const row = this.pending(record(request.params).request);
          requireThat(
            row.account === account.id &&
              row.decision !== null &&
              equalSecret(row.decision, digest(request.body.decisionToken)),
            'Authorization decision rejected',
          );
          requireThat(row.session === null, 'Authorization already decided');
          if (!request.body.approve) {
            this.db.db.prepare('DELETE FROM oauth_authorizations WHERE request=?').run(row.request);
            return { redirect: this.redirect(row, { error: 'access_denied' }) };
          }
          const code = secret();
          const session = randomUUID();
          this.db.db
            .prepare('INSERT INTO oauth_sessions VALUES(?,?,?,?,?,?)')
            .run(session, account.id, row.client, row.resource, row.scope, now());
          this.db.db
            .prepare(
              'UPDATE oauth_authorizations SET code=?,session=?,decision=NULL WHERE request=?',
            )
            .run(digest(code), session, row.request);
          appendAudit(this.db, account.id, 'global', 'oauth.grant', session, {
            client: row.client,
            resource: row.resource,
            scope: row.scope,
          });
          return { redirect: this.redirect(row, { code }) };
        });
      },
    );
    app.get(OAUTH_PATHS.grants, async (request): Promise<OAuthGrantList> => {
      const account = await this.owner(request);
      return {
        grants: this.db.db
          .prepare(
            'SELECT s.*,c.name FROM oauth_sessions s JOIN oauth_clients c ON c.id=s.client WHERE s.account=? ORDER BY s.created_at DESC,s.id',
          )
          .all(account.id)
          .map((row) => ({
            id: String(row.id),
            clientName: String(row.name),
            resource: String(row.resource),
            scopes: parseOAuthScopes(String(row.scope), agentScopes) ?? [],
            createdAt: Number(row.created_at),
          })),
      };
    });
    app.delete(OAUTH_PATHS.grants + '/:id', async (request, reply) => {
      const account = await this.owner(request);
      this.db.transaction(() => this.revoke(field(record(request.params).id, 128), account.id));
      return reply.code(204).send();
    });
    app.post(
      OAUTH_PATHS.revoke,
      oauthRoute(async (request, reply) => {
        const body = record(request.body);
        const client = this.client(body.client_id);
        const token = field(body.token, 128);
        this.db.transaction(() => {
          const refresh = this.db.db
            .prepare('SELECT session FROM oauth_refresh WHERE hash=? AND client=?')
            .get(digest(token), client.id);
          const access = this.db.oauthSession(token);
          const session =
            typeof refresh?.session === 'string'
              ? refresh.session
              : access?.client === client.id
                ? access.id
                : undefined;
          if (session) this.revoke(session);
        });
        return reply.code(200).send();
      }),
    );
  }
  async exchange(body: Record<string, unknown>, issue: IssueTokens) {
    const client = this.client(body.client_id);
    if (body.resource !== this.resource) throw new OAuthError('invalid_target');
    const code = digest(field(body.code, 128));
    const row = this.db.db.prepare('SELECT * FROM oauth_authorizations WHERE code=?').get(code) as
      | Authorization
      | undefined;
    if (
      !row ||
      row.client !== client.id ||
      row.redirect !== body.redirect_uri ||
      row.resource !== this.resource ||
      row.expires <= now() ||
      !row.account ||
      !row.session
    )
      throw new OAuthError('invalid_grant');
    const verifier = field(body.code_verifier, 128);
    if (
      !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
      !equalSecret(row.challenge, createHash('sha256').update(verifier).digest('base64url'))
    )
      throw new OAuthError('invalid_grant');
    const account = this.db.account('id', row.account);
    if (!account) throw new OAuthError('invalid_grant');
    await this.authorize(account);
    const result = this.db.transaction(() => {
      const fresh = this.db.db
        .prepare('SELECT * FROM oauth_authorizations WHERE code=?')
        .get(code) as Authorization | undefined;
      if (!fresh || !fresh.session) throw new OAuthError('invalid_grant');
      if (fresh.used) {
        this.revoke(fresh.session);
        return undefined;
      }
      this.db.db.prepare('UPDATE oauth_authorizations SET used=1 WHERE code=?').run(code);
      return issue(account, null, client.id, fresh.scope, fresh.session, fresh.nonce);
    });
    if (!result) throw new OAuthError('invalid_grant');
    return result;
  }
  async refresh(body: Record<string, unknown>, issue: IssueTokens) {
    const client = this.client(body.client_id);
    if (body.resource !== this.resource) throw new OAuthError('invalid_target');
    const hash = digest(field(body.refresh_token, 128));
    const row = this.db.db
      .prepare('SELECT * FROM oauth_refresh WHERE hash=? AND client=? AND expires>?')
      .get(hash, client.id, now()) as RefreshGrant | undefined;
    if (!row || !row.session) {
      this.db.transaction(() => {
        const spent = this.db.db
          .prepare(
            'SELECT p.session FROM oauth_refresh_spent p JOIN oauth_sessions s ON s.id=p.session WHERE p.hash=? AND s.client=?',
          )
          .get(hash, client.id);
        if (spent) this.revoke(String(spent.session));
      });
      throw new OAuthError('invalid_grant');
    }
    const scopes =
      body.scope === undefined
        ? parseOAuthScopes(row.scope, agentScopes)
        : parseOAuthScopes(body.scope, agentScopes);
    if (
      !scopes ||
      !mcpScopeAllows(scopes, false) ||
      !scopes.every((scope) => row.scope.split(' ').includes(scope))
    )
      throw new OAuthError('invalid_scope');
    const account = this.db.account('id', row.account);
    if (!account) throw new OAuthError('invalid_grant');
    await this.authorize(account);
    const result = this.db.transaction(() => {
      if (!this.db.db.prepare('SELECT 1 FROM oauth_refresh WHERE hash=?').get(hash)) {
        this.revoke(row.session!);
        return undefined;
      }
      this.db.db.prepare('DELETE FROM oauth_refresh WHERE hash=?').run(hash);
      this.db.db
        .prepare('UPDATE oauth_sessions SET scope=? WHERE id=?')
        .run(scopes.join(' '), row.session);
      this.db.db
        .prepare('INSERT INTO oauth_refresh_spent VALUES(?,?,?)')
        .run(hash, row.session, row.expires);
      this.db.db.prepare('DELETE FROM oauth_refresh_spent WHERE expires<=?').run(now());
      return issue(account, null, client.id, scopes.join(' '), row.session ?? undefined);
    });
    if (!result) throw new OAuthError('invalid_grant');
    return result;
  }
}
