import React, { useEffect, useId, useState } from 'react';
import type {
  ClubDirectory, ClubMember, ClubMembers, GrantList, IdentitySnapshot,
} from '../shared/contracts/generated';
import { PASSWORD_RULES, RECOVERY_EMAIL_MAX_LENGTH } from '../shared/identity';
import { isPermission, type Permission } from '../shared/permissions';
import { apiRequest, errorText } from './api';
import { t, tf } from './i18n';

const PERMISSION_LABELS: Record<Permission, string> = {
  admin: t('管理员'),
  manage: t('管理权限'),
  president: t('会长'),
  read: t('只读'),
  write: t('写入'),
  'members.manage': t('成员管理'),
  'chairs.manage': t('会长交接'),
  'grants.manage': t('授权管理'),
  'services.manage': t('服务管理'),
  'accounts.disable': t('停用账号'),
  'accounts.recover': t('账号恢复'),
};

function permissionLabel(permission: string) {
  return isPermission(permission) ? PERMISSION_LABELS[permission] : permission;
}

function AccountField({
  value, onChange, members, label,
}: {
  value: string; onChange: (value: string) => void;
  members: ClubMember[]; label: string;
}) {
  const fieldId = useId();
  return (
    <div className="field-label">
      <label htmlFor={fieldId}>{label}</label>
      {members.length ? (
        <select id={fieldId} className="input" required value={value} onChange={event => onChange(event.target.value)}>
          <option value="">{t('选择账号')}</option>
          {members.map(member => <option key={member.account} value={member.account}>{member.name}</option>)}
        </select>
      ) : (
        <input id={fieldId} className="input" required placeholder={t('填写账号编号')} value={value} onChange={event => onChange(event.target.value)} />
      )}
    </div>
  );
}

