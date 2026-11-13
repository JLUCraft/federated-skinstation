import type { FastifyInstance, FastifyRequest } from 'fastify';
import { OPERATIONS_APPROVAL_PATH } from '../shared/operations.js';
import type { registerOperations } from './operations.js';
import type { registerPasskeys } from './passkeys.js';
import { now, requireThat, verifyPassword, type Store } from './store.js';
import { bearer, field, record } from './validate.js';

export function registerOperationConfirmations(
  app: FastifyInstance,
  store: Store,
  operations: ReturnType<typeof registerOperations>,
  passkeys: ReturnType<typeof registerPasskeys>,
  origin: string,
) {
  function viewer(request: FastifyRequest) {
    const token = bearer(request.headers.authorization);
    requireThat(!store.oauthSession(token), 'Browser sign-in required');
    return { token, account: store.token(token, undefined, now()) };
  }
  function sameOrigin(request: FastifyRequest) {
    requireThat(request.headers.origin === origin, 'Origin mismatch');
  }
  app.get<{ Params: { id: string } }>(OPERATIONS_APPROVAL_PATH + '/:id', async (request) => {
    const { account } = viewer(request);
    return operations.authority.review(request.params.id, account.id);
  });
  app.post<{ Params: { id: string } }>(
    OPERATIONS_APPROVAL_PATH + '/:id/confirm',
    async (request) => {
      sameOrigin(request);
      const { token, account } = viewer(request),
        id = request.params.id;
      operations.authority.review(id, account.id);
      store.rate('operation-password:' + account.id, now(), 5, 60);
      requireThat(
        await verifyPassword(field(record(request.body).password, 1024), account.password),
        'Invalid credentials',
      );
      store.withCaller(null, request.id, () => operations.authority.decide(id, token, true));
      return operations.dispatch(request, id);
    },
  );
  app.post<{ Params: { id: string } }>(
    OPERATIONS_APPROVAL_PATH + '/:id/deny',
    async (request, reply) => {
      sameOrigin(request);
      const { token } = viewer(request);
      store.withCaller(null, request.id, () =>
        operations.authority.decide(request.params.id, token, false),
      );
      return reply.code(204).send();
    },
  );
  const passkeyPath = '/api/passkeys/operations/:id';
  app.post<{ Params: { id: string } }>(passkeyPath + '/options', async (request, reply) => {
    sameOrigin(request);
    const { token, account } = viewer(request);
    const review = operations.authority.review(request.params.id, account.id);
    requireThat(
      review.status === 'pending' && review.expiresAt > now(),
      'Operation approval expired or already decided',
      409,
    );
    store.rate('operation-passkey:' + account.id, now(), 5, 60);
    return passkeys.beginOperation(request, reply, request.params.id, token, account.id);
  });
  app.post<{ Params: { id: string } }>(passkeyPath + '/verify', async (request, reply) => {
    const { token, account } = viewer(request),
      id = request.params.id;
    await passkeys.verifyOperation(request, reply, id, token, account.id, () =>
      store.withCaller(null, request.id, () => operations.authority.decide(id, token, true)),
    );
    return operations.dispatch(request, id);
  });
}
