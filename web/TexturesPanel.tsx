import { t } from './i18n';
import React, { useEffect, useState } from 'react';
import { SkinPreview } from './SkinPreview';
import { MAX_PROFILES, type GameProfile } from '../shared/profiles';
import { apiRequest, errorText } from './api';

type Kind = 'skin' | 'cape';
type Texture = { kind: Kind; hash: string; model: string };

export function TexturesPanel({
  token,
  notify,
}: {
  token: string;
  notify: (message: string, kind: 'success' | 'error') => void;
}) {
  const [profile, setProfile] = useState('');
  const [players, setPlayers] = useState<
    (GameProfile & { textures: Texture[] })[]
  >([]);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [textures, setTextures] = useState<Texture[]>([]);
  const [model, setModel] = useState('default');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    const value = await apiRequest('/api/me', {
      token,
      errorMessage: t('无法读取角色信息，请重新登录'),
    });
    setPlayers(value.profiles);
    const selected =
      value.profiles.find((p: GameProfile) => p.id === profile) ??
      value.profiles[0];
    setProfile(selected.id);
    setTextures(selected.textures ?? []);
    setFailed(false);
    setModel(
      selected.textures?.find((t: Texture) => t.kind === 'skin')?.model ??
        'default',
    );
  }
  useEffect(() => {
    void refresh()
      .catch((e) => {
        setFailed(true);
        notify(errorText(e), 'error');
      })
      .finally(() => setLoading(false));
  }, [token]);

  async function change(kind: Kind, file?: File) {
    if (!profile) return;
    setBusy(true);
    try {
      const form = new FormData();
      if (file) {
        form.append('model', kind === 'skin' ? model : 'default');
        form.append('file', file);
      }
      await apiRequest(`/api/user/profile/${profile}/${kind}`, {
        method: file ? 'PUT' : 'DELETE',
        token,
        body: file ? form : undefined,
        errorMessage: t('材质更新失败，请检查图片格式与尺寸'),
      });
      await refresh();
      notify(file ? t('材质已更新') : t('材质已移除'), 'success');
    } catch (e) {
      notify(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function manage(method: 'POST' | 'PATCH' | 'DELETE') {
    setBusy(true);
    try {
      await apiRequest(
        method === 'POST' ? '/api/players' : `/api/players/${profile}`,
        {
          method,
          token,
          body: method === 'DELETE' ? undefined : { name: newName },
        },
      );
      setNewName('');
      setEditing(false);
      await refresh();
      notify(t('操作已完成'), 'success');
    } catch {
      notify(t('角色操作失败，请检查名称是否重复'), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel"
      aria-labelledby="textures-title"
      aria-busy={loading}
    >
      <div className="section-head">
        <h2 className="section-title" id="textures-title">
          {t('角色外观')}
        </h2>
        <p className="section-hint">
          {t(
            '皮肤支持 64×32、64×64 及等比例 PNG；披风支持 64×32 或 22×17 及等比例 PNG。文件不超过 1 MiB。',
          )}
        </p>
      </div>
      {loading && (
        <p className="loading-note" role="status">
          {t('正在加载角色外观…')}
        </p>
      )}
      {failed && <p role="alert">{t('无法加载，请刷新重试')}</p>}
      {!loading && !failed && (
        <>
          <div className="profile-toolbar">
            <label className="field-label">
              {t('当前角色')}
              <select
                aria-label={t('当前角色')}
                className="input"
                value={profile}
                disabled={busy}
                onChange={(e) => {
                  const p = players.find((p) => p.id === e.target.value)!;
                  setProfile(p.id);
                  setTextures(p.textures);
                  setModel(
                    p.textures.find((t) => t.kind === 'skin')?.model ??
                      'default',
                  );
                  setEditing(false);
                }}
              >
                {players.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn btn--secondary"
              onClick={() => setEditing(!editing)}
              disabled={busy}
            >
              {t('管理角色')}
            </button>
          </div>
          {editing && (
            <form
              className="profile-editor"
              onSubmit={(e) => {
                e.preventDefault();
                void manage('POST');
              }}
            >
              <label className="field-label">
                {t('角色名称')}
                <input
                  className="input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  maxLength={16}
                  pattern="[A-Za-z0-9_]+"
                  required
                  disabled={busy}
                />
              </label>
              <div className="actions">
                <button
                  className="btn btn--primary"
                  disabled={busy || players.length >= MAX_PROFILES}
                >
                  {t('添加角色')}
                </button>
                {!players.find((p) => p.id === profile)?.primary && (
                  <>
                    <button
                      type="button"
                      className="btn btn--secondary"
                      disabled={busy || !newName}
                      onClick={() => void manage('PATCH')}
                    >
                      {t('重命名')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(t('删除此角色及其外观设置？')))
                          void manage('DELETE');
                      }}
                    >
                      {t('删除角色')}
                    </button>
                  </>
                )}
              </div>
            </form>
          )}
          <SkinPreview textures={textures} />
          <div className="texture-grid">
            {(['skin', 'cape'] as Kind[]).map((kind) => {
              const current = textures.find((t) => t.kind === kind);
              return (
                <div key={kind} className="texture-card">
                  <h3 className="texture-title">
                    {kind === 'skin' ? t('皮肤') : t('披风')}
                  </h3>
                  {current ? (
                    <img
                      className={`texture-preview texture-preview--${kind}`}
                      src={`/textures/${current.hash}`}
                      alt={
                        kind === 'skin' ? t('当前皮肤材质') : t('当前披风材质')
                      }
                    />
                  ) : (
                    <div
                      className={`texture-preview texture-preview--${kind} texture-preview--empty`}
                    >
                      <p className="section-hint">{t('尚未设置')}</p>
                    </div>
                  )}
                  {kind === 'skin' && (
                    <label className="field-label">
                      {t('手臂模型')}
                      <select
                        className="input"
                        value={model}
                        disabled={busy}
                        onChange={(e) => setModel(e.target.value)}
                      >
                        <option value="default">{t('标准')}</option>
                        <option value="slim">{t('纤细')}</option>
                      </select>
                    </label>
                  )}
                  <div className="actions">
                    <label
                      className={`btn upload-btn${busy || !profile ? ' upload-btn--disabled' : ''}`}
                    >
                      {kind === 'skin' ? t('上传皮肤') : t('上传披风')}
                      <input
                        className="upload-btn-input"
                        type="file"
                        accept="image/png"
                        disabled={busy || !profile}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void change(kind, file);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    {current && (
                      <button
                        type="button"
                        className="btn btn--secondary"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              kind === 'skin'
                                ? t('移除当前皮肤？')
                                : t('移除当前披风？'),
                            )
                          )
                            void change(kind);
                        }}
                      >
                        {t('移除')}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
