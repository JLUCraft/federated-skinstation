import type { GameProfile } from '../shared/profiles';
import { t } from './i18n';
import React, { useEffect, useState } from 'react';
import { apiRequest, errorText } from './api';

type BlacklistEntry = {
  id: number;
  email: string;
  reason: string;
  source: string;
  valid_until: string | null;
};

export function MuaPanel({
  token,
  notify,
}: {
  token: string;
  notify: (text: string, kind: 'success' | 'error') => void;
}) {
  const [ticket, setTicket] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get('mua-grant') ?? '',
  );
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [binding, setBinding] = useState('');
  const [target, setTarget] = useState('');
  const [generated, setGenerated] = useState('');
  const [uuid, setUuid] = useState('');
  const [profiles, setProfiles] = useState<GameProfile[]>([]);
  const [page, setPage] = useState(1);
  const [entries, setEntries] = useState<BlacklistEntry[]>([]);
  const [hasQueried, setHasQueried] = useState(false);
  const [query, setQuery] = useState('');
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);

  async function api(path: string, method = 'GET', body?: unknown) {
    return apiRequest(path, {
      method,
      token,
      body,
      errorMessage: t('操作未完成，请检查信息或稍后重试'),
    });
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch {
      notify(t('操作未完成，请检查信息或稍后重试'), 'error');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let live = true;
    void api('/api/me')
      .then((a) => {
        if (live) {
          setAdmin(a.muaAdmin === true);
          setUuid(a.profileId);
          setProfiles(a.profiles);
        }
      })
      .catch((e) => notify(errorText(e), 'error'))
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [token]);

  const load = async () => {
    try {
      const result = await api(
        `/api/mua/admin/blacklist?page=${page}${query ? '&q=' + encodeURIComponent(query) : ''}`,
      );
      setEntries(
        Array.isArray(result.data)
          ? result.data
          : Object.values(result.data ?? {}),
      );
      setHasQueried(true);
    } catch (e) {
      notify(errorText(e), 'error');
    }
  };

  return (
    <>
      {ticket && (
        <section className="panel" aria-labelledby="mua-consent">
          <div className="section-head">
            <h2 className="section-title" id="mua-consent">
              {t('授权 MUA 登录')}
            </h2>
            <p className="section-hint">
              {t('继续后，你的昵称和注册邮箱将提供给 MUA，用于完成此次登录。')}
            </p>
          </div>
          <div className="actions">
            <button
              className="btn btn--primary"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const r = await api('/api/mua/authorize', 'POST', {
                    ticket,
                    consent: true,
                  });
                  location.assign(r.url);
                })
              }
            >
              {t('同意并继续')}
            </button>
            <button
              className="btn btn--secondary"
              disabled={busy}
              onClick={() => {
                setTicket('');
                history.replaceState(null, '', location.pathname);
              }}
            >
              {t('取消')}
            </button>
          </div>
        </section>
      )}

      <section
        className="panel"
        aria-labelledby="mua-bind-title"
        aria-busy={loading}
      >
        <div className="section-head">
          <h2 className="section-title" id="mua-bind-title">
            {t('跨校角色绑定')}
          </h2>
          <p className="section-hint">
            {t(
              '仅绑定你本人持有的角色。绑定码用于在另一所学校的皮肤站确认关联，请勿交给他人。',
            )}
          </p>
        </div>
        {loading && (
          <p className="loading-note" role="status">
            {t('正在加载角色信息…')}
          </p>
        )}
        <label className="field-label">
          {t('当前角色')}
          <select
            className="input"
            aria-label={t('当前角色')}
            value={uuid}
            disabled={loading || busy || !profiles.length}
            onChange={(e) => {
              setUuid(e.target.value);
              setBinding('');
              setTarget('');
              setGenerated('');
            }}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <div className="actions">
          <button
            className="btn btn--primary"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const r = await api('/api/mua/profiles/bind', 'POST', { uuid });
                setGenerated(String(r.token ?? ''));
              })
            }
          >
            {t('生成绑定码')}
          </button>
          <button
            className="btn btn--secondary"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await api('/api/mua/profiles/unbind', 'POST', { uuid });
                notify(t('角色绑定已解除'), 'success');
              })
            }
          >
            {t('解除角色绑定')}
          </button>
        </div>
        {generated && (
          <label className="field-label">
            {t('本次绑定码')}
            <input className="input bind-code" readOnly value={generated} />
          </label>
        )}
        <div className="subsection">
          <h3 className="subsection-title">{t('绑定另一角色')}</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await api('/api/mua/profiles/bindto', 'POST', {
                  token: binding,
                  uuid,
                });
                setBinding('');
                notify(t('角色绑定已更新'), 'success');
              });
            }}
          >
            <label className="field-label">
              {t('另一角色的绑定码')}
              <input
                className="input"
                value={binding}
                onChange={(e) => setBinding(e.target.value)}
                autoComplete="off"
                required
              />
            </label>
            <div className="actions">
              <button
                className="btn btn--primary"
                disabled={busy}
                type="submit"
              >
                {t('绑定角色')}
              </button>
            </div>
          </form>
        </div>
        <details>
          <summary>{t('统一游戏角色编号')}</summary>
          <p className="section-hint">
            {t(
              '先完成角色绑定，再指定要使用的角色编号。变更会影响游戏存档身份，并要求重新登录。',
            )}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await api('/api/mua/profiles/remapuuid', 'POST', {
                  target,
                  uuid,
                });
                notify(t('角色编号变更已提交，请重新登录'), 'success');
              });
            }}
          >
            <label className="field-label">
              {t('目标角色编号')}
              <input
                className="input"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                pattern="[a-f0-9]{32}"
                required
              />
            </label>
            <div className="actions">
              <button
                className="btn btn--primary"
                disabled={busy}
                type="submit"
              >
                {t('提交编号变更')}
              </button>
            </div>
          </form>
        </details>
      </section>

      {admin && (
        <section
          className="panel"
          aria-labelledby="mua-admin-title"
          aria-busy={busy}
        >
          <div className="section-head">
            <h2 className="section-title" id="mua-admin-title">
              {t('联合黑名单')}
            </h2>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(load);
            }}
          >
            <div className="field-grid">
              <label className="field-label">
                {t('搜索')}
                <input
                  className="input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <label className="field-label">
                {t('页码')}
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={100000}
                  value={page}
                  onChange={(e) => setPage(Number(e.target.value))}
                />
              </label>
            </div>
            <div className="actions">
              <button
                className="btn btn--primary"
                disabled={busy}
                type="submit"
              >
                {t('查询')}
              </button>
            </div>
          </form>
          {busy && (
            <p className="loading-note" role="status">
              {t('正在处理…')}
            </p>
          )}
          {hasQueried && !busy && !entries.length && (
            <p className="empty-note">{t('暂无黑名单记录')}</p>
          )}
          {entries.map((entry) => (
            <article className="entry-card" key={entry.id}>
              <p className="entry-meta entry-text">
                {entry.email} {t('· 来源：')}
                {entry.source}
              </p>
              <p className="entry-text">{entry.reason}</p>
              <p className="entry-text">
                <span className="status-pill">
                  {entry.valid_until
                    ? new Date(entry.valid_until).toLocaleDateString('zh-CN')
                    : t('长期有效')}
                </span>
              </p>
              <div className="actions entry-actions">
                {(['invalidate', 'delete'] as const).map((op) => (
                  <button
                    className="btn btn--secondary"
                    disabled={busy}
                    key={op}
                    onClick={() =>
                      void action(async () => {
                        if (
                          !confirm(
                            op === 'delete'
                              ? t('确认删除这条记录？')
                              : t('确认使这条记录失效？'),
                          )
                        )
                          return;
                        await api(
                          `/api/mua/admin/blacklist/${entry.id}/${op}`,
                          'POST',
                          {},
                        );
                        await load();
                      })
                    }
                  >
                    {op === 'delete' ? t('删除') : t('设为失效')}
                  </button>
                ))}
              </div>
            </article>
          ))}
          <div className="subsection">
            <h3 className="subsection-title">{t('添加记录')}</h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  await api('/api/mua/admin/blacklist', 'POST', {
                    email,
                    reason,
                  });
                  setReason('');
                  await load();
                  notify(t('记录已提交'), 'success');
                });
              }}
            >
              <div className="field-grid">
                <label className="field-label">
                  {t('邮箱')}
                  <input
                    className="input"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </label>
                <label className="field-label">
                  {t('原因')}
                  <input
                    className="input"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={4096}
                    required
                  />
                </label>
              </div>
              <div className="actions">
                <button
                  className="btn btn--primary"
                  disabled={busy}
                  type="submit"
                >
                  {t('提交记录')}
                </button>
                <button
                  disabled={busy}
                  type="button"
                  className="btn btn--secondary"
                  onClick={() =>
                    void action(async () => {
                      await api('/api/mua/admin/synchronize', 'POST', {});
                      notify(t('角色同步已安排'), 'success');
                    })
                  }
                >
                  {t('重新同步角色')}
                </button>
              </div>
            </form>
          </div>
        </section>
      )}
    </>
  );
}
