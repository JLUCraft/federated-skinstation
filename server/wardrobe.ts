import { TEXTURE_PAGE_SIZE } from '../shared/wardrobe.js';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Store, requireThat } from './store.js';
import { field, record } from './validate.js';

type Texture = {
  id: string;
  title: string;
  kind: 'skin' | 'cape';
  hash: string;
  model: 'default' | 'slim';
};
export function registerWardrobe(app: FastifyInstance, db: Store) {
  db.db
    .exec(`CREATE TABLE IF NOT EXISTS wardrobe(id TEXT PRIMARY KEY,account TEXT NOT NULL REFERENCES accounts(id),title TEXT NOT NULL,kind TEXT NOT NULL,hash TEXT NOT NULL,model TEXT NOT NULL,published INTEGER NOT NULL DEFAULT 0,UNIQUE(account,kind,hash,model));
    INSERT OR IGNORE INTO wardrobe(id,account,title,kind,hash,model) SELECT lower(hex(randomblob(16))),account,'',kind,hash,model FROM profile_textures;`);
  const account = (header: string | undefined) => {
    requireThat(header?.startsWith('Bearer '));
    return db.token(
      field(header).slice(7),
      undefined,
      Math.floor(Date.now() / 1000),
    );
  };
  const own = (id: unknown, owner: string) => {
    const row = db.db
      .prepare('SELECT * FROM wardrobe WHERE id=? AND account=?')
      .get(field(id), owner);
    requireThat(row, 'Texture not found');
    return row;
  };
  app.get('/api/wardrobe', async (req) => {
    const owner = account(req.headers.authorization);
    const offset = Number(record(req.query).offset ?? 0);
    requireThat(Number.isSafeInteger(offset) && offset >= 0 && offset <= 10000);
    const query = record(req.query);
    const profileId =
      query.profileId === undefined
        ? db.profileId(owner)
        : field(query.profileId, 32);
    const applied = db.textures(owner, profileId);
    const items = db.db
      .prepare(
        'SELECT id,title,kind,hash,model,published FROM wardrobe WHERE account=? ORDER BY rowid DESC LIMIT ? OFFSET ?',
      )
      .all(owner.id, TEXTURE_PAGE_SIZE, offset);
    return {
      items: items.map((item) => ({
        ...item,
        applied: applied.some(
          (texture) =>
            texture.kind === item.kind &&
            texture.hash === item.hash &&
            texture.model === item.model,
        )
          ? 1
          : 0,
      })),
    };
  });
  const localItems = (offset: number, id?: string) =>
    (id
      ? db.db
          .prepare(
            'SELECT id,title,kind,hash,model FROM wardrobe WHERE published=1 AND id=?',
          )
          .all(id)
      : db.db
          .prepare(
            'SELECT id,title,kind,hash,model FROM wardrobe WHERE published=1 ORDER BY rowid DESC LIMIT ? OFFSET ?',
          )
          .all(TEXTURE_PAGE_SIZE, offset)) as unknown as Texture[];
  app.get('/api/library', async (req) => {
    const query = record(req.query),
      offset = Number(query.offset ?? 0);
    requireThat(Number.isSafeInteger(offset) && offset >= 0 && offset <= 10000);
    return {
      items: localItems(offset).map((item) => ({
        ...item,
        textureUrl: `/textures/${item.hash}`,
      })),
    };
  });
  app.patch('/api/wardrobe/:id', async (req) => {
    const owner = account(req.headers.authorization),
      id = record(req.params).id,
      body = record(req.body);
    own(id, owner.id);
    requireThat(
      typeof body.title === 'string' &&
        body.title.trim().length <= 80 &&
        typeof body.published === 'boolean',
    );
    db.db
      .prepare(
        'UPDATE wardrobe SET title=?,published=? WHERE id=? AND account=?',
      )
      .run(body.title.trim(), body.published ? 1 : 0, field(id), owner.id);
    return { ok: true };
  });
  app.post('/api/wardrobe/:id/apply', async (req) => {
    const owner = account(req.headers.authorization),
      item = own(record(req.params).id, owner.id);
    const body = req.body === undefined ? {} : record(req.body);
    db.setTexture(
      owner,
      body.profileId === undefined
        ? db.profileId(owner)
        : field(body.profileId),
      String(item.kind),
      String(item.hash),
      String(item.model),
    );
    return { ok: true };
  });
  app.post('/api/library/:id/save', async (req) => {
    const owner = account(req.headers.authorization);
    const item = db.db
      .prepare('SELECT * FROM wardrobe WHERE id=? AND published=1')
      .get(field(record(req.params).id));
    requireThat(item, 'Texture not found');
    db.db
      .prepare(
        'INSERT OR IGNORE INTO wardrobe(id,account,title,kind,hash,model) VALUES(?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        owner.id,
        item.title,
        item.kind,
        item.hash,
        item.model,
      );
    return { ok: true };
  });
  app.delete('/api/wardrobe/:id', async (req, reply) => {
    const owner = account(req.headers.authorization),
      id = record(req.params).id;
    own(id, owner.id);
    db.db
      .prepare('DELETE FROM wardrobe WHERE id=? AND account=?')
      .run(field(id), owner.id);
    return reply.code(204).send();
  });
}
