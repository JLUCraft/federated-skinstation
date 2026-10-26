import {
  MAX_SEARCH_LENGTH,
  TEXTURE_PAGE_SIZE,
  type LibrarySort,
  type TextureItem,
  type TextureKind,
} from '../shared/wardrobe';
import { ReportButton } from './CommunityPanel';
import React, { useEffect, useMemo, useState, useRef } from 'react';
import { apiRequest, errorText } from './api';
import { t, tf } from './i18n';
import { TextureCard } from './TextureCard';
import { TextureDialog, textureSrc, textureTitle } from './TextureDialog';
import { TextureEditorDrawer } from './TextureEditor';

type KindFilter = 'all' | TextureKind;
const KIND_FILTERS: KindFilter[] = ['all', 'skin', 'cape'];
const KIND_FILTER_LABELS: Record<KindFilter, string> = {
  all: t('全部'),
  skin: t('皮肤'),
  cape: t('披风'),
};

const SORTS: LibrarySort[] = ['new', 'likes', 'downloads', 'saves'];
const SORT_LABELS: Record<LibrarySort, string> = {
  downloads: t('下载排行'),
  saves: t('收藏排行'),
  new: t('最新'),
  likes: t('最多点赞'),
};
export type LibraryViewState = {
  search: string;
  kind: KindFilter;
  school: string;
  sort: LibrarySort;
  tag: string;
  offset: number;
};
const DEFAULT_VIEW: LibraryViewState = {
  search: '',
  kind: 'all',
  school: '',
  sort: 'new',
  tag: '',
  offset: 0,
};
const SEARCH_DEBOUNCE_MS = 300;

