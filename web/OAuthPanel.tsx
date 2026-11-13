import { MCP_PATH, OAUTH_PATHS } from '../shared/oauth.js';
import React, { useEffect, useRef, useState } from 'react';
import type {
  OAuthAuthorizationReview,
  OAuthGrantList,
  OAuthScope,
} from '../shared/contracts/generated';
import { apiRequest, errorText } from './api';
import { useClipboard } from './clipboard';
import { InlineNote } from './InlineNote';
import { t } from './i18n';
const scopes: Record<OAuthScope, string> = {
  openid: t('账号标识'),
  offline_access: t('持续访问'),
  'Yggdrasil.PlayerProfiles.Select': t('选择游戏角色'),
  'Yggdrasil.Server.Join': t('加入游戏服务器'),
  'mcp.read': t('读取中央管理数据'),
  'mcp.write': t('执行中央管理操作'),
};
export function OAuthConsentPanel({
  token,
  request,
  onDone,
}: {
  token: string;
  request: string;
  onDone: () => void;
}) {
  const [review, setReview] = useState<OAuthAuthorizationReview>();
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const lifecycle = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    setReview(undefined);
    setFailure('');
    setBusy(false);
    apiRequest<OAuthAuthorizationReview>(OAUTH_PATHS.review + '/' + encodeURIComponent(request), {
      token,
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setReview(value);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setFailure(errorText(error));
      });
    return () => {
      controller.abort();
    };
  }, [request, token]);
  async function decide(approve: boolean) {
    const controller = lifecycle.current;
    if (!review || !controller || controller.signal.aborted || busy) return;
    setBusy(true);
    try {
      const result = await apiRequest<{ redirect: string }>(
        OAUTH_PATHS.review + '/' + encodeURIComponent(request),
        {
          method: 'POST',
          token,
          signal: controller.signal,
          body: { approve, decisionToken: review.decisionToken },
        },
      );
      if (!controller.signal.aborted) {
        onDone();
        window.location.assign(result.redirect);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setFailure(errorText(error));
        setBusy(false);
      }
    }
  }
  return (
    <section className="panel" aria-labelledby="oauth-consent-title" aria-busy={busy}>
      <div className="section-head">
        <h2 className="section-title" id="oauth-consent-title">
          {t('授权 Agent 连接')}
        </h2>
      </div>
      {failure ? (
        <p className="msg msg--error" role="alert">
          {failure}
        </p>
      ) : !review ? (
        <p className="loading-note" role="status">
          {t('正在加载…')}
        </p>
      ) : (
        <>
          <p>{review.clientName}</p>
          <p className="section-hint">
            {t('Agent 将以你的身份调用中央管理工具，实际权限由服务器判定。')}
          </p>
          <ul>
            {review.scopes.map((scope) => (
              <li key={scope}>{scopes[scope]}</li>
            ))}
          </ul>
          <label className="field-label">
            {t('授权回调地址')}
            <input className="input" readOnly value={review.redirectUri} />
          </label>
          <div className="actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={() => {
                decide(true).catch((error: unknown) => console.error(error));
              }}
            >
              {t('授权')}
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              disabled={busy}
              onClick={() => {
                decide(false).catch((error: unknown) => console.error(error));
              }}
            >
              {t('拒绝')}
            </button>
          </div>
        </>
      )}
      <div className="actions">
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => {
            lifecycle.current?.abort();
            onDone();
          }}
        >
          {t('取消')}
        </button>
      </div>
    </section>
  );
}
export function OAuthGrantsPanel({
  token,
  notify,
}: {
  token: string;
  notify: (message: string, kind: 'error' | 'success') => void;
}) {
  const [grants, setGrants] = useState<OAuthGrantList>();
  const [failed, setFailed] = useState(false);
  const { copy, copied, note } = useClipboard();
  useEffect(() => {
    let active = true;
    apiRequest<OAuthGrantList>(OAUTH_PATHS.grants, { token })
      .then((value) => {
        if (active) setGrants(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [token]);
  async function revoke(id: string) {
    try {
      await apiRequest(OAUTH_PATHS.grants + '/' + encodeURIComponent(id), {
        method: 'DELETE',
        token,
      });
      setGrants((current) =>
        current ? { grants: current.grants.filter((grant) => grant.id !== id) } : current,
      );
      notify(t('已撤销 Agent 授权'), 'success');
    } catch (error) {
      notify(errorText(error), 'error');
    }
  }
  return (
    <section className="panel" aria-labelledby="oauth-grants-title">
      <div className="section-head">
        <h2 className="section-title" id="oauth-grants-title">
          {t('Agent 连接')}
        </h2>
      </div>
      <div className="code-row">
        <label className="field-label">
          {t('MCP 地址')}
          <input className="input bind-code" readOnly value={window.location.origin + MCP_PATH} />
        </label>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => copy(window.location.origin + MCP_PATH)}
        >
          {copied ? t('已复制') : t('复制地址')}
        </button>
      </div>
      <InlineNote note={note} />
      {failed ? (
        <p className="msg msg--error" role="alert">
          {t('无法加载 Agent 授权')}
        </p>
      ) : !grants ? (
        <p className="loading-note" role="status">
          {t('正在加载…')}
        </p>
      ) : !grants.grants.length ? (
        <p className="empty-note">{t('暂无 Agent 授权')}</p>
      ) : (
        <ul>
          {grants.grants.map((grant) => (
            <li key={grant.id}>
              <span>{grant.clientName}</span>
              <p>{grant.scopes.map((scope) => scopes[scope]).join('、')}</p>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => {
                  revoke(grant.id).catch((error: unknown) => console.error(error));
                }}
              >
                {t('撤销授权')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
