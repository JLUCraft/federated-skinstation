import React, { useEffect, useState } from 'react';
import { t } from './i18n';

const COPY_NOTICE_MS = 2000;

/** The Yggdrasil API root launchers need; it is simply this site's own origin. */
export function ConnectPanel() {
  const root = window.location.origin;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPY_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <section className="panel" aria-labelledby="connect-title">
      <div className="section-head">
        <h2 className="section-title" id="connect-title">
          {t('启动器连接')}
        </h2>
        <p className="section-hint">
          {t('在支持外置登录的启动器中添加认证服务器，填入下面的地址。')}
        </p>
      </div>
      <div className="code-row">
        <label className="field-label">
          {t('认证服务器地址')}
          <input
            className="input bind-code"
            readOnly
            value={root}
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(root)
              .then(() => setCopied(true))
          }
        >
          {copied ? t('已复制') : t('复制地址')}
        </button>
      </div>
    </section>
  );
}
