import type { FastifyInstance } from 'fastify';
import { Store, now } from './store.js';
import { bearer, field, record } from './validate.js';
export function registerProfiles(app: FastifyInstance, db: Store) {
  const account = (header: string | undefined) => {
    return db.token(bearer(header), undefined, now());
  };
  app.get('/api/players', async (req) => ({
    profiles: db.profiles(account(req.headers.authorization)),
  }));
  app.post('/api/players', async (req) =>
    db.createProfile(
      account(req.headers.authorization),
      field(record(req.body).name, 16),
    ),
  );
  app.patch('/api/players/:id', async (req) => {
    db.renameProfile(
      account(req.headers.authorization),
      field(record(req.params).id, 32),
      field(record(req.body).name, 16),
    );
    return { ok: true };
  });
  app.delete('/api/players/:id', async (req) => {
    db.deleteProfile(
      account(req.headers.authorization),
      field(record(req.params).id, 32),
    );
    return { ok: true };
  });
}
