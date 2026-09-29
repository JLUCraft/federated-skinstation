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
    [failed, setFailed] = useState(false);
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
        <p>{t('此浏览器不支持通行密钥')}</p>
      ) : (
        <>
          {loading ? (
            <p role="status">{t('正在加载…')}</p>
          ) : failed ? (
            <p role="alert">{t('无法加载，请刷新重试')}</p>
          ) : items.length === 0 ? (
            <p className="section-hint">{t('尚未添加通行密钥')}</p>
          ) : (
            <ul className="passkey-list">
              {items.map((item) => (
                <li className="passkey-row" key={item.id}>
                  <span>{item.name}</span>
                  <button
                    className="btn btn--secondary"
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
          <form
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
                setName('');
              });
            }}
          >
            <div className="field-grid">
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
              <label className="field-label">
                {t('当前密码')}
                <input
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  required
                  disabled={busy}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            </div>
            <div className="actions">
              <button
                className="btn btn--primary"
                disabled={busy || loading || failed}
              >
                {t('添加通行密钥')}
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
