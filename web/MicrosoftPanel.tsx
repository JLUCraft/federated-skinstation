import { t } from './i18n';
import React, { useEffect, useState } from 'react';
import { apiRequest } from './api';

export function MicrosoftPanel({
  token,
  notify,
}: {
  token: string;
  notify: (text: string, kind: 'success' | 'error') => void;
}) {
  const [link, setLink] = useState<{ name: string } | null>(null);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void apiRequest('/api/microsoft/link', { token })
      .then((data) => {
        if (active) setLink(data.link);
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [token]);
  async function change() {
    setBusy(true);
    try {
      if (link) {
        await apiRequest('/api/microsoft/link', { method: 'DELETE', token });
        setLink(null);
        notify(t('已解除 Microsoft 绑定'), 'success');
      } else {
        const data = await apiRequest('/api/microsoft/start', {
          method: 'POST',
          token,
          body: { mode: 'link' },
        });
        window.location.assign(data.url);
      }
    } catch {
      notify(t('Microsoft 账号操作失败，请重试'), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel"
      aria-labelledby="microsoft-title"
      aria-busy={busy}
    >
      <h2 className="section-title" id="microsoft-title">
        {t('Microsoft 正版账号')}
      </h2>
      {failed ? (
        <p role="alert">{t('无法读取绑定状态，请刷新重试。')}</p>
      ) : (
        <>
          <p className="section-hint">
            {link
              ? link.name
              : t(
                  '绑定拥有 Minecraft Java 版的账号，之后可用 Microsoft 登录。',
                )}
          </p>
          <button
            className="btn btn--secondary"
            disabled={busy}
            onClick={() => void change()}
          >
            {link ? t('解除绑定') : t('绑定 Microsoft 账号')}
          </button>
        </>
      )}
    </section>
  );
}