export function WardrobePanel({
  token,
  library,
  notify,
  onRequireLogin,
  onBrowseUpload,
  initialState = DEFAULT_VIEW,
  onStateChange,
}: {
  token?: string;
  library: boolean;
  notify: (message: string, kind: 'success' | 'error') => void;
  onRequireLogin?: () => void;
  onBrowseUpload?: () => void;
  initialState?: LibraryViewState;
  onStateChange?: (state: LibraryViewState) => void;
}) {
  const [profiles, setProfiles] = useState<{ id: string; name: string }[]>([]);
  const [profileId, setProfileId] = useState('');
  const [items, setItems] = useState<TextureItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [offset, setOffset] = useState(initialState.offset);
  const [search, setSearch] = useState(initialState.search);
  const [kind, setKind] = useState<KindFilter>(initialState.kind);
  const [school, setSchool] = useState(initialState.school);
  const [schools, setSchools] = useState<string[]>([]);
  const [sort, setSort] = useState<LibrarySort>(initialState.sort);
  const [tag, setTag] = useState(initialState.tag);
  const [popularTags, setPopularTags] = useState<
    { tag: string; count: number }[]
  >([]);
  const [query, setQuery] = useState(initialState.search.trim());
  const [open, setOpen] = useState<TextureItem | null>(null);
  const [editing, setEditing] = useState<TextureItem | null>(null);

  async function refresh() {
    const params = new URLSearchParams({ offset: String(offset), sort });
    if (school) params.set('school', school);
    if (query) params.set('q', query);
    if (tag) params.set('tag', tag);
    if (kind !== 'all') params.set('kind', kind);
    const response = await apiRequest(
      library
        ? `/api/library?${params}`
        : `/api/wardrobe?offset=${offset}${profileId ? `&profileId=${encodeURIComponent(profileId)}` : ''}`,
      { token },
    );
    setItems(response.items);
    setFailed(false);
  }
  useEffect(() => {
    void apiRequest('/api/capabilities')
      .then((r) => setSchools(r.schools.map((s: { id: string }) => s.id)))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!library && token)
      void apiRequest('/api/players', { token })
        .then((data) => {
          setProfiles(data.profiles);
        })
        .catch(() => setFailed(true));
  }, [token, library]);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setQuery(search.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [search]);
  const previousFilters = useRef([query, kind, tag, sort, school]);
  useEffect(() => {
    const next = [query, kind, tag, sort, school];
    if (next.some((value, index) => value !== previousFilters.current[index]))
      setOffset(0);
    previousFilters.current = next;
  }, [query, kind, tag, sort, school]);
  useEffect(() => {
    onStateChange?.({ search, kind, school, sort, tag, offset });
  }, [search, kind, school, sort, tag, offset, onStateChange]);
  useEffect(() => {
    if (library)
      void apiRequest('/api/library/tags')
        .then((data) => setPopularTags(data.tags))
        .catch(() => setPopularTags([]));
  }, [library]);
  const serverFilters = library ? [query, kind, tag, sort, school] : [];
  useEffect(() => {
    setLoading(true);
    void refresh()
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, [token, library, offset, profileId, ...serverFilters]);
  async function action(operation: () => Promise<unknown>) {
    setBusy(true);
    try {
      await operation();
      await refresh();
      setOpen(null);
      notify(t('操作已完成'), 'success');
    } catch (error) {
      notify(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  const shown = useMemo(() => {
    // The library is filtered by the server; the wardrobe has no such API.
    if (library) return items;
    const needle = search.trim().toLowerCase();
    return items.filter(
      (item) =>
        (kind === 'all' || item.kind === kind) &&
        (!needle || textureTitle(item).toLowerCase().includes(needle)),
    );
  }, [items, library, search, kind]);
  const filtering =
    search.trim() !== '' || kind !== 'all' || tag !== '' || school !== '';
  const page = Math.floor(offset / TEXTURE_PAGE_SIZE) + 1;

  const currentProfile = profiles.find(
    (profile) => profile.id === (profileId || profiles[0]?.id),
  );

  function primaryAction(item: TextureItem) {
    if (library && !token)
      return (
        <button
          className="btn btn--primary"
          type="button"
          onClick={onRequireLogin}
        >
          {t('登录后收藏')}
        </button>
      );
    if (library && item.owned)
      return (
        <button className="btn btn--secondary" type="button" disabled>
          {t('已在衣柜')}
        </button>
      );
    if (!library && item.applied === 1)
      return (
        <button className="btn btn--secondary" type="button" disabled>
          {t('当前角色正在使用')}
        </button>
      );
    return (
      <button
        className="btn btn--primary"
        disabled={busy}
        onClick={() =>
          void action(() =>
            apiRequest(
              library
                ? `/api/library/${item.id}/save`
                : `/api/wardrobe/${item.id}/apply`,
              {
                method: 'POST',
                token,
                body: library
                  ? {}
                  : { profileId: profileId || profiles[0]?.id },
              },
            ),
          )
        }
      >
        {library ? t('收藏到衣柜') : t('穿戴到当前角色')}
      </button>
    );
  }

  function likeControl(item: TextureItem) {
    if (!library) return null;
    const count = tf('{count} 个赞', { count: item.likes ?? 0 });
    if (!token) return <span className="like-count">{count}</span>;
    return (
      <button
        type="button"
        className={`btn chip like-button${item.liked ? ' chip--active' : ''}`}
        aria-pressed={item.liked === true}
        disabled={busy}
        onClick={() =>
          void action(() =>
            apiRequest(`/api/library/${item.id}/like`, {
              method: 'POST',
              token,
              body: { liked: !item.liked },
            }),
          )
        }
      >
        {item.liked ? t('已点赞') : t('点赞')} · {item.likes ?? 0}
      </button>
    );
  }

  return (
    <section className="panel" aria-busy={busy || loading}>
      <div className="section-head">
        <h2 className="section-title">{library ? t('皮肤库') : t('衣柜')}</h2>
        <p className="section-hint">
          {library
            ? t('浏览各校公开的皮肤与披风，登录后可收藏到自己的衣柜。')
            : t('你上传或收藏的材质都在这里，选择后即可应用到角色。')}
        </p>
      </div>
      {!library && (
        <div className="wear-target" aria-live="polite">
          <span className="wear-target-avatar" aria-hidden="true">
            {currentProfile ? currentProfile.name.slice(0, 1).toUpperCase() : '—'}
          </span>
          <span className="wear-target-text">
            <span className="wear-target-label">{t('当前穿戴目标角色')}</span>
            <span className="wear-target-name">
              {currentProfile?.name ?? t('尚未创建角色')}
            </span>
          </span>
          <label className="field-label wear-target-switch">
            {t('切换目标角色')}
            <select
              aria-label={t('切换目标角色')}
              className="input"
              value={profileId || profiles[0]?.id || ''}
              disabled={busy || loading || !profiles.length}
              onChange={(e) => setProfileId(e.target.value)}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div className="filter-bar">
        <label className="field-label filter-search">
          {t('搜索名称')}
          <input
            className="input"
            type="search"
            maxLength={MAX_SEARCH_LENGTH}
            value={search}
            placeholder={library ? t('输入名称关键字') : t('在当前页中查找')}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        {library && (
          <label className="field-label">
            {t('学校')}
            <select
              className="input"
              aria-label={t('学校')}
              value={school}
              onChange={(e) => setSchool(e.target.value)}
            >
              <option value="">{t('全部学校')}</option>
              {schools.map((id) => (
                <option key={id} value={id}>
                  {id.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
        )}
        {library && (
          <label className="field-label filter-source">
            {t('排序')}
            <select
              className="input"
              aria-label={t('排序')}
              value={sort}
              onChange={(e) => setSort(e.target.value as LibrarySort)}
            >
              {SORTS.map((id) => (
                <option key={id} value={id}>
                  {SORT_LABELS[id]}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="chip-group" role="group" aria-label={t('材质类型')}>
          {KIND_FILTERS.map((id) => (
            <button
              key={id}
              type="button"
              className={`btn chip${kind === id ? ' chip--active' : ''}`}
              aria-pressed={kind === id}
              onClick={() => setKind(id)}
            >
              {KIND_FILTER_LABELS[id]}
            </button>
          ))}
        </div>
      </div>
      {library && (popularTags.length > 0 || tag) && (
        <div
          className="chip-group tag-bar"
          role="group"
          aria-label={t('热门标签')}
        >
          {tag && !popularTags.some((p) => p.tag === tag) && (
            <button
              type="button"
              className="btn chip chip--active"
              aria-pressed="true"
              onClick={() => setTag('')}
            >
              #{tag}
            </button>
          )}
          {popularTags.map((p) => (
            <button
              key={p.tag}
              type="button"
              className={`btn chip${tag === p.tag ? ' chip--active' : ''}`}
              aria-pressed={tag === p.tag}
              onClick={() => setTag(tag === p.tag ? '' : p.tag)}
            >
              #{p.tag}
            </button>
          ))}
        </div>
      )}
      {loading ? (
        <p role="status" className="loading-note">
          {t('正在加载…')}
        </p>
      ) : failed ? (
        <p className="msg msg--error" role="alert">
          {t('无法加载，请刷新重试')}
        </p>
      ) : items.length === 0 && !filtering ? (
        <div className="empty-state">
          <p className="section-hint">
            {library
              ? t('暂时没有公开材质')
              : t('上传的皮肤和披风会保存在这里')}
          </p>
          {!library && onBrowseUpload && (
            <button
              type="button"
              className="btn btn--primary"
              onClick={onBrowseUpload}
            >
              {t('去上传材质')}
            </button>
          )}
        </div>
      ) : shown.length === 0 ? (
        <div className="empty-state">
          <p className="section-hint">
            {library ? t('没有符合条件的材质') : t('当前页没有符合条件的材质')}
          </p>
          {filtering && (
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => {
                setSearch('');
                setKind('all');
                setTag('');
                setSchool('');
              }}
            >
              {t('清除筛选')}
            </button>
          )}
        </div>
      ) : (
        <div className="wardrobe-grid">
          {shown.map((item) => (
            <TextureCard
              key={item.id}
              item={item}
              library={library}
              onOpen={() => setOpen(item)}
            >
              {(item.tags?.length ?? 0) > 0 && (
                <p className="badge-row">
                  {item.tags?.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="tag-link"
                      disabled={!library}
                      onClick={() => setTag(name)}
                    >
                      #{name}
                    </button>
                  ))}
                </p>
              )}
              <div className="actions">
                {primaryAction(item)}
                {likeControl(item)}
                <a
                  className="btn btn--secondary"
                  href={
                    library
                      ? `/api/library/${item.id}/download`
                      : textureSrc(item)
                  }
                  download={`${textureTitle(item)}.png`}
                >
                  {t('下载')}
                </a>
              </div>
              {!library && (
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={busy}
                  onClick={() => setEditing(item)}
                >
                  {t('管理材质')}
                </button>
              )}
            </TextureCard>
          ))}
        </div>
      )}
      {(offset > 0 || items.length >= TEXTURE_PAGE_SIZE) && (
        <nav className="pager" aria-label={t('分页')}>
          <button
            className="btn btn--secondary"
            disabled={busy || loading || offset === 0}
            onClick={() =>
              setOffset((value) => Math.max(0, value - TEXTURE_PAGE_SIZE))
            }
          >
            {t('上一页')}
          </button>
          <span className="pager-state" aria-current="page">
            {tf('第 {page} 页', { page })}
          </span>
          <button
            className="btn btn--secondary"
            disabled={busy || loading || items.length < TEXTURE_PAGE_SIZE}
            onClick={() => setOffset((value) => value + TEXTURE_PAGE_SIZE)}
          >
            {t('下一页')}
          </button>
        </nav>
      )}
      {editing && (
        <TextureEditorDrawer
          key={editing.id}
          item={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(input) =>
            void action(async () => {
              await apiRequest(`/api/wardrobe/${editing.id}`, {
                method: 'PATCH',
                token,
                body: input,
              });
              setEditing(null);
            })
          }
          onSetAvatar={() =>
            void action(async () => {
              await apiRequest('/api/me/avatar', {
                method: 'PUT',
                token,
                body: { item: editing.id },
              });
              window.dispatchEvent(new Event('avatar-changed'));
            })
          }
          onRemove={() =>
            void action(async () => {
              await apiRequest(`/api/wardrobe/${editing.id}`, {
                method: 'DELETE',
                token,
              });
              setEditing(null);
            })
          }
        />
      )}
      {open && (
        <TextureDialog
          item={open}
          actions={
            <>
              {primaryAction(open)}
              {likeControl(open)}
              {library && token && (
                <ReportButton
                  busy={busy}
                  onReport={async (reason) => {
                    await apiRequest(`/api/library/${open.id}/report`, {
                      method: 'POST',
                      token,
                      body: { reason },
                    });
                  }}
                />
              )}
            </>
          }
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}
