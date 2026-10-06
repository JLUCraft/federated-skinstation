import {
  MAX_TAGS,
  MAX_TAG_LENGTH,
  TEXTURE_PAGE_SIZE,
  type LibrarySort,
  type TextureItem,
  type TextureKind,
} from '../shared/wardrobe';
import React, { useEffect, useMemo, useState } from 'react';
import { apiRequest } from './api';
import { t, tf } from './i18n';
import { TextureThumb } from './TextureThumb';
import {
  TextureDialog,
  textureSrc,
  textureTitle,
} from './TextureDialog';

type KindFilter = 'all' | TextureKind;
const KIND_FILTERS: KindFilter[] = ['all', 'skin', 'cape'];
const KIND_FILTER_LABELS: Record<KindFilter, string> = {
  all: t('全部'),
  skin: t('皮肤'),
  cape: t('披风'),
};

const SORTS: LibrarySort[] = ['new', 'likes'];
const SORT_LABELS: Record<LibrarySort, string> = {
  new: t('最新'),
  likes: t('最多点赞'),
};
const SEARCH_DEBOUNCE_MS = 300;

export function WardrobePanel({
  token,
  library,
  notify,
  onRequireLogin,
  onBrowseUpload,
}: {
  token?: string;
  library: boolean;
  notify: (message: string, kind: 'success' | 'error') => void;
  onRequireLogin?: () => void;
  onBrowseUpload?: () => void;
}) {
  const [profiles, setProfiles] = useState<{ id: string; name: string }[]>([]);
  const [profileId, setProfileId] = useState('');
  const [items, setItems] = useState<TextureItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [sort, setSort] = useState<LibrarySort>('new');
  const [tag, setTag] = useState('');
  const [popularTags, setPopularTags] = useState<
    { tag: string; count: number }[]
  >([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<TextureItem | null>(null);

  async function refresh() {
    const params = new URLSearchParams({ offset: String(offset), sort });
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
  useEffect(() => {
    setOffset(0);
  }, [query, kind, tag, sort]);
  useEffect(() => {
    if (library)
      void apiRequest('/api/library/tags')
        .then((data) => setPopularTags(data.tags))
        .catch(() => setPopularTags([]));
  }, [library]);
  const serverFilters = library ? [query, kind, tag, sort] : [];
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
    } catch {
      notify(t('操作失败，请重试'), 'error');
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
    search.trim() !== '' || kind !== 'all' || tag !== '';
  const page = Math.floor(offset / TEXTURE_PAGE_SIZE) + 1;

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
    return (
      <button
        className="btn btn--primary"
        disabled={busy || (!library && item.applied === 1)}
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
        {library ? t('收藏到衣柜') : t('使用')}
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
      <div className="filter-bar">
        <label className="field-label filter-search">
          {t('搜索名称')}
          <input
            className="input"
            type="search"
            value={search}
            placeholder={
              library ? t('输入名称关键字') : t('在当前页中查找')
            }
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        {library && (
          <label className="field-label filter-source">
            {t('排序')}
            <select
              className="input"
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
        {!library && profiles.length > 1 && (
          <label className="field-label filter-source">
            {t('使用到角色')}
            <select
              aria-label={t('使用到角色')}
              className="input"
              value={profileId || profiles[0].id}
              disabled={busy || loading}
              onChange={(e) => setProfileId(e.target.value)}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {library && (popularTags.length > 0 || tag) && (
        <div className="chip-group tag-bar" role="group" aria-label={t('热门标签')}>
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
        <p role="alert">{t('无法加载，请刷新重试')}</p>
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
              }}
            >
              {t('清除筛选')}
            </button>
          )}
        </div>
      ) : (
        <div className="wardrobe-grid">
          {shown.map((item) => (
            <article
              className="texture-card"
              key={item.id}
            >
              <button
                type="button"
                className="thumb-button"
                aria-label={tf('查看详情：{title}', { title: textureTitle(item) })}
                onClick={() => setOpen(item)}
              >
                <TextureThumb
                  url={textureSrc(item)}
                  kind={item.kind}
                  slim={item.model === 'slim'}
                  label={textureTitle(item)}
                />
              </button>
              <h3 className="texture-title">{textureTitle(item)}</h3>
              <p className="badge-row">
                <span className="status-pill">
                  {item.kind === 'skin' ? t('皮肤') : t('披风')}
                </span>
                {item.kind === 'skin' && item.model === 'slim' && (
                  <span className="status-pill status-pill--neutral">
                    {t('纤细')}
                  </span>
                )}
                {!library && item.published === 1 && (
                  <span className="status-pill status-pill--neutral">
                    {t('已公开')}
                  </span>
                )}
              </p>
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
              {item.applied === 1 && (
                <p className="section-hint">{t('正在使用')}</p>
              )}
              <div className="actions">
                {primaryAction(item)}
                {likeControl(item)}
                <a
                  className="btn btn--secondary"
                  href={textureSrc(item)}
                  download={`${textureTitle(item)}.png`}
                >
                  {t('下载')}
                </a>
              </div>
              {!library && (
                <details className="wardrobe-edit">
                  <summary className="wardrobe-edit-trigger">
                    {t('管理材质')}
                  </summary>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = new FormData(event.currentTarget);
                      void action(() =>
                        apiRequest(`/api/wardrobe/${item.id}`, {
                          method: 'PATCH',
                          token,
                          body: {
                            title: form.get('title'),
                            published: form.get('published') === 'on',
                            tags: String(form.get('tags') ?? '')
                              .split(/[,，\s]+/)
                              .filter(Boolean),
                          },
                        }),
                      );
                    }}
                  >
                    <label className="field-label">
                      {t('名称')}
                      <input
                        className="input"
                        name="title"
                        maxLength={80}
                        defaultValue={item.title}
                        disabled={busy}
                      />
                    </label>
                    <label className="field-label">
                      {tf('标签（最多 {max} 个，用空格或逗号分隔）', {
                        max: MAX_TAGS,
                      })}
                      <input
                        className="input"
                        name="tags"
                        defaultValue={item.tags?.join(' ')}
                        maxLength={MAX_TAGS * (MAX_TAG_LENGTH + 1)}
                        disabled={busy}
                      />
                    </label>
                    <label className="wardrobe-publish">
                      <input
                        name="published"
                        type="checkbox"
                        defaultChecked={item.published === 1}
                        disabled={busy}
                      />
                      {t('公开到皮肤库')}
                    </label>
                    <div className="actions">
                      <button className="btn btn--secondary" disabled={busy}>
                        {t('保存')}
                      </button>
                      <button
                        className="btn btn--link"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(t('从衣柜移除此材质？')))
                            void action(() =>
                              apiRequest(`/api/wardrobe/${item.id}`, {
                                method: 'DELETE',
                                token,
                              }),
                            );
                        }}
                      >
                        {t('从衣柜移除')}
                      </button>
                    </div>
                  </form>
                </details>
              )}
            </article>
          ))}
        </div>
      )}
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
      {open && (
        <TextureDialog
          item={open}
          actions={
            <>
              {primaryAction(open)}
              {likeControl(open)}
            </>
          }
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}
