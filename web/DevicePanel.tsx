import React, { useEffect, useState } from 'react';
import { apiRequest } from './api';
import { t, tf } from './i18n';

/** Approve or refuse a launcher's device-flow login request. */
export function DevicePanel({
  token,
  userCode,
  notify,
  onDone,
}: {
  token: string;
  userCode: string;
  notify: (message: string, kind: 'success' | 'error') => void;
  onDone: () => void;
}) {
  const [profiles, setProfiles] = useState<{ id: string; name: string }[]>([]);
  const [profileId, setProfileId] = useState('');
  const [valid, setValid] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'approved' | 'denied' | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([
      apiRequest(`/api/oauth/device?user_code=${encodeURIComponent(userCode)}`, {
        token,
      }),
      apiRequest('/api/players', { token }),
    ])
      .then(([, players]) => {
        if (!active) return;
        setProfiles(players.profiles);
        setProfileId(players.profiles[0]?.id ?? '');
        setValid(true);
      })
      .catch(() => active && setValid(false));
    return () => {
      active = false;
    };
  }, [token, userCode]);
  async function decide(approve: boolean) {
    setBusy(true);
    try {
      await apiRequest('/api/oauth/device/decision', {
        method: 'POST',
        token,
        body: { userCode, approve, ...(approve ? { profileId } : {}) },
      });
      setResult(approve ? 'approved' : 'denied');
    } catch {
      notify(t('授权未完成，请重试'), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-labelledby="device-title" aria-busy={valid === null}>
      <div className="section-head">
        <h2 className="section-title" id="device-title">
          {t('授权启动器登录')}
        </h2>
        {!result && (
          <p className="section-hint">
            {t('启动器正在请求登录你的账号。请确认下面的授权码与启动器显示的一致。')}
          </p>
        )}
      </div>
      {valid === null && (
        <p className="loading-note" role="status">
          {t('正在加载…')}
        </p>
      )}
      {valid === false && <p role="alert">{t('授权码无效或已过期，请回到启动器重新获取。')}</p>}
      {result && (
        <>
          <p className="msg msg--success" role="status">
            {result === 'approved'
              ? t('已授权。现在可以关闭此页面，回到启动器继续。')
              : t('已拒绝授权。启动器不会登录你的账号。')}
          </p>
          <div className="actions">
            <button className="btn btn--secondary" onClick={onDone}>
              {t('继续使用皮肤站')}
            </button>
          </div>
        </>
      )}
      {valid && !result && (
        <>
          <p className="device-code" aria-label={t('授权码')}>
            {userCode}
          </p>
          {profiles.length === 1 && (
            <p className="section-hint">
              {tf('将使用角色：{name}', { name: profiles[0].name })}
            </p>
          )}
          {profiles.length > 1 && (
            <label className="field-label">
              {t('登录使用的角色')}
              <select
                className="input"
                value={profileId}
                disabled={busy}
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
          <div className="actions">
            <button
              className="btn btn--primary"
              disabled={busy || !profileId}
              onClick={() => void decide(true)}
            >
              {t('授权登录')}
            </button>
            <button
              className="btn btn--secondary"
              disabled={busy}
              onClick={() => void decide(false)}
            >
              {t('拒绝')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