export function IdentityPanel({ token }: { token: string }) {
  const [snapshot, setSnapshot] = useState<IdentitySnapshot>();
  const [directory, setDirectory] = useState<ClubDirectory>();
  const [members, setMembers] = useState<ClubMember[]>([]);
  const [grants, setGrants] = useState<GrantList>();
  const [selectedClub, setSelectedClub] = useState('');
  const [selectedScope, setSelectedScope] = useState('');
  const [account, setAccount] = useState('');
  const [nominee, setNominee] = useState('');
  const [permission, setPermission] = useState('');
  const [recoveryAccount, setRecoveryAccount] = useState('');
  const [email, setEmail] = useState('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [membersLoading, setMembersLoading] = useState(false);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const club = directory?.clubs.find(item => item.id === selectedClub) ?? directory?.clubs[0];
  const clubPath = club ? `/api/clubs/${encodeURIComponent(club.id)}` : '';
  const scopes = [
    ...(club?.permissions.grants ? [{ id: `club:${club.id}`, label: club.title }] : []),
    ...(directory?.globalGrants ? [{ id: 'global', label: t('站点') }] : []),
    ...(directory?.muaGrants ? [{ id: 'service:mua', label: t('MUA 服务') }] : []),
  ];
  const scope = scopes.find(item => item.id === selectedScope)?.id ?? scopes[0]?.id ?? '';
  const activeMembers = members.filter(member => member.status === 'active' && !member.disabled);
  const nominees = activeMembers.filter(member =>
    club?.permissions.selfNomination || member.account !== snapshot?.account);
  const selectedPermission = grants?.grantablePermissions.includes(permission)
    ? permission : '';

  useEffect(() => {
    let current = true;
    setLoading(true);
    void Promise.all([
      apiRequest('/api/identity', { token }),
      apiRequest('/api/clubs', { token }),
    ]).then(([identity, clubs]) => {
      if (current) {
        setSnapshot(identity);
        setDirectory(clubs);
        setError('');
      }
    }).catch(reason => {
      if (current) {
        setSnapshot(undefined);
        setDirectory(undefined);
        setError(errorText(reason));
      }
    })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [token, revision]);

  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

  useEffect(() => {
    setMembers([]);
    setAccount('');
    setNominee('');
    setRecoveryAccount('');
  }, [clubPath]);

  useEffect(() => {
    let current = true;
    setMembersLoading(false);
    if (!club?.permissions.members) return () => { current = false; };
    setMembersLoading(true);
    void apiRequest(`${clubPath}/members`, { token }).then((response: ClubMembers) => {
      if (current) setMembers(response.members);
    }).catch(reason => { if (current) setError(errorText(reason)); })
      .finally(() => { if (current) setMembersLoading(false); });
    return () => { current = false; };
  }, [token, clubPath, club?.permissions.members, revision]);

  useEffect(() => {
    let current = true;
    setGrants(undefined);
    setGrantsLoading(false);
    if (!scope) return () => { current = false; };
    setGrantsLoading(true);
    void apiRequest(`/api/identity/grants?scope=${encodeURIComponent(scope)}`, { token })
      .then((response: GrantList) => { if (current) setGrants(response); })
      .catch(reason => { if (current) setError(errorText(reason)); })
      .finally(() => { if (current) setGrantsLoading(false); });
    return () => { current = false; };
  }, [token, scope, revision]);

  async function act(path: string, body?: unknown, method = 'POST', success = t('已更新')) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await apiRequest(path, { token, method, body });
      setRevision(value => value + 1);
      setMessage(success);
      window.dispatchEvent(new Event('avatar-changed'));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>{t('社团管理')}</h2>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {loading && <p role="status">{t('正在加载…')}</p>}
      {!loading && !snapshot && <button className="btn btn--secondary" onClick={() => setRevision(value => value + 1)}>{t('重试')}</button>}
      {snapshot && <>
        <p>{t('账号编号')}</p>
        <p><code>{snapshot.account}</code></p>
        <h3 className="subsection-title">{t('我的社团')}</h3>
        {snapshot.memberships.length === 0 ? <p>{t('暂无社团')}</p> : snapshot.memberships.map(membership => (
          <article className="notice-row" key={membership.club}>
            <strong>{membership.title}</strong>
            <p>{membership.status === 'active' ? t('有效成员') : t('成员资格已撤销')}</p>
            {membership.chair && <p>{t('会长')}</p>}
          </article>
        ))}
        {snapshot.successions.length > 0 && <div className="panel--inset">
          <h3 className="subsection-title">{t('待接受的会长提名')}</h3>
          {snapshot.successions.map(nomination => (
            <article className="notice-row" key={nomination.id}>
              <p>{snapshot.memberships.find(item => item.club === nomination.club)?.title ?? nomination.club}</p>
              <button className="btn btn--primary" disabled={busy}
                onClick={() => void act(`/api/identity/successions/${encodeURIComponent(nomination.id)}/accept`)}>
                {t('接受提名')}
              </button>
            </article>
          ))}
        </div>}
      </>}
      {directory && <>
        {directory.clubs.length === 0 ? <p>{t('暂无可管理的社团')}</p> : <>
          <div className="field-label">
            <label htmlFor="identity-club">{t('管理社团')}</label>
            <select id="identity-club" className="input" value={club?.id ?? ''} onChange={event => {
              setSelectedClub(event.target.value);
              setAccount('');
              setNominee('');
              setRecoveryAccount('');
              setMessage('');
              if (scope.startsWith('club:')) setSelectedScope(`club:${event.target.value}`);
            }} disabled={busy}>
              {directory.clubs.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </div>
          {club && <p>{tf('现任会长：{name}', { name: club.chairName ?? t('尚未任命') })}</p>}
          {club?.permissions.members && <div className="panel--inset">
            <h3 className="subsection-title">{t('成员管理')}</h3>
            {membersLoading ? <p role="status">{t('正在加载…')}</p> : members.length === 0 ? <p>{t('暂无成员')}</p> : members.map(member => (
              <article className="notice-row" key={member.account}>
                <strong>{member.name}</strong>
                <p>{member.disabled ? t('账号已停用') : member.status === 'active' ? t('有效成员') : t('成员资格已撤销')}</p>
                <div className="actions">
                  {member.status === 'active' && <button className="btn btn--danger" disabled={busy}
                    onClick={() => {
                      if (window.confirm(t('撤销此成员资格？')))
                        void act(`${clubPath}/members/${encodeURIComponent(member.account)}/revoke`);
                    }}>{t('撤销成员资格')}</button>}
                  {directory.disableAccounts && !member.disabled && <button className="btn btn--danger" disabled={busy}
                    onClick={() => {
                      if (window.confirm(t('停用此账号并退出所有设备？')))
                        void act(`/api/admin/accounts/${encodeURIComponent(member.account)}/disable`);
                    }}>{t('停用账号')}</button>}
                </div>
              </article>
            ))}
          </div>}
          {club?.permissions.chairs && <form className="panel--inset" onSubmit={event => {
            event.preventDefault();
            void act(`${clubPath}/successions`, { nominee });
          }}>
            <h3 className="subsection-title">{t('会长交接')}</h3>
            <AccountField label={t('提名账号')} value={nominee} onChange={setNominee} members={nominees} />
            <button className="btn btn--primary" disabled={busy || membersLoading}>{t('发出提名')}</button>
          </form>}
          {club?.permissions.recovery && <form className="panel--inset" onSubmit={event => {
            event.preventDefault();
            if (window.confirm(t('向新邮箱发送账号恢复验证码？')))
              void act(`${clubPath}/recoveries`, { account: recoveryAccount, email }, 'POST', t('恢复验证码已发送'));
          }}>
            <h3 className="subsection-title">{t('账号恢复')}</h3>
            <p>{t('恢复后将退出所有设备并移除通行密钥')}</p>
            <AccountField label={t('恢复账号')} value={recoveryAccount} onChange={setRecoveryAccount} members={activeMembers} />
            <label className="field-label">{t('新邮箱')}<input className="input" type="email" required maxLength={RECOVERY_EMAIL_MAX_LENGTH} value={email} onChange={event => setEmail(event.target.value)} /></label>
            <button className="btn btn--primary" disabled={busy || membersLoading}>{t('发送恢复验证码')}</button>
          </form>}
        </>}
        {scopes.length > 0 && <div className="panel--inset">
          <h3 className="subsection-title">{t('授权管理')}</h3>
          <div className="field-label"><label htmlFor="identity-scope">{t('授权范围')}</label>
            <select id="identity-scope" className="input" value={scope} onChange={event => setSelectedScope(event.target.value)} disabled={busy}>
              {scopes.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </div>
          {grantsLoading ? <p role="status">{t('正在加载…')}</p> : grants && <>
            {grants.grants.length === 0 ? <p>{t('暂无授权')}</p> : grants.grants.map(grant => (
              <article className="notice-row" key={grant.id}>
                <strong>{grant.name ?? grant.principal}</strong>
                <p>{permissionLabel(grant.permission)}</p>
                <button className="btn btn--danger" disabled={busy}
                  onClick={() => {
                    if (window.confirm(t('撤销此授权？')))
                      void act(`/api/identity/grants/${encodeURIComponent(grant.id)}`, undefined, 'DELETE');
                  }}>{t('撤销授权')}</button>
              </article>
            ))}
            {grants.grantablePermissions.length > 0 && <form onSubmit={event => {
              event.preventDefault();
              void act('/api/identity/grants', { account, scope, permission: selectedPermission });
            }}>
              <AccountField label={t('授权账号')} value={account} onChange={setAccount} members={activeMembers} />
              <div className="field-label"><label htmlFor="identity-permission">{t('权限')}</label>
                <select id="identity-permission" className="input" required value={selectedPermission} onChange={event => setPermission(event.target.value)}>
                  <option value="">{t('选择权限')}</option>
                  {grants.grantablePermissions.map(item => <option key={item} value={item}>{permissionLabel(item)}</option>)}
                </select>
              </div>
              <button className="btn btn--primary" disabled={busy || membersLoading}>{t('授予权限')}</button>
            </form>}
          </>}
        </div>}
      </>}
    </section>
  );
}

export function RecoveryPanel({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [confirmation, setConfirmation] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <section className="panel panel--narrow">
      <h2>{t('账号恢复')}</h2>
      <p>{t('请先联系所属社团，再填写新邮箱收到的恢复验证码')}</p>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={event => {
        event.preventDefault();
        setBusy(true);
        setError('');
        void apiRequest('/api/recovery/confirm', { method: 'POST', body: { confirmation: confirmation.trim(), password } })
          .then(onDone)
          .catch(reason => setError(errorText(reason)))
          .finally(() => setBusy(false));
      }}>
        <label className="field-label">{t('恢复验证码')}<input className="input" required autoComplete="one-time-code" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
        <label className="field-label">{t('新密码')}<input className="input" type="password" required autoComplete="new-password" minLength={PASSWORD_RULES.minLength} maxLength={PASSWORD_RULES.maxLength} value={password} onChange={event => setPassword(event.target.value)} /></label>
        <div className="actions">
          <button className="btn btn--primary" disabled={busy}>{t('恢复账号')}</button>
          <button className="btn btn--secondary" type="button" disabled={busy} onClick={onCancel}>{t('返回登录')}</button>
        </div>
      </form>
    </section>
  );
}
