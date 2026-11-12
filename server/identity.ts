import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { LocalIdentity } from './permissions.js';
import { now, type Store } from './store.js';
import { bearer, field, record } from './validate.js';
import { identitySnapshotSchema } from '../shared/contracts/generated.js';

export function registerIdentity(app: FastifyInstance, store: Store, identity: LocalIdentity) {
  const actor = (request: FastifyRequest) =>
    store.token(bearer(request.headers.authorization), undefined, now()).id;
  const club = (request: FastifyRequest) => field(record(request.params).club);

  app.get('/api/identity', {
    schema: { response: { 200: identitySnapshotSchema } },
  }, async request => identity.snapshot(actor(request)));
  app.get('/api/clubs/:club/members', async request =>
    identity.members(actor(request), club(request)));
  app.post('/api/clubs/:club/members/:account/revoke', async (request, reply) => {
    identity.revokeMembership(actor(request), field(record(request.params).account), club(request));
    return reply.code(204).send();
  });
  app.get('/api/clubs/:club/successions', async request =>
    identity.successions(actor(request), club(request)));
  app.post('/api/clubs/:club/successions', async request => ({
    id: identity.proposeSuccession(
      actor(request), club(request), field(record(request.body).nominee),
    ),
  }));
  app.post('/api/identity/successions/:id/accept', async (request, reply) => {
    identity.acceptSuccession(actor(request), field(record(request.params).id));
    return reply.code(204).send();
  });
  app.get('/api/identity/grants', async request =>
    identity.listGrants(actor(request), field(record(request.query).scope)));
  app.post('/api/identity/grants', async request => {
    const body = record(request.body);
    return {
      id: identity.grantPermission(
        actor(request), field(body.account), field(body.scope), field(body.permission),
      ),
    };
  });
  app.delete('/api/identity/grants/:id', async (request, reply) => {
    identity.revokeGrant(actor(request), field(record(request.params).id));
    return reply.code(204).send();
  });
  app.post('/api/admin/accounts/:account/disable', async (request, reply) => {
    identity.disableAccount(actor(request), field(record(request.params).account));
    return reply.code(204).send();
  });
}
