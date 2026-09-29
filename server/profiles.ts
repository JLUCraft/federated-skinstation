import type { FastifyInstance } from 'fastify';
import { Store, requireThat } from './store.js';
import { field, record } from './validate.js';
export function registerProfiles(app: FastifyInstance, db: Store) {
  const account = (header: string | undefined) => {
    requireThat(header && header.startsWith('Bearer '));
    return db.token(header.slice(7), undefined, Math.floor(Date.now() / 1000));
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
