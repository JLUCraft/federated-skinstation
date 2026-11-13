import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { OAuthAuthorizationReview } from '../../shared/contracts/generated.js';
export async function authorizeAgent(
  app: FastifyInstance,
  ownerToken: string,
  scope = 'openid offline_access mcp.read mcp.write',
) {
  const challenge = await app.inject({
    method: 'POST',
    url: '/mcp',
    payload: { jsonrpc: '2.0', id: 1, method: 'initialize' },
  });
  assert.equal(challenge.statusCode, 401);
  const metadataUrl = String(challenge.headers['www-authenticate']).match(
    /resource_metadata="([^"]+)"/,
  )?.[1];
  assert.ok(metadataUrl);
  const resource = (await app.inject({ url: new URL(metadataUrl).pathname })).json<{
    resource: string;
    authorization_servers: string[];
  }>();
  const metadata = (await app.inject({ url: '/.well-known/oauth-authorization-server' })).json<{
    issuer: string;
    authorization_endpoint: string;
    registration_endpoint: string;
    token_endpoint: string;
  }>();
  assert.equal(metadata.issuer, resource.authorization_servers[0]);
  const clientResponse = await app.inject({
    method: 'POST',
    url: new URL(metadata.registration_endpoint).pathname,
    payload: {
      client_name: 'Administrator agent',
      redirect_uris: ['http://127.0.0.1:48521/callback'],
      token_endpoint_auth_method: 'none',
    },
  });
  assert.equal(clientResponse.statusCode, 201, clientResponse.body);
  const client = clientResponse.json<{ client_id: string; redirect_uris: string[] }>();
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('hex');
  const started = await app.inject({
    url:
      new URL(metadata.authorization_endpoint).pathname +
      '?' +
      new URLSearchParams({
        client_id: client.client_id,
        response_type: 'code',
        redirect_uri: client.redirect_uris[0],
        resource: resource.resource,
        scope,
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString(),
  });
  assert.equal(started.statusCode, 302, started.body);
  const request = new URL(String(started.headers.location)).searchParams.get(
    'authorization_request',
  );
  assert.ok(request);
  const path = '/api/oauth/authorization/' + request;
  const reviewResponse = await app.inject({
    url: path,
    headers: { authorization: 'Bearer ' + ownerToken },
  });
  assert.equal(reviewResponse.statusCode, 200, reviewResponse.body);
  const review = reviewResponse.json<OAuthAuthorizationReview>();
  const decision = await app.inject({
    method: 'POST',
    url: path,
    headers: { authorization: 'Bearer ' + ownerToken },
    payload: { approve: true, decisionToken: review.decisionToken },
  });
  assert.equal(decision.statusCode, 200, decision.body);
  const callback = new URL(decision.json<{ redirect: string }>().redirect);
  assert.equal(callback.searchParams.get('state'), state);
  const code = callback.searchParams.get('code');
  assert.ok(code);
  const exchange = {
    client_id: client.client_id,
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: client.redirect_uris[0],
    resource: resource.resource,
  };
  const tokens = await app.inject({
    method: 'POST',
    url: new URL(metadata.token_endpoint).pathname,
    payload: exchange,
  });
  assert.equal(tokens.statusCode, 200, tokens.body);
  return {
    ...tokens.json<{ access_token: string; refresh_token: string; id_token?: string }>(),
    clientId: client.client_id,
    resource: resource.resource,
    exchange,
  };
}
