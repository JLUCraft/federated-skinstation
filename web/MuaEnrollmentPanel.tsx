import React, { useState } from 'react';
import type { MuaAdmission } from '../shared/contracts/generated';
import { apiRequest, errorText } from './api';
import { InlineNote, type Note } from './InlineNote';
import { t } from './i18n';

export function MuaEnrollmentPanel({
  admission,
  schools,
  onReady,
  onCancel,
}: {
  admission: MuaAdmission;
  schools: { id: string; emailDomains: string[] }[];
  onReady: () => Promise<void>;
  onCancel: () => void;
}) {
  const [email, setEmail] = useState(admission.email ?? '');
  const [name, setName] = useState('');
  const [school, setSchool] = useState(schools[0]?.id ?? '');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  async function submit() {
    setBusy(true);
    setNote(null);
    try {
      if (sent) {
        await apiRequest('/api/mua/enrollment/confirm', { method: 'POST', body: { code } });
        await onReady();
      } else {
        await apiRequest('/api/mua/enrollment/start', {
          method: 'POST',
          body: { email, name, school },
        });
        setSent(true);
        setNote({ tone: 'info', text: t('验证邮件已发送') });
      }
    } catch (error) {
      setNote({ tone: 'error', text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="tab-panel" aria-busy={busy}>
      <h2 className="section-title">{t('验证社团资格')}</h2>
      <p className="section-hint">{t('MUA 身份已确认，请验证学校邮箱后加入本地社团。')}</p>
      <p>{admission.nickname || admission.subject}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit().catch((error: unknown) => console.error(error));
        }}
      >
        <div className="field-grid field-grid--stack">
          <label className="field-label">
            {t('学校')}
            <select
              className="input"
              required
              disabled={busy || sent}
              value={school}
              onChange={(event) => setSchool(event.target.value)}
            >
              {schools.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.id}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            {t('学校邮箱')}
            <input
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              required
              disabled={busy || sent}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="field-label">
            {t('游戏名称')}
            <input
              className="input"
              autoComplete="nickname"
              pattern="[A-Za-z0-9_]+"
              maxLength={16}
              value={name}
              required
              disabled={busy || sent}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {sent && (
            <label className="field-label">
              {t('邮件验证码')}
              <input
                className="input"
                autoComplete="one-time-code"
                value={code}
                required
                disabled={busy}
                onChange={(event) => setCode(event.target.value)}
              />
            </label>
          )}
        </div>
        <InlineNote note={note} />
        <div className="actions">
          <button className="btn btn--primary" disabled={busy} type="submit">
            {sent ? t('验证并登录') : t('发送验证邮件')}
          </button>
          {sent && (
            <button
              className="btn btn--secondary"
              disabled={busy}
              type="button"
              onClick={() => {
                setSent(false);
                setCode('');
                setNote(null);
              }}
            >
              {t('修改信息')}
            </button>
          )}
          <button className="btn btn--secondary" disabled={busy} type="button" onClick={onCancel}>
            {t('返回登录')}
          </button>
        </div>
      </form>
    </div>
  );
}
