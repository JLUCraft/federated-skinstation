import React, { useEffect, useState } from 'react';
import { apiRequest, errorText } from './api';
import { t, tf } from './i18n';
import {
  Avatar,
  Author,
  TextureProvenance,
  TextureCounts,
  SOURCE_LABELS,
  STATE_LABELS,
} from './TextureIdentity';
import { TEXTURE_PAGE_SIZE } from '../shared/wardrobe';
import {
  MAX_REVIEW_REASON_LENGTH,
  MAX_ANNOUNCEMENT_TITLE_LENGTH,
  MAX_ANNOUNCEMENT_CONTENT_LENGTH,
  MAX_ANNOUNCEMENT_PRIORITY,
  type Announcement,
  type Notice,
} from '../shared/community';
import type { TextureItem } from '../shared/wardrobe';
import { SkinPreview } from './SkinPreview';
import { TextureCard } from './TextureCard';
import { textureSrc, textureTitle } from './TextureDialog';
import { TextureThumb } from './TextureThumb';

const SEVERITY_LABELS: Record<Announcement['severity'], string> = {
  info: t('信息'),
  warning: t('提醒'),
  danger: t('紧急'),
};

const COMPACT_HEADER_QUERY = '(max-width: 600px)';

export function Announcements() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [failed, setFailed] = useState(false);
  // 移动端首屏高度有限：公告默认折叠为单行，用户可自行展开。
  const [compact, setCompact] = useState(
    () => window.matchMedia(COMPACT_HEADER_QUERY).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(COMPACT_HEADER_QUERY);
    const sync = () => setCompact(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void apiRequest('/api/announcements')
        .then((r) => {
          if (active) {
            setItems(r.announcements);
            setFailed(false);
          }
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    };
    refresh();
    window.addEventListener('announcements-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.removeEventListener('announcements-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  return (
    <div className="announcement-list">
      {failed && <p role="alert">{t('公告加载失败')}</p>}
      {items.map((a) => (
        <details
          className={`panel disclosure announcement announcement--${a.severity}`}
          key={a.id}
          open={!compact && a.expand === 1}
        >
          <summary className="disclosure-trigger">{a.title}</summary>
          <p className="announcement-content">{a.content}</p>
        </details>
      ))}
    </div>
  );
}
export function Notifications({
  token,
  onRead,
}: {
  token: string;
  onRead: () => void;
}) {
  const [items, setItems] = useState<Notice[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [unread, setUnread] = useState(0),
    [offset, setOffset] = useState(0);
  const load = () =>
    apiRequest(`/api/notifications?offset=${offset}`, { token }).then((r) => {
      setItems(r.items);
      setUnread(r.unread);
      setError('');
    });
  useEffect(() => {
    let active = true;
    setLoading(true);
    void apiRequest(`/api/notifications?offset=${offset}`, { token })
      .then((r) => {
        if (active) {
          setItems(r.items);
          setUnread(r.unread);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token, offset]);
  return (
    <section className="panel" aria-busy={loading || busy}>
      <div className="section-head section-head--row">
        <h2 className="section-title">{t('站内通知')}</h2>
        {!loading && !error && unread > 0 && (
          <button
            className="btn btn--secondary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void apiRequest('/api/notifications/read-all', {
                method: 'POST',
                token,
              })
                .then(load)
                .then(onRead)
                .catch((e) => setError(errorText(e)))
                .finally(() => setBusy(false));
            }}
          >
            {t('全部标为已读')}
          </button>
        )}
      </div>
      {loading ? (
        <p role="status">{t('正在加载…')}</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : items.length === 0 ? (
        <p>{t('暂无通知')}</p>
      ) : (
        items.map((n) => {
          const href = n.item ? `/portal/library/${n.item}` : null;
          const label = n.item_title || n.title;
          return (
            <article
              className={`notice-card${n.read_at ? '' : ' notice-card--unread'}`}
              key={n.id}
            >
              <div className="notice-card-media" aria-hidden="true">
                {n.hash && n.item_kind ? (
                  <TextureThumb
                    url={`/textures/${n.hash}`}
                    kind={n.item_kind}
                    slim={false}
                  />
                ) : (
                  <span className="notice-card-placeholder">·</span>
                )}
              </div>
              <div className="notice-content">
                <strong className="notice-title">
                  {n.kind === 'like'
                    ? t('你的材质被点赞')
                    : n.kind === 'save'
                      ? t('你的材质被收藏')
                      : t('审核结果')}
                </strong>
                {href ? (
                  <a className="notice-link" href={href}>
                    {label}
                  </a>
                ) : (
                  <span className="notice-link">{label}</span>
                )}
                {n.kind === 'review' && (
                  <p>
                    {[n.state && STATE_LABELS[n.state], n.detail]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
                <time
                  className="notice-meta"
                  dateTime={new Date(n.created_at * 1000).toISOString()}
                >
                  {new Date(n.created_at * 1000).toLocaleString()}
                </time>
              </div>
              {!n.read_at && (
                <button
                  className="btn btn--secondary notice-action"
                  onClick={() => {
                    void apiRequest('/api/notifications/read', {
                      method: 'POST',
                      token,
                      body: { id: n.id },
                    })
                      .then(load)
                      .then(onRead)
                      .catch((e) => setError(errorText(e)));
                  }}
                >
                  {t('标为已读')}
                </button>
              )}
            </article>
          );
        })
      )}
      {!loading &&
        !error &&
        (offset > 0 || items.length === TEXTURE_PAGE_SIZE) && (
          <nav className="actions" aria-label={t('通知分页')}>
            <button
              className="btn btn--secondary"
              disabled={loading || offset === 0}
              onClick={() => setOffset(offset - TEXTURE_PAGE_SIZE)}
            >
              {t('上一页')}
            </button>
            <button
              className="btn btn--secondary"
              disabled={loading || items.length < TEXTURE_PAGE_SIZE}
              onClick={() => setOffset(offset + TEXTURE_PAGE_SIZE)}
            >
              {t('下一页')}
            </button>
          </nav>
        )}
    </section>
  );
}
export function PublicPage({ path, token }: { path: string; token?: string }) {
  const [data, setData] = useState<{
      id: string;
      name: string;
      school: string;
      avatar?: string;
      saves: number;
      items: TextureItem[];
    } | null>(null),
    [item, setItem] = useState<TextureItem | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [offset, setOffset] = useState(0);
  const author = path.startsWith('/u/');
  useEffect(() => {
    let active = true;
    setData(null);
    setItem(null);
    setError('');
    void apiRequest(
      `/api/${author ? 'users' : 'library'}/${encodeURIComponent(path.split('/')[2])}?offset=${offset}`,
      { token },
    )
      .then((r) => {
        if (active) {
          if (author) setData(r);
          else setItem(r);
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [path, author, token, offset]);
  const act = async (suffix: string, body: unknown) => {
    setBusy(true);
    try {
      await apiRequest(`/api/library/${item!.id}/${suffix}`, {
        method: 'POST',
        token,
        body,
      });
      if (suffix !== 'report')
        setItem(await apiRequest(`/api/library/${item!.id}`, { token }));
      setError('');
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <div className="detail-header">
        <a className="detail-back" href="/portal/library/">
          <span aria-hidden="true">←</span>
          {t('返回皮肤库')}
        </a>
        {author && data && (
          <div className="author-row">
            {data.avatar && <Avatar hash={data.avatar} />}
            <h2 className="section-title">{data.name}</h2>
            <span>{data.school.toUpperCase()}</span>
          </div>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {!data && !item && !error && <p role="status">{t('正在加载…')}</p>}
      {author && data && (
        <>
          <p>
            {t('收藏数')} · {data.saves}
          </p>
          {data.items.length === 0 && <p>{t('暂时没有公开材质')}</p>}
          <div className="wardrobe-grid">
            {data.items.map((i) => (
              <TextureCard item={i} library key={i.id} />
            ))}
          </div>
          <nav className="actions" aria-label={t('分页')}>
            <button
              className="btn btn--secondary"
              disabled={offset === 0}
              onClick={() => setOffset(offset - TEXTURE_PAGE_SIZE)}
            >
              {t('上一页')}
            </button>
            <button
              className="btn btn--secondary"
              disabled={data.items.length < TEXTURE_PAGE_SIZE}
              onClick={() => setOffset(offset + TEXTURE_PAGE_SIZE)}
            >
              {t('下一页')}
            </button>
          </nav>
        </>
      )}
      {!author && item && (
        <div className="texture-detail">
          <div className="texture-detail-preview">
            <SkinPreview
              textures={[item]}
              textureUrl={() => textureSrc(item)}
              emptyText={t('无法预览此材质')}
            />
          </div>
          <div className="texture-detail-info">
            <h2 className="section-title">{textureTitle(item)}</h2>
            <Author item={item} />
            <TextureProvenance item={item} />
            <TextureCounts item={item} />
            <div className="actions">
              <a
                className="btn btn--primary"
                href={`/api/library/${item.id}/download`}
                download={`${textureTitle(item)}.png`}
              >
                {t('下载')}
              </a>
              {token ? (
                <>
                  <button
                    className="btn btn--secondary"
                    disabled={busy || item.owned}
                    onClick={() => void act('save', {})}
                  >
                    {item.owned ? t('已在衣柜') : t('收藏到衣柜')}
                  </button>
                  <button
                    className="btn btn--secondary"
                    disabled={busy}
                    aria-pressed={item.liked === true}
                    onClick={() => void act('like', { liked: !item.liked })}
                  >
                    {t('点赞')}
                  </button>
                </>
              ) : (
                <a className="btn btn--secondary" href="/portal/">
                  {t('登录后收藏')}
                </a>
              )}
            </div>
            {token && (
              <div className="detail-danger">
                <ReportButton
                  busy={busy}
                  onReport={(reason) => act('report', { reason })}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
export function ReportButton({
  busy,
  onReport,
}: {
  busy: boolean;
  onReport: (reason: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false),
    [reason, setReason] = useState(''),
    [sent, setSent] = useState(false),
    [error, setError] = useState('');
  return (
    <div>
      {error && <p role="alert">{error}</p>}
      {sent ? (
        <span role="status">{t('举报已提交')}</span>
      ) : open ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onReport(reason)
              .then((ok) => {
                if (ok === false) {
                  setError(t('操作失败，请重试'));
                  return;
                }
                setSent(true);
                setOpen(false);
              })
              .catch((e) => setError(errorText(e)));
          }}
        >
          <label className="field-label">
            {t('举报原因')}
            <textarea
              className="input"
              required
              maxLength={MAX_REVIEW_REASON_LENGTH}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button className="btn btn--danger" disabled={busy}>
            {t('提交举报')}
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="btn btn--secondary"
          disabled={busy}
          onClick={() => setOpen(true)}
        >
          {t('举报')}
        </button>
      )}
    </div>
  );
}
export function AdminPanel({ token }: { token: string }) {
  const [items, setItems] = useState<TextureItem[]>([]),
    [reports, setReports] = useState<
      { id: string; item: string; reason: string }[]
    >([]),
    [announcements, setAnnouncements] = useState<Announcement[]>([]),
    [announcementOffset, setAnnouncementOffset] = useState(0),
    [edit, setEdit] = useState<Announcement | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [state, setState] = useState('pending'),
    [offset, setOffset] = useState(0);
  const load = async () => {
    const [r, a] = await Promise.all([
      apiRequest(`/api/admin/reviews?state=${state}&offset=${offset}`, {
        token,
      }),
      apiRequest(`/api/admin/announcements?offset=${announcementOffset}`, {
        token,
      }),
    ]);
    setItems(r.items);
    setReports(r.reports);
    setAnnouncements(a.announcements);
  };
  useEffect(() => {
    setLoading(true);
    void load()
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, [token, state, offset, announcementOffset]);
  const action = async (path: string, body?: unknown, method = 'POST') => {
    setBusy(true);
    try {
      await apiRequest(path, { token, method, body });
      if (path.startsWith('/api/admin/announcements'))
        window.dispatchEvent(new Event('announcements-changed'));
      await load();
      setError('');
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <h2>{t('站点管理')}</h2>
      {error && <p role="alert">{error}</p>}
      <h3>{t('审核队列')}</h3>
      <label className="field-label">
        {t('审核状态')}
        <select
          className="input"
          value={state}
          onChange={(e) => {
            setState(e.target.value);
            setOffset(0);
          }}
        >
          {Object.entries(STATE_LABELS).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {loading ? (
        <p role="status">{t('正在加载…')}</p>
      ) : items.length === 0 ? (
        <p>{t('没有待处理材质')}</p>
      ) : (
        items.map((i) => (
          <article className="notice-row" key={i.id}>
            <h3>
              {textureTitle(i)} · {i.authorName}
            </h3>
            <img
              className="texture-flat"
              src={textureSrc(i)}
              alt={textureTitle(i)}
            />
            <p>
              {SOURCE_LABELS[i.source ?? 'unknown']} · {i.license}
            </p>
            {reports
              .filter((r) => r.item === i.id)
              .map((r) => (
                <p key={r.id}>
                  {t('举报原因')}：{r.reason}
                </p>
              ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void action(`/api/admin/reviews/${i.id}`, {
                  submission: i.submission,
                  state: f.get('state'),
                  reason: f.get('reason'),
                });
              }}
            >
              <label className="field-label">
                {t('处理结果')}
                <select name="state" className="input">
                  <option value="approved">{t('审核通过')}</option>
                  <option value="rejected">{t('驳回或下架')}</option>
                </select>
              </label>
              <label className="field-label">
                {t('处理理由')}
                <input
                  name="reason"
                  className="input"
                  required
                  maxLength={MAX_REVIEW_REASON_LENGTH}
                  disabled={busy}
                />
              </label>
              <button className="btn btn--primary" disabled={busy}>
                {t('提交审核')}
              </button>
            </form>
          </article>
        ))
      )}
      <div className="actions">
        <button
          className="btn btn--secondary"
          disabled={offset === 0 || loading}
          onClick={() => setOffset(offset - TEXTURE_PAGE_SIZE)}
        >
          {t('上一页')}
        </button>
        <button
          className="btn btn--secondary"
          disabled={items.length < TEXTURE_PAGE_SIZE || loading}
          onClick={() => setOffset(offset + TEXTURE_PAGE_SIZE)}
        >
          {t('下一页')}
        </button>
      </div>
      <h3>{t('公告管理')}</h3>
      <div className="announcement-list">
        {announcements.map((a) => (
          <article className="admin-announcement" key={a.id}>
            <div className="admin-announcement-info">
              <h4 className="admin-announcement-title">{a.title}</h4>
              <div className="badge-row">
                <span
                  className={`status-pill severity-pill severity-pill--${a.severity}`}
                >
                  {SEVERITY_LABELS[a.severity]}
                </span>
                <span className="status-pill status-pill--neutral">
                  {tf('优先级 {priority}', { priority: a.priority })}
                </span>
              </div>
            </div>
            <div className="admin-announcement-actions">
              <button
                className="btn btn--secondary"
                onClick={() => setEdit(a)}
              >
                {t('编辑公告')}
              </button>
              <button
                className="btn btn--danger"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t('删除此公告？')))
                    void action(
                      `/api/admin/announcements/${a.id}`,
                      undefined,
                      'DELETE',
                    );
                }}
              >
                {t('删除公告')}
              </button>
            </div>
          </article>
        ))}
      </div>
      <nav className="actions" aria-label={t('公告分页')}>
        <button
          className="btn btn--secondary"
          disabled={busy || loading || announcementOffset === 0}
          onClick={() =>
            setAnnouncementOffset(announcementOffset - TEXTURE_PAGE_SIZE)
          }
        >
          {t('上一页')}
        </button>
        <button
          className="btn btn--secondary"
          disabled={busy || loading || announcements.length < TEXTURE_PAGE_SIZE}
          onClick={() =>
            setAnnouncementOffset(announcementOffset + TEXTURE_PAGE_SIZE)
          }
        >
          {t('下一页')}
        </button>
      </nav>
      <form
        className="panel panel--inset"
        key={edit?.id ?? 'new'}
        aria-labelledby="announcement-form-title"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget,
            f = new FormData(form);
          void action('/api/admin/announcements', {
            ...(edit ? { id: edit.id } : {}),
            title: f.get('title'),
            content: f.get('content'),
            severity: f.get('severity'),
            priority: Number(f.get('priority')),
            expand: f.get('expand') === 'on',
          }).then((ok) => {
            if (ok) {
              form.reset();
              setEdit(null);
            }
          });
        }}
      >
        <h3 className="subsection-title" id="announcement-form-title">
          {edit
            ? tf('编辑公告：{title}', { title: edit.title })
            : t('发布新公告')}
        </h3>
        <label className="field-label">
          {t('公告标题')}
          <input
            className="input"
            name="title"
            required
            maxLength={MAX_ANNOUNCEMENT_TITLE_LENGTH}
            defaultValue={edit?.title}
          />
        </label>
        <label className="field-label">
          {t('公告内容')}
          <textarea
            className="input"
            name="content"
            required
            maxLength={MAX_ANNOUNCEMENT_CONTENT_LENGTH}
            defaultValue={edit?.content}
          />
        </label>
        <div className="announcement-form-row">
          <label className="field-label">
            {t('严重程度')}
            <select
              name="severity"
              className="input"
              defaultValue={edit?.severity ?? 'info'}
            >
              <option value="info">{t('信息')}</option>
              <option value="warning">{t('提醒')}</option>
              <option value="danger">{t('紧急')}</option>
            </select>
          </label>
          <label className="field-label">
            {t('优先级')}
            <input
              name="priority"
              className="input"
              type="number"
              min={0}
              max={MAX_ANNOUNCEMENT_PRIORITY}
              defaultValue={edit?.priority ?? 0}
              required
            />
          </label>
        </div>
        <label className="wardrobe-publish">
          <input
            name="expand"
            type="checkbox"
            defaultChecked={edit?.expand === 1}
          />
          {t('默认展开')}
        </label>
        <div className="actions">
          <button className="btn btn--primary" disabled={busy}>
            {edit ? t('保存公告') : t('发布公告')}
          </button>
          {edit && (
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => setEdit(null)}
            >
              {t('取消编辑')}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
