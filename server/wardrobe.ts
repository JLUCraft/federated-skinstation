import {
  MAX_TAGS,
  MAX_TAG_LENGTH,
  MAX_SEARCH_LENGTH,
  TEXTURE_PAGE_SIZE,
  type LibrarySort,
  type TextureKind,
} from '../shared/wardrobe.js';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Store, now, requireThat } from './store.js';
import { bearer, field, record } from './validate.js';

type Texture = {
  id: string;
  title: string;
  kind: 'skin' | 'cape';
  hash: string;
  model: 'default' | 'slim';
  likes: number;
  tags: string[];
};
interface LibraryFilter {
  search?: string;
  kind?: TextureKind;
  tag?: string;
  sort: LibrarySort;
}
const TAG_PATTERN = /^[^\s,#<>&"'\\\p{Cc}]+$/u;
const validTag = (tag: unknown): tag is string =>
  typeof tag === 'string' &&
  [...tag].length <= MAX_TAG_LENGTH &&
  TAG_PATTERN.test(tag);
function libraryFilter(query: Record<string, unknown>): LibraryFilter {
  const search = query.q === undefined ? undefined : field(query.q, MAX_SEARCH_LENGTH * 4);
  requireThat(search === undefined || [...search].length <= MAX_SEARCH_LENGTH);
  requireThat(
    query.kind === undefined || query.kind === 'skin' || query.kind === 'cape',
  );
  requireThat(
    query.sort === undefined || query.sort === 'new' || query.sort === 'likes',
  );
  requireThat(query.tag === undefined || validTag(query.tag));
  return {
    search,
    kind: query.kind as TextureKind | undefined,
    tag: query.tag as string | undefined,
    sort: (query.sort as LibrarySort | undefined) ?? 'new',
  };
}
export function registerWardrobe(app: FastifyInstance, db: Store) {
  db.db
    .exec(`CREATE TABLE IF NOT EXISTS wardrobe(id TEXT PRIMARY KEY,account TEXT NOT NULL REFERENCES accounts(id),title TEXT NOT NULL,kind TEXT NOT NULL,hash TEXT NOT NULL,model TEXT NOT NULL,published INTEGER NOT NULL DEFAULT 0,UNIQUE(account,kind,hash,model));
    INSERT OR IGNORE INTO wardrobe(id,account,title,kind,hash,model) SELECT lower(hex(randomblob(16))),account,'',kind,hash,model FROM profile_textures;
    CREATE TABLE IF NOT EXISTS texture_likes(item TEXT NOT NULL REFERENCES wardrobe(id) ON DELETE CASCADE,account TEXT NOT NULL REFERENCES accounts(id),PRIMARY KEY(item,account));
    CREATE TABLE IF NOT EXISTS texture_tags(item TEXT NOT NULL REFERENCES wardrobe(id) ON DELETE CASCADE,tag TEXT NOT NULL COLLATE NOCASE,PRIMARY KEY(item,tag));`);
  const account = (header: string | undefined) => {
    return db.token(bearer(header), undefined, now());
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
        likes: likeCount(String(item.id)),
        tags: tagsOf(String(item.id)),
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
  const likeCount = (item: string) =>
    Number(
      (
        db.db
          .prepare('SELECT count(*) AS n FROM texture_likes WHERE item=?')
          .get(item) as { n: number }
      ).n,
    );
  const tagsOf = (item: string) =>
    (
      db.db
        .prepare('SELECT tag FROM texture_tags WHERE item=? ORDER BY rowid')
        .all(item) as { tag: string }[]
    ).map((row) => row.tag);
  const localItems = (offset: number, filter: LibraryFilter) => {
    const clauses = ['w.published=1'];
    const values: (string | number)[] = [];
    if (filter.kind) {
      clauses.push('w.kind=?');
      values.push(filter.kind);
    }
    if (filter.search) {
      clauses.push("w.title LIKE ? ESCAPE '\\'");
      values.push(`%${filter.search.replace(/[\\%_]/g, '\\$&')}%`);
    }
    if (filter.tag) {
      clauses.push(
        'EXISTS(SELECT 1 FROM texture_tags t WHERE t.item=w.id AND t.tag=?)',
      );
      values.push(filter.tag);
    }
    const order =
      filter.sort === 'likes' ? 'likes DESC,w.rowid DESC' : 'w.rowid DESC';
    const rows = db.db
      .prepare(
        `SELECT w.id,w.title,w.kind,w.hash,w.model,(SELECT count(*) FROM texture_likes l WHERE l.item=w.id) AS likes FROM wardrobe w WHERE ${clauses.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...values, TEXTURE_PAGE_SIZE, offset) as Omit<
      Texture,
      'tags'
    >[];
    return rows.map((row) => ({
      ...row,
      likes: Number(row.likes),
      tags: tagsOf(row.id),
    })) as Texture[];
  };
  const viewer = (header: string | undefined) => {
    try {
      return account(header).id;
    } catch {
      return undefined;
    }
  };
  app.get('/api/library', async (req) => {
    const query = record(req.query),
      offset = Number(query.offset ?? 0),
      filter = libraryFilter(query),
      reader = req.headers.authorization
        ? viewer(req.headers.authorization)
        : undefined;
    requireThat(Number.isSafeInteger(offset) && offset >= 0 && offset <= 10000);
    return {
      items: localItems(offset, filter).map((item) => ({
        ...item,
        liked:
          reader !== undefined &&
          !!db.db
            .prepare('SELECT 1 FROM texture_likes WHERE item=? AND account=?')
            .get(item.id, reader),
        // Already in the viewer's wardrobe, so saving it again would do nothing.
        owned:
          reader !== undefined &&
          !!db.db
            .prepare(
              'SELECT 1 FROM wardrobe WHERE account=? AND kind=? AND hash=? AND model=?',
            )
            .get(reader, item.kind, item.hash, item.model),
      })),
    };
  });
  app.get('/api/library/tags', async () => ({
    tags: db.db
      .prepare(
        'SELECT t.tag AS tag,count(*) AS count FROM texture_tags t JOIN wardrobe w ON w.id=t.item WHERE w.published=1 GROUP BY t.tag ORDER BY count DESC,t.tag LIMIT 20',
      )
      .all(),
  }));
  app.post('/api/library/:id/like', async (req) => {
    const reader = account(req.headers.authorization),
      id = field(record(req.params).id),
      liked = record(req.body).liked;
    requireThat(typeof liked === 'boolean');
    requireThat(
      db.db
        .prepare('SELECT 1 FROM wardrobe WHERE id=? AND published=1')
        .get(id),
      'Texture not found',
    );
    db.db
      .prepare(
        liked
          ? 'INSERT OR IGNORE INTO texture_likes VALUES(?,?)'
          : 'DELETE FROM texture_likes WHERE item=? AND account=?',
      )
      .run(id, reader.id);
    return { liked, likes: likeCount(id) };
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
    const tags =
      body.tags === undefined
        ? undefined
        : [...new Set(body.tags as unknown[])];
    requireThat(
      tags === undefined ||
        (Array.isArray(body.tags) &&
          tags.length <= MAX_TAGS &&
          tags.every(validTag)),
    );
    const title = body.title.trim();
    db.transaction(() => {
      db.db
        .prepare(
          'UPDATE wardrobe SET title=?,published=? WHERE id=? AND account=?',
        )
        .run(title, body.published ? 1 : 0, field(id), owner.id);
      if (tags) {
        db.db.prepare('DELETE FROM texture_tags WHERE item=?').run(field(id));
        for (const tag of tags)
          db.db
            .prepare('INSERT OR IGNORE INTO texture_tags VALUES(?,?)')
            .run(field(id), tag as string);
      }
    });
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
