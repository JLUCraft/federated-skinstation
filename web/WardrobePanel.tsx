import { TEXTURE_PAGE_SIZE } from '../shared/wardrobe';
import React, { useEffect, useState } from 'react';
import { apiRequest } from './api';
import { t } from './i18n';

type Item = {
  source?: string;
  textureUrl?: string;
  id: string;
  title: string;
  kind: 'skin' | 'cape';
  hash: string;
  model: string;
  published?: number;
  applied?: number;
};
export function WardrobePanel({
  token,
  library,
  notify,
}: {
  token: string;
  library: boolean;
  notify: (message: string, kind: 'success' | 'error') => void;
}) {
  const [profiles, setProfiles] = useState<{ id: string; name: string }[]>([]);
  const [profileId, setProfileId] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [offset, setOffset] = useState(0);
  async function refresh() {
    const response = await apiRequest(
      library
        ? `/api/library?offset=${offset}`
        : `/api/wardrobe?offset=${offset}${profileId ? `&profileId=${encodeURIComponent(profileId)}` : ''}`,
      { token },
    );
    setItems(response.items);
    setFailed(false);
    setUnavailable((response.unavailableSources ?? 0) > 0);
  }
  useEffect(() => {
    if (!library)
      void apiRequest('/api/players', { token })
        .then((data) => {
          setProfiles(data.profiles);
        })
        .catch(() => setFailed(true));
  }, [token, library]);
  useEffect(() => {
    setLoading(true);
    void refresh()
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, [token, library, offset, profileId]);
  async function action(operation: () => Promise<unknown>) {
    setBusy(true);
    try {
      await operation();
      await refresh();
      notify(t('操作已完成'), 'success');
    } catch {
      notify(t('操作失败，请重试'), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-busy={busy || loading}>
      <h2 className="section-title">{library ? t('皮肤库') : t('衣柜')}</h2>
      {!library && profiles.length > 1 && (
        <label className="field-label">
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
      {unavailable && (
        <p role="status" className="section-hint">
          {t('部分社团暂时不可用，当前结果可能不完整。')}
        </p>
      )}
      {loading ? (
        <p role="status">{t('正在加载…')}</p>
      ) : failed ? (
        <p role="alert">{t('无法加载，请刷新重试')}</p>
      ) : items.length === 0 ? (
        <p className="section-hint">
          {library ? t('暂时没有公开材质') : t('上传的皮肤和披风会保存在这里')}
        </p>
      ) : (
        <div className="wardrobe-grid">
          {items.map((item) => (
            <article
              className="texture-card"
              key={`${item.source ?? ''}:${item.id}`}
            >
              <img
                className="texture-preview"
                src={item.textureUrl ?? `/textures/${item.hash}`}
                alt={
                  item.title || (item.kind === 'skin' ? t('皮肤') : t('披风'))
                }
              />
              <h3 className="texture-title">
                {item.title || (item.kind === 'skin' ? t('皮肤') : t('披风'))}
              </h3>
              {item.applied === 1 && (
                <p className="section-hint">{t('正在使用')}</p>
              )}
              <div className="actions">
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
                            ? { source: item.source }
                            : { profileId: profileId || profiles[0]?.id },
                        },
                      ),
                    )
                  }
                >
                  {library ? t('收藏到衣柜') : t('使用')}
                </button>
                <a
                  className="btn btn--secondary"
                  href={item.textureUrl ?? `/textures/${item.hash}`}
                  download={`${item.title || item.kind}.png`}
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
                        onClick={() =>
                          void action(() =>
                            apiRequest(`/api/wardrobe/${item.id}`, {
                              method: 'DELETE',
                              token,
                            }),
                          )
                        }
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
      {
        <div className="actions">
          <button
            className="btn btn--secondary"
            disabled={busy || loading || offset === 0}
            onClick={() =>
              setOffset((value) => Math.max(0, value - TEXTURE_PAGE_SIZE))
            }
          >
            {t('上一页')}
          </button>
          <button
            className="btn btn--secondary"
            disabled={busy || loading || items.length < TEXTURE_PAGE_SIZE}
            onClick={() => setOffset((value) => value + TEXTURE_PAGE_SIZE)}
          >
            {t('下一页')}
          </button>
        </div>
      }
    </section>
  );
}
