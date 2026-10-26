import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Store, now, requireThat } from './store.js';
import { bearer, field, record } from './validate.js';
import { TEXTURE_PAGE_SIZE } from '../shared/wardrobe.js';
import {
  MAX_LIST_OFFSET,
  MAX_REVIEW_REASON_LENGTH,
  MAX_ANNOUNCEMENT_TITLE_LENGTH,
  MAX_ANNOUNCEMENT_CONTENT_LENGTH,
  MAX_ANNOUNCEMENT_PRIORITY,
  SEVERITIES,
  REVIEW_STATES,
} from '../shared/community.js';

export const PUBLIC_TEXTURE =
  "w.published=1 AND EXISTS(SELECT 1 FROM texture_reviews r WHERE r.item=w.id AND r.state='approved')";
export function communitySchema(db: Store) {
  db.db
    .exec(`CREATE TABLE IF NOT EXISTS wardrobe(id TEXT PRIMARY KEY,account TEXT NOT NULL REFERENCES accounts(id),title TEXT NOT NULL,kind TEXT NOT NULL,hash TEXT NOT NULL,model TEXT NOT NULL,published INTEGER NOT NULL DEFAULT 0,UNIQUE(account,kind,hash,model));
    CREATE TABLE IF NOT EXISTS texture_likes(item TEXT NOT NULL REFERENCES wardrobe(id) ON DELETE CASCADE,account TEXT NOT NULL REFERENCES accounts(id),PRIMARY KEY(item,account));
    CREATE TABLE IF NOT EXISTS texture_tags(item TEXT NOT NULL REFERENCES wardrobe(id) ON DELETE CASCADE,tag TEXT NOT NULL COLLATE NOCASE,PRIMARY KEY(item,tag));
    CREATE TABLE IF NOT EXISTS texture_metadata(item TEXT PRIMARY KEY REFERENCES wardrobe(id) ON DELETE CASCADE,source TEXT NOT NULL,license TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS texture_reviews(item TEXT PRIMARY KEY REFERENCES wardrobe(id) ON DELETE CASCADE,state TEXT NOT NULL,reason TEXT NOT NULL,reviewer TEXT,updated_at INTEGER NOT NULL,submission TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS texture_downloads(item TEXT NOT NULL REFERENCES wardrobe(id) ON DELETE CASCADE,visitor TEXT NOT NULL,day INTEGER NOT NULL,PRIMARY KEY(item,visitor,day));
    CREATE TABLE IF NOT EXISTS texture_saves(item TEXT NOT NULL REFERENCES wardrobe(id) ON DELETE CASCADE,account TEXT NOT NULL REFERENCES accounts(id),PRIMARY KEY(item,account));
    CREATE TABLE IF NOT EXISTS texture_origins(item TEXT PRIMARY KEY REFERENCES wardrobe(id) ON DELETE CASCADE,origin TEXT REFERENCES wardrobe(id) ON DELETE SET NULL);
    CREATE TABLE IF NOT EXISTS site_avatars(account TEXT PRIMARY KEY REFERENCES accounts(id),hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,item TEXT NOT NULL REFERENCES wardrobe(id) ON DELETE CASCADE,reporter TEXT NOT NULL REFERENCES accounts(id),reason TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(item,reporter));
    CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,account TEXT NOT NULL REFERENCES accounts(id),kind TEXT NOT NULL,item TEXT REFERENCES wardrobe(id) ON DELETE SET NULL,title TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL,read_at INTEGER,state TEXT);
    CREATE TABLE IF NOT EXISTS announcements(id TEXT PRIMARY KEY,title TEXT NOT NULL,content TEXT NOT NULL,severity TEXT NOT NULL,priority INTEGER NOT NULL,expand INTEGER NOT NULL,published_at INTEGER NOT NULL,author TEXT NOT NULL REFERENCES accounts(id));
    CREATE INDEX IF NOT EXISTS notifications_account_time ON notifications(account,created_at);
    CREATE INDEX IF NOT EXISTS reports_status_item ON reports(status,item);
    CREATE INDEX IF NOT EXISTS wardrobe_account_public ON wardrobe(account,published);`);
}
export function notify(
  db: Store,
  account: string,
  kind: string,
  item: string,
  title: string,
  detail = '',
  state: 'approved' | 'rejected' | null = null,
) {
  db.db
    .prepare('INSERT INTO notifications VALUES(?,?,?,?,?,?,?,NULL,?)')
    .run(randomUUID(), account, kind, item, title, detail, now(), state);
}
export function registerCommunity(
  app: FastifyInstance,
  db: Store,
  admins: string[],
) {
  communitySchema(db);
  const account = (header: unknown) =>
    db.token(bearer(header), undefined, now());
  const admin = (header: unknown) => {
    const a = account(header);
    requireThat(admins.includes(a.id), 'Site administrator required');
    return a;
  };
  app.put('/api/me/avatar', async (req) => {
    const a = account(req.headers.authorization),
      id = field(record(req.body).item);
    const row = db.db
      .prepare(
        "SELECT hash FROM wardrobe WHERE id=? AND account=? AND kind='skin'",
      )
      .get(id, a.id);
    requireThat(row, 'Skin not in wardrobe');
    db.db
      .prepare(
        'INSERT INTO site_avatars VALUES(?,?) ON CONFLICT(account) DO UPDATE SET hash=excluded.hash',
      )
      .run(a.id, row.hash!);
    return { hash: row.hash };
  });
  app.get('/api/announcements', async () => ({
    announcements: db.db
      .prepare(
        'SELECT id,title,content,severity,priority,expand,published_at FROM announcements WHERE published_at<=? ORDER BY priority DESC,published_at DESC LIMIT ?',
      )
      .all(now(), TEXTURE_PAGE_SIZE),
  }));
  app.get('/api/admin/announcements', async (req) => {
    admin(req.headers.authorization);
    const offset = Number(record(req.query).offset ?? 0);
    requireThat(
      Number.isSafeInteger(offset) && offset >= 0 && offset <= MAX_LIST_OFFSET,
    );
    return {
      announcements: db.db
        .prepare(
          'SELECT id,title,content,severity,priority,expand,published_at FROM announcements ORDER BY priority DESC,published_at DESC,rowid DESC LIMIT ? OFFSET ?',
        )
        .all(TEXTURE_PAGE_SIZE, offset),
    };
  });
  app.post('/api/admin/announcements', async (req) => {
    const a = admin(req.headers.authorization),
      b = record(req.body);
    requireThat(SEVERITIES.includes(b.severity as (typeof SEVERITIES)[number]));
    requireThat(
      Number.isSafeInteger(b.priority) &&
        Number(b.priority) >= 0 &&
        Number(b.priority) <= MAX_ANNOUNCEMENT_PRIORITY,
    );
    requireThat(typeof b.expand === 'boolean');
    const id = b.id === undefined ? randomUUID() : field(b.id);
    db.db
      .prepare(
        'INSERT INTO announcements VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,severity=excluded.severity,priority=excluded.priority,expand=excluded.expand',
      )
      .run(
        id,
        field(b.title, MAX_ANNOUNCEMENT_TITLE_LENGTH),
        field(b.content, MAX_ANNOUNCEMENT_CONTENT_LENGTH),
        String(b.severity),
        Number(b.priority),
        b.expand ? 1 : 0,
        now(),
        a.id,
      );
    return { id };
  });
  app.delete('/api/admin/announcements/:id', async (req, reply) => {
    admin(req.headers.authorization);
    db.db
      .prepare('DELETE FROM announcements WHERE id=?')
      .run(field(record(req.params).id));
    return reply.code(204).send();
  });
  app.get('/api/notifications', async (req) => {
    const a = account(req.headers.authorization),
      offset = Number(record(req.query).offset ?? 0);
    requireThat(
      Number.isSafeInteger(offset) && offset >= 0 && offset <= MAX_LIST_OFFSET,
    );
    return {
      unread: Number(
        db.db
          .prepare(
            'SELECT count(*) AS n FROM notifications WHERE account=? AND read_at IS NULL',
          )
          .get(a.id)!.n,
      ),
      items: db.db
        .prepare(
          `SELECT n.id,n.kind,n.item,n.title,n.detail,n.created_at,n.read_at,n.state,
             w.hash,w.kind AS item_kind,w.title AS item_title
             FROM notifications n LEFT JOIN wardrobe w ON w.id=n.item
             WHERE n.account=? ORDER BY n.created_at DESC,n.rowid DESC LIMIT ? OFFSET ?`,
        )
        .all(a.id, TEXTURE_PAGE_SIZE, offset),
    };
  });
  app.post('/api/notifications/read-all', async (req) => {
    const a = account(req.headers.authorization);
    db.db
      .prepare(
        'UPDATE notifications SET read_at=? WHERE account=? AND read_at IS NULL',
      )
      .run(now(), a.id);
    return { ok: true };
  });
  app.post('/api/notifications/read', async (req) => {
    const a = account(req.headers.authorization),
      id = field(record(req.body).id);
    db.db
      .prepare(
        'UPDATE notifications SET read_at=? WHERE id=? AND account=? AND read_at IS NULL',
      )
      .run(now(), id, a.id);
    return { ok: true };
  });
  app.post('/api/library/:id/report', async (req) => {
    const a = account(req.headers.authorization),
      id = field(record(req.params).id),
      reason = field(record(req.body).reason, MAX_REVIEW_REASON_LENGTH).trim();
    requireThat(reason.length > 0);
    requireThat(
      db.db
        .prepare(`SELECT 1 FROM wardrobe w WHERE w.id=? AND ${PUBLIC_TEXTURE}`)
        .get(id),
      'Texture not found',
    );
    db.rate(`report:${a.id}`, now(), 10, 3600);
    db.db
      .prepare(
        "INSERT INTO reports VALUES(?,?,?,?, 'open', ?) ON CONFLICT(item,reporter) DO UPDATE SET reason=excluded.reason,status='open',created_at=excluded.created_at WHERE reports.status='resolved'",
      )
      .run(randomUUID(), id, a.id, reason, now());
    return { ok: true };
  });
  app.get('/api/admin/reviews', async (req) => {
    admin(req.headers.authorization);
    const q = record(req.query),
      state = q.state ?? 'pending',
      offset = Number(q.offset ?? 0);
    requireThat(
      REVIEW_STATES.includes(state as (typeof REVIEW_STATES)[number]),
    );
    requireThat(
      Number.isSafeInteger(offset) && offset >= 0 && offset <= MAX_LIST_OFFSET,
    );
    return {
      items: db.db
        .prepare(
          `SELECT w.*,COALESCE(r.state,'pending') AS state,COALESCE(r.reason,'') AS reason,r.submission,m.source,m.license,a.name AS authorName FROM wardrobe w LEFT JOIN texture_reviews r ON r.item=w.id JOIN accounts a ON a.id=w.account LEFT JOIN texture_metadata m ON m.item=w.id WHERE r.state=? OR (w.published=1 AND r.item IS NULL AND ?='pending') OR EXISTS(SELECT 1 FROM reports p WHERE p.item=w.id AND p.status='open') ORDER BY r.updated_at,w.id LIMIT ? OFFSET ?`,
        )
        .all(String(state), String(state), TEXTURE_PAGE_SIZE, offset),
      reports: db.db
        .prepare(
          "SELECT p.id,p.item,p.reason,p.created_at FROM reports p WHERE p.status='open' ORDER BY p.created_at LIMIT 200",
        )
        .all(),
    };
  });
  app.post('/api/admin/reviews/:id', async (req) => {
    const a = admin(req.headers.authorization),
      id = field(record(req.params).id),
      b = record(req.body);
    requireThat(b.state === 'approved' || b.state === 'rejected');
    const state = b.state;
    const submission = b.submission === null ? null : field(b.submission);
    const reason = field(b.reason, MAX_REVIEW_REASON_LENGTH).trim();
    requireThat(reason.length > 0);
    db.transaction(() => {
      const item = db.db
        .prepare(
          'SELECT w.* FROM wardrobe w LEFT JOIN texture_reviews r ON r.item=w.id WHERE w.id=? AND (r.submission=? OR (r.item IS NULL AND w.published=1 AND ? IS NULL))',
        )
        .get(id, submission, submission);
      requireThat(item, 'Texture not found');
      db.db
        .prepare(
          'INSERT INTO texture_reviews(item,state,reason,reviewer,updated_at,submission) VALUES(?,?,?,?,?,?) ON CONFLICT(item) DO UPDATE SET state=excluded.state,reason=excluded.reason,reviewer=excluded.reviewer,updated_at=excluded.updated_at,submission=excluded.submission',
        )
        .run(id, state, reason, a.id, now(), randomUUID());
      db.db
        .prepare("UPDATE reports SET status='resolved' WHERE item=?")
        .run(id);
      notify(
        db,
        String(item.account),
        'review',
        id,
        String(item.title),
        reason,
        state,
      );
    });
    return { ok: true };
  });
}
