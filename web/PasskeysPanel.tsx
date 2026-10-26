import React, { useEffect, useState } from 'react';
import {
  startRegistration,
  startAuthentication,
} from '@simplewebauthn/browser';
import { apiRequest } from './api';
import { t } from './i18n';
export async function loginWithPasskey() {
  const options = await apiRequest('/api/passkeys/login/options', {
    method: 'POST',
  });
  const response = await startAuthentication({ optionsJSON: options });
  return apiRequest('/api/passkeys/login/verify', {
    method: 'POST',
    body: { response },
  });
}
export function PasskeysPanel({
  token,
  notify,
}: {
  token: string;
  notify: (message: string, kind: 'success' | 'error') => void;
}) {
  const [items, setItems] = useState<{ id: string; name: string }[]>([]),
    [name, setName] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [failed, setFailed] = useState(false),
    // 操作成功后自增：重挂载被清空的输入框，避免 required 字段命中 :user-invalid 红框
    [resetKey, setResetKey] = useState(0);
  const supported = !!window.PublicKeyCredential;
  async function refresh() {
    const data = await apiRequest('/api/passkeys', { token });
    setItems(data.items);
    setFailed(false);
  }
  useEffect(() => {
    void refresh()
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, [token]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
      setPassword('');
      setName('');
      setResetKey((value) => value + 1);
      notify(t('操作已完成'), 'success');
    } catch {
      notify(t('通行密钥操作未完成，请重试'), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-busy={busy || loading}>
      <h2 className="section-title">{t('通行密钥')}</h2>
      {!supported ? (
        <p className="section-hint">{t('此浏览器不支持通行密钥')}</p>
      ) : (
        <>
          <div className="passkey-block">
            <h3 className="subsection-title">{t('已注册的通行密钥')}</h3>
            {loading ? (
              <p className="loading-note" role="status">
                {t('正在加载…')}
              </p>
            ) : failed ? (
              <p className="msg msg--error" role="alert">
                {t('无法加载，请刷新重试')}
              </p>
            ) : items.length === 0 ? (
              <p className="section-hint">{t('尚未添加通行密钥')}</p>
            ) : (
              <ul className="passkey-list">
                {items.map((item) => (
                  <li className="passkey-row" key={item.id}>
                    <span>{item.name}</span>
                    <button
                      className="btn btn--danger"
                      disabled={busy || !password}
                      onClick={() =>
                        void action(() =>
                          apiRequest(
                            `/api/passkeys/${encodeURIComponent(item.id)}`,
                            { method: 'DELETE', token, body: { password } },
                          ),
                        )
                      }
                    >
                      {t('移除')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="passkey-block">
            <h3 className="subsection-title">{t('操作验证与添加新密钥')}</h3>
            <p className="section-hint">
              {t('输入当前密码后可添加或移除通行密钥')}
            </p>
            <label className="field-label passkey-password">
              {t('当前密码')}
              <input
                key={`password-${resetKey}`}
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <form
              key={`form-${resetKey}`}
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  const options = await apiRequest(
                    '/api/passkeys/register/options',
                    { method: 'POST', token, body: { password } },
                  );
                  const response = await startRegistration({
                    optionsJSON: options,
                  });
                  await apiRequest('/api/passkeys/register/verify', {
                    method: 'POST',
                    token,
                    body: { response, name },
                  });
                });
              }}
            >
              <label className="field-label">
                {t('密钥名称')}
                <input
                  className="input"
                  value={name}
                  maxLength={80}
                  required
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <div className="actions">
                <button
                  className="btn btn--primary"
                  disabled={busy || loading || failed || !password}
                >
                  {t('添加通行密钥')}
                </button>
              </div>
            </form>
          </div>
        </>
      )}
    </section>
  );
}
