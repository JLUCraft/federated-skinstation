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
import { Store, now, requireThat, Rejected } from './store.js';
import { communitySchema, PUBLIC_TEXTURE, notify } from './community.js';
import {
  MAX_LIST_OFFSET,
  MAX_LICENSE_LENGTH,
  SOURCES,
} from '../shared/community.js';
import { digest } from './store.js';
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
  school?: string;
  author?: string;
  sort: LibrarySort;
}
const TAG_PATTERN = /^[^\s,#<>&"'\\\p{Cc}]+$/u;
const validTag = (tag: unknown): tag is string =>
  typeof tag === 'string' &&
  [...tag].length <= MAX_TAG_LENGTH &&
  TAG_PATTERN.test(tag);
function libraryFilter(query: Record<string, unknown>): LibraryFilter {
  const search =
    query.q === undefined ? undefined : field(query.q, MAX_SEARCH_LENGTH * 4);
  requireThat(search === undefined || [...search].length <= MAX_SEARCH_LENGTH);
  requireThat(
    query.kind === undefined || query.kind === 'skin' || query.kind === 'cape',
  );
  requireThat(
    query.sort === undefined ||
      query.sort === 'new' ||
      ['likes', 'downloads', 'saves'].includes(String(query.sort)),
  );
  requireThat(query.tag === undefined || validTag(query.tag));
  return {
    school: query.school === undefined ? undefined : field(query.school, 64),
    author: query.author === undefined ? undefined : field(query.author, 64),
    search,
    kind: query.kind as TextureKind | undefined,
    tag: query.tag as string | undefined,
    sort: (query.sort as LibrarySort | undefined) ?? 'new',
  };
}
export function registerWardrobe(
  app: FastifyInstance,
  db: Store,
  admins: string[],
) {
  communitySchema(db);
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
    requireThat(
      Number.isSafeInteger(offset) && offset >= 0 && offset <= MAX_LIST_OFFSET,
    );
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
        ...details(String(item.id), true),
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
  const details = (id: string, includeReviewReason = false) => {
    const row = db.db
      .prepare(
        `SELECT w.id,a.name AS authorName,a.school,w.account AS authorId,v.hash AS avatar,m.source,m.license,r.state,r.reason AS reviewReason,
      (SELECT count(*) FROM texture_downloads d WHERE d.item=w.id) AS downloads,
      (SELECT count(*) FROM texture_saves s WHERE s.item=w.id) AS saves,
      CASE WHEN ${PUBLIC_TEXTURE} THEN 1 ELSE 0 END AS visible
      FROM wardrobe w JOIN accounts a ON a.id=w.account LEFT JOIN site_avatars v ON v.account=a.id LEFT JOIN texture_metadata m ON m.item=w.id LEFT JOIN texture_reviews r ON r.item=w.id WHERE w.id=?`,
      )
      .get(id);
    if (!row) throw new Rejected('Texture not found', 404, 'Not Found');
    const { reviewReason, ...publicFields } = row;
    return {
      ...publicFields,
      ...(includeReviewReason ? { reviewReason } : {}),
      source: row.source ?? 'unknown',
      license: row.license ?? '',
      public: row.visible === 1,
    };
  };
  const localItems = (offset: number, filter: LibraryFilter) => {
    const clauses = [PUBLIC_TEXTURE];
    const values: (string | number)[] = [];
    if (filter.school) {
      clauses.push('w.account IN (SELECT id FROM accounts WHERE school=?)');
      values.push(filter.school);
    }
    if (filter.author) {
      clauses.push('w.account=?');
      values.push(filter.author);
    }
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
      filter.sort === 'new'
        ? 'w.rowid DESC'
        : `${filter.sort} DESC,w.rowid DESC`;
    const rows = db.db
      .prepare(
        `SELECT w.id,w.title,w.kind,w.hash,w.model,(SELECT count(*) FROM texture_likes l WHERE l.item=w.id) AS likes,(SELECT count(*) FROM texture_downloads d WHERE d.item=w.id) AS downloads,(SELECT count(*) FROM texture_saves s WHERE s.item=w.id) AS saves FROM wardrobe w WHERE ${clauses.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...values, TEXTURE_PAGE_SIZE, offset) as Omit<Texture, 'tags'>[];
    return rows.map((row) => ({
      ...row,
      ...details(row.id),
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
  const viewerState = (
    item: { id: string; kind: string; hash: string; model: string },
    reader?: string,
  ) => ({
    liked:
      reader !== undefined &&
      !!db.db
        .prepare('SELECT 1 FROM texture_likes WHERE item=? AND account=?')
        .get(item.id, reader),
    owned:
      reader !== undefined &&
      !!db.db
        .prepare(
          'SELECT 1 FROM wardrobe WHERE account=? AND kind=? AND hash=? AND model=?',
        )
        .get(reader, item.kind, item.hash, item.model),
  });
  app.get('/api/library', async (req) => {
    const query = record(req.query),
      offset = Number(query.offset ?? 0),
      filter = libraryFilter(query),
      reader = req.headers.authorization
        ? viewer(req.headers.authorization)
        : undefined;
    requireThat(
      Number.isSafeInteger(offset) && offset >= 0 && offset <= MAX_LIST_OFFSET,
    );
    return {
      items: localItems(offset, filter).map((item) => ({
        ...item,
        ...viewerState(item, reader),
      })),
    };
  });
  app.get('/api/library/tags', async () => ({
    tags: db.db
      .prepare(
        `SELECT t.tag AS tag,count(*) AS count FROM texture_tags t JOIN wardrobe w ON w.id=t.item WHERE ${PUBLIC_TEXTURE} GROUP BY t.tag ORDER BY count DESC,t.tag LIMIT 20`,
      )
      .all(),
  }));
  app.get('/api/library/:id', async (req) => {
    const id = field(record(req.params).id);
    const item = db.db
      .prepare(
        `SELECT w.id,w.title,w.kind,w.hash,w.model FROM wardrobe w WHERE w.id=? AND ${PUBLIC_TEXTURE}`,
      )
      .get(id);
    requireThat(item, 'Texture not found');
    return {
      ...item,
      ...details(id),
      ...viewerState(
        {
          id,
          kind: String(item.kind),
          hash: String(item.hash),
          model: String(item.model),
        },
        req.headers.authorization
          ? viewer(req.headers.authorization)
          : undefined,
      ),
      tags: tagsOf(id),
      likes: likeCount(id),
    };
  });
  app.get('/api/library/:id/download', async (req, reply) => {
    const id = field(record(req.params).id);
    const item = db.db
      .prepare(
        `SELECT w.hash FROM wardrobe w WHERE w.id=? AND ${PUBLIC_TEXTURE}`,
      )
      .get(id);
    requireThat(item, 'Texture not found');
    db.db
      .prepare('INSERT OR IGNORE INTO texture_downloads VALUES(?,?,?)')
      .run(id, digest(req.ip), Math.floor(now() / 86400));
    return reply.redirect(`/textures/${item.hash}`);
  });
  app.get('/api/users/:id', async (req) => {
    const id = field(record(req.params).id);
    const offset = Number(record(req.query).offset ?? 0);
    requireThat(
      Number.isSafeInteger(offset) && offset >= 0 && offset <= MAX_LIST_OFFSET,
    );
    const a = db.account('id', id);
    requireThat(a, 'Author not found');
    return {
      id: a.id,
      name: a.name,
      school: a.school,
      avatar:
        db.db.prepare('SELECT hash FROM site_avatars WHERE account=?').get(id)
          ?.hash ?? null,
      items: localItems(offset, { sort: 'new', author: id }),
      saves: db.db
        .prepare(
          `SELECT count(*) AS n FROM texture_saves s JOIN wardrobe w ON w.id=s.item WHERE w.account=? AND ${PUBLIC_TEXTURE}`,
        )
        .get(id)!.n,
    };
  });
  app.post('/api/library/:id/like', async (req) => {
    const reader = account(req.headers.authorization),
      id = field(record(req.params).id),
      liked = record(req.body).liked;
    requireThat(typeof liked === 'boolean');
    requireThat(
      db.db
        .prepare(`SELECT 1 FROM wardrobe w WHERE w.id=? AND ${PUBLIC_TEXTURE}`)
        .get(id),
      'Texture not found',
    );
    db.transaction(() => {
      const changed = db.db
        .prepare(
          liked
            ? 'INSERT OR IGNORE INTO texture_likes VALUES(?,?)'
            : 'DELETE FROM texture_likes WHERE item=? AND account=?',
        )
        .run(id, reader.id);
      if (liked && Number(changed.changes) > 0) {
        const item = db.db
          .prepare('SELECT account,title FROM wardrobe WHERE id=?')
          .get(id)!;
        // One notification per actor and item, even after toggling a like.
        if (
          item.account !== reader.id &&
          !db.db
            .prepare(
              "SELECT 1 FROM notifications WHERE account=? AND kind='like' AND item=? AND detail=?",
            )
            .get(item.account!, id, reader.id)
        )
          notify(
            db,
            String(item.account),
            'like',
            id,
            String(item.title),
            reader.id,
          );
      }
    });
    return { liked, likes: likeCount(id) };
  });
  app.patch('/api/wardrobe/:id', async (req) => {
    const owner = account(req.headers.authorization),
      id = record(req.params).id,
      body = record(req.body);
    const previous = own(id, owner.id);
    requireThat(
      typeof body.title === 'string' &&
        body.title.trim().length <= 80 &&
        typeof body.published === 'boolean',
    );
    requireThat(body.tags === undefined || Array.isArray(body.tags));
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
    const metadata = db.db
      .prepare('SELECT source,license FROM texture_metadata WHERE item=?')
      .get(field(id));
    const source = body.source ?? metadata?.source ?? 'unknown';
    const license = body.license ?? metadata?.license ?? '';
    requireThat(SOURCES.includes(source as (typeof SOURCES)[number]));
    requireThat(
      typeof license === 'string' && license.length <= MAX_LICENSE_LENGTH,
    );
    requireThat(
      !body.published ||
        !db.db
          .prepare('SELECT 1 FROM texture_origins WHERE item=?')
          .get(field(id)),
      'Collected textures cannot be published',
    );
    requireThat(
      !body.published || admins.length > 0,
      'Publication requires a site administrator',
    );
    const title = body.title.trim();
    db.transaction(() => {
      db.db
        .prepare(
          'UPDATE wardrobe SET title=?,published=? WHERE id=? AND account=?',
        )
        .run(title, body.published ? 1 : 0, field(id), owner.id);
      db.db
        .prepare(
          'INSERT INTO texture_metadata VALUES(?,?,?) ON CONFLICT(item) DO UPDATE SET source=excluded.source,license=excluded.license',
        )
        .run(field(id), String(source), license);
      const changed =
        !db.db
          .prepare('SELECT 1 FROM texture_reviews WHERE item=?')
          .get(field(id)) ||
        previous.title !== title ||
        previous.published !== 1 ||
        (metadata?.source ?? 'unknown') !== source ||
        (metadata?.license ?? '') !== license ||
        (tags !== undefined &&
          JSON.stringify(tagsOf(field(id))) !== JSON.stringify(tags));
      if (body.published && changed)
        db.db
          .prepare(
            "INSERT INTO texture_reviews VALUES(?,'pending','',NULL,?,?) ON CONFLICT(item) DO UPDATE SET state='pending',reason='',reviewer=NULL,updated_at=excluded.updated_at,submission=excluded.submission",
          )
          .run(field(id), now(), randomUUID());
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
      .prepare(`SELECT * FROM wardrobe w WHERE w.id=? AND ${PUBLIC_TEXTURE}`)
      .get(field(record(req.params).id));
    requireThat(item, 'Texture not found');
    db.transaction(() => {
      const copyId = randomUUID();
      const result = db.db
        .prepare(
          'INSERT OR IGNORE INTO wardrobe(id,account,title,kind,hash,model) VALUES(?,?,?,?,?,?)',
        )
        .run(
          copyId,
          owner.id,
          item.title!,
          item.kind!,
          item.hash!,
          item.model!,
        );
      if (Number(result.changes) > 0) {
        db.db
          .prepare('INSERT INTO texture_origins VALUES(?,?)')
          .run(copyId, item.id!);
        const meta = details(String(item.id));
        db.db
          .prepare('INSERT INTO texture_metadata VALUES(?,?,?)')
          .run(copyId, String(meta.source), String(meta.license));
        for (const tag of tagsOf(String(item.id)))
          db.db
            .prepare('INSERT INTO texture_tags VALUES(?,?)')
            .run(copyId, tag);
      }
      if (item.account !== owner.id) {
        const saved = db.db
          .prepare('INSERT OR IGNORE INTO texture_saves VALUES(?,?)')
          .run(item.id!, owner.id);
        if (Number(saved.changes) > 0)
          notify(
            db,
            String(item.account),
            'save',
            String(item.id),
            String(item.title),
          );
      }
    });
    return { ok: true };
  });
  app.delete('/api/wardrobe/:id', async (req, reply) => {
    const owner = account(req.headers.authorization),
      id = record(req.params).id;
    own(id, owner.id);
    db.transaction(() => {
      const origin = db.db
        .prepare('SELECT origin FROM texture_origins WHERE item=?')
        .get(field(id));
      if (origin?.origin)
        db.db
          .prepare('DELETE FROM texture_saves WHERE item=? AND account=?')
          .run(origin.origin, owner.id);
      db.db
        .prepare('DELETE FROM wardrobe WHERE id=? AND account=?')
        .run(field(id), owner.id);
    });
    return reply.code(204).send();
  });
}
