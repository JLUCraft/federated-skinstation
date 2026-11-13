import React, { useEffect, useRef, useState } from 'react';
import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type { OperationsApproval } from '../shared/contracts/generated';
import { OPERATIONS_APPROVAL_PATH } from '../shared/operations';
import { apiRequest, errorText } from './api';
import { t } from './i18n';

export function OperationApprovalPanel({
  token,
  request,
  onDone,
}: {
  token: string;
  request: string;
  onDone: () => void;
}) {
  const [review, setReview] = useState<OperationsApproval>();
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const lifecycle = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    setReview(undefined);
    setPassword('');
    setFailure('');
    setBusy(false);
    apiRequest<OperationsApproval>(OPERATIONS_APPROVAL_PATH + '/' + encodeURIComponent(request), {
      token,
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setReview(value);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setFailure(errorText(error));
      });
    return () => controller.abort();
  }, [token, request]);
  async function decide(method: 'password' | 'passkey' | 'deny') {
    const controller = lifecycle.current;
    if (!review || !controller || controller.signal.aborted || busy) return;
    setBusy(true);
    setFailure('');
    try {
      const path = OPERATIONS_APPROVAL_PATH + '/' + encodeURIComponent(review.id);
      if (method === 'passkey') {
        const passkeyPath = '/api/passkeys/operations/' + encodeURIComponent(review.id);
        const options = await apiRequest<PublicKeyCredentialRequestOptionsJSON>(
          passkeyPath + '/options',
          { method: 'POST', token, body: {}, signal: controller.signal },
        );
        const response = await startAuthentication({ optionsJSON: options });
        await apiRequest(passkeyPath + '/verify', {
          method: 'POST',
          token,
          body: { response },
          signal: controller.signal,
        });
      } else
        await apiRequest(path + (method === 'deny' ? '/deny' : '/confirm'), {
          method: 'POST',
          token,
          body: method === 'deny' ? {} : { password },
          signal: controller.signal,
        });
      if (!controller.signal.aborted) onDone();
    } catch (error) {
      if (!controller.signal.aborted) {
        setFailure(errorText(error));
        setBusy(false);
      }
    } finally {
      setPassword('');
    }
  }
  return (
    <section className="panel" aria-labelledby="operation-approval-title" aria-busy={busy}>
      <div className="section-head">
        <h2 className="section-title" id="operation-approval-title">
          {t('确认运维操作')}
        </h2>
      </div>
      {failure && (
        <p className="msg msg--error" role="alert">
          {failure}
        </p>
      )}
      {!review ? (
        <p className="loading-note" role="status">
          {t('正在加载…')}
        </p>
      ) : (
        <>
          <dl>
            <dt>{t('目标主机')}</dt>
            <dd>{review.host}</dd>
            <dt>{t('目标实例')}</dt>
            <dd>{review.intent.command.instance}</dd>
            <dt>{t('请求来源')}</dt>
            <dd>{review.clientName ?? t('皮肤站')}</dd>
          </dl>
          <pre className="operation-payload">
            {JSON.stringify(review.intent.command.operation, null, 2)}
          </pre>
          {review.status === 'pending' ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                decide('password').catch((error: unknown) => console.error(error));
              }}
            >
              <label className="field-label">
                {t('当前密码')}
                <input
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  disabled={busy}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <div className="actions">
                <button className="btn btn--primary" type="submit" disabled={busy}>
                  {t('确认并执行')}
                </button>
                <button
                  className="btn btn--secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    decide('passkey').catch((error: unknown) => console.error(error));
                  }}
                >
                  {t('使用通行密钥确认')}
                </button>
                <button
                  className="btn btn--secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    decide('deny').catch((error: unknown) => console.error(error));
                  }}
                >
                  {t('拒绝操作')}
                </button>
              </div>
            </form>
          ) : (
            <p role="status">
              {review.status === 'expired' ? t('操作确认已过期') : t('操作已处理')}
            </p>
          )}
        </>
      )}
      <div className="actions">
        <button
          className="btn btn--secondary"
          type="button"
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
