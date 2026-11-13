import type { FastifyReply, FastifyRequest } from 'fastify';
import { Rejected } from './store.js';
export class OAuthError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'invalid_client'
      | 'invalid_client_metadata'
      | 'invalid_grant'
      | 'invalid_scope'
      | 'invalid_target'
      | 'unsupported_grant_type'
      | 'authorization_pending'
      | 'slow_down'
      | 'access_denied'
      | 'expired_token',
  ) {
    super(code);
  }
}
export function oauthRoute<Request extends FastifyRequest>(
  handler: (request: Request, reply: FastifyReply) => Promise<unknown>,
) {
  return async (request: Request, reply: FastifyReply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      if (error instanceof OAuthError) return reply.code(400).send({ error: error.code });
      if (error instanceof Rejected) return reply.code(400).send({ error: 'invalid_request' });
      throw error;
    }
  };
}
