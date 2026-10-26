import {
  Announcements,
  AdminPanel,
  Notifications,
  PublicPage,
} from './CommunityPanel';
import { Avatar } from './TextureIdentity';
import { InlineNote, type Note } from './InlineNote';
import { t, tf } from './i18n';
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './tokens.css';
import './style.css';
import { MuaAccountCard, MuaPanel } from './MuaPanel';
import { TexturesPanel } from './TexturesPanel';
import { WardrobePanel, type LibraryViewState } from './WardrobePanel';
import { PasskeysPanel, loginWithPasskey } from './PasskeysPanel';
import { ConnectPanel } from './ConnectPanel';
import { DevicePanel } from './DevicePanel';
import { ApiError, apiRequest, errorText } from './api';

type MsgKind = 'success' | 'error';
type AuthTab = 'login' | 'register' | 'reset';
type Page =
  | 'notifications'
  | 'admin'
  | 'login'
  | 'device'
  | 'textures'
  | 'wardrobe'
  | 'library'
  | 'account'
  | 'community';
const SUCCESS_NOTICE_MS = 6000;
/** Decorative marks for the static value list; never announced. */
const HERO_FEATURES = [
  ['✓', t('公共皮肤库'), t('浏览并收藏各校同学公开的皮肤与披风。')],
  ['✓', t('三维预览'), t('旋转、行走，先看效果再使用。')],
  ['✓', t('学校邮箱验证'), t('用学校邮箱注册，各高校共用同一个皮肤站。')],
] as const;

const TAB_LABELS: Record<AuthTab, string> = {
  login: t('登录'),
  register: t('注册新账号'),
  reset: t('重置密码'),
};

const MSG_CLASS: Record<MsgKind, string> = {
  success: 'msg msg--success',
  error: 'msg msg--error',
};

/** School as published by `/api/capabilities`; the suffix hint comes from here. */
type SchoolOption = { id: string; emailDomains: string[] };

function App() {
  const [libraryState, setLibraryState] = useState<LibraryViewState>();
  const [publicPath, setPublicPath] = useState(() =>
    window.location.pathname.replace(/^\/portal/, ''),
  );
  const [avatar, setAvatar] = useState<string | null>(null);
  const [siteAdmin, setSiteAdmin] = useState(false);
  const [unread, setUnread] = useState(0);
  const [schools, setSchools] = useState<SchoolOption[]>([]);
  const [capsLoading, setCapsLoading] = useState(true);
  const [page, setPage] = useState<Page>('login');
  const [deviceCode, setDeviceCode] = useState(
    () => new URLSearchParams(window.location.search).get('user_code') ?? '',
  );
  const [displayName, setDisplayName] = useState('');
  const [muaEnabled, setMuaEnabled] = useState(false);
  const [muaMember, setMuaMember] = useState(false);
  useEffect(() => {
    void fetch('/api/capabilities')
      .then((r) => r.json())
      .then((c) => {
        setMuaEnabled(c.muaOAuth === true);
        setMuaMember(c.muaMember === true);
        const list: SchoolOption[] = c.schools ?? [];
        setSchools(list);
        setSchool((current) =>
          list.some((s) => s.id === current) ? current : (list[0]?.id ?? ''),
        );
      })
      .catch(() => notify(t('无法加载站点信息，请稍后刷新重试'), 'error'))
      .finally(() => setCapsLoading(false));
  }, []);

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [school, setSchool] = useState('jlu');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const [msgKind, setMsgKind] = useState<MsgKind>('success');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<AuthTab>('login');
  const [resetSent, setResetSent] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  /** Set once the sent code no longer matches the edited fields. */
  const [codeStale, setCodeStale] = useState(false);
  /** Inline, form-scoped feedback; the global toast is reserved for page-level events. */
  const [loginNote, setLoginNote] = useState<Note | null>(null);
  const [registerNote, setRegisterNote] = useState<Note | null>(null);
  const [resetNote, setResetNote] = useState<Note | null>(null);
  const notify = (text: string, kind: MsgKind) => {
    setMessage(text);
    setMsgKind(kind);
  };
  useEffect(() => {
    if (!message || msgKind !== 'success') return;
    const timer = window.setTimeout(() => setMessage(''), SUCCESS_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [message, msgKind]);
  const refreshNotices = () => {
    if (token)
      void apiRequest('/api/notifications', { token })
        .then((r) => setUnread(r.unread))
        .catch(() => {});
  };
  useEffect(() => {
    if (!token) {
      setAvatar(null);
      setSiteAdmin(false);
      setUnread(0);
      return;
    }
    let active = true;
    const refresh = () => {
      void apiRequest('/api/me', { token })
        .then((r) => {
          if (active) {
            setAvatar(r.avatar);
            setSiteAdmin(r.siteAdmin);
          }
        })
        .catch(() => {});
      if (active) refreshNotices();
    };
    refresh();
    window.addEventListener('avatar-changed', refresh);
    return () => {
      active = false;
      window.removeEventListener('avatar-changed', refresh);
    };
  }, [token]);
  useEffect(() => {
    const pop = () =>
      setPublicPath(window.location.pathname.replace(/^\/portal/, ''));
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  const publicView = /^\/(?:library|u)\/[^/]+$/.test(publicPath);
  const view: Page = token
    ? deviceCode
      ? 'device'
      : page === 'login'
        ? 'textures'
        : page
    : page === 'library'
      ? 'library'
      : 'login';
  /** Detail and author pages belong to the library section, so keep that nav item lit. */
  const activePage: Page | null = publicView ? 'library' : view;
  function goto(next: Page) {
    setPublicPath('');
    if (publicView) window.history.pushState(null, '', '/portal/');
    if (next === 'notifications') refreshNotices();
    setPage(next);
    setMessage('');
    window.scrollTo({ top: 0 });
  }

  async function request(path: string, body: unknown) {
    try {
      return await apiRequest(path, {
        method: 'POST',
        body,
        errorMessage: t('请求被拒绝，请检查信息或稍后重试'),
      });
    } catch (e) {
      // Only registration can clash on a game name.
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        path.startsWith('/api/email/')
      )
        throw new Error(t('这个游戏名称已被使用，请换一个。'));
      throw e;
    }
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  function selectTab(next: AuthTab) {
    setTab(next);
    if (next !== 'reset') setResetSent(false);
    if (next !== 'register') setCodeStale(false);
    setLoginNote(null);
    setRegisterNote(null);
    setResetNote(null);
    document.getElementById(`tab-${next}`)?.focus();
  }
  function onTabKeyDown(e: React.KeyboardEvent) {
    const tabs: AuthTab[] =
      tab === 'reset' ? ['login', 'register', 'reset'] : ['login', 'register'];
    const index = tabs.indexOf(tab);
    let next: AuthTab | null = null;
    if (e.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
    else if (e.key === 'ArrowLeft')
      next = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (e.key === 'Home') next = 'login';
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    if (next) {
      e.preventDefault();
      selectTab(next);
    }
  }
  function enterReset() {
    setCode('');
    setPassword('');
    setResetSent(false);
    setResetNote(null);
    selectTab('reset');
  }
  function leaveReset(next: AuthTab) {
    setCode('');
    setPassword('');
    setResetNote(null);
    selectTab(next);
  }

  /**
   * Editing a registration field invalidates the emailed code server-side, so the
   * code block stays mounted and explains why it must be resent.
   */
  function changeRegistration(update: () => void) {
    update();
    if (codeSent) setCodeStale(true);
    setRegisterNote(null);
  }

  async function sendVerifyEmail() {
    await request('/api/email/start', { email, password, name, school });
    setCodeSent(true);
    setCodeStale(false);
    setCode('');
    setRegisterNote({
      tone: 'info',
      text: tf('验证邮件已发送至 {email}，15 分钟内有效。', { email }),
    });
  }
  async function confirmEmail() {
    await request('/api/email/confirm', { email, code });
    setCode('');
    setCodeSent(false);
    setCodeStale(false);
    setRegisterNote(null);
    setEmail(address);
    setPassword('');
    setTab('login');
    setLoginNote({
      tone: 'success',
      text: t('邮箱已验证成功，请使用邮箱和密码登录。'),
    });
  }
  async function login() {
    const data = await request('/authserver/authenticate', {
      username: email,
      password,
    });
    setToken(data.accessToken);
    setDisplayName((data.selectedProfile ?? data.availableProfiles[0]).name);
    setPassword('');
    setLoginNote(null);
    notify(t('登录成功'), 'success');
  }

  const selectedSchool = schools.find((s) => s.id === school);
  const schoolDomains = selectedSchool?.emailDomains ?? [];
  const servedSchool = schools[0];
  const address = email.trim();
  const loginTab: AuthTab[] = ['login', 'register'];
  const tabs: AuthTab[] = tab === 'reset' ? [...loginTab, 'reset'] : loginTab;
  const accountLabel = displayName;

  return (
    <main
      className="app-main"
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        const link = (event.target as Element).closest<HTMLAnchorElement>(
          'a[href]',
        );
        if (!link || link.target || link.hasAttribute('download')) return;
        const url = new URL(link.href);
        if (
          url.origin === window.location.origin &&
          /^\/portal\/(library|u)\/[^/]+$/.test(url.pathname)
        ) {
          event.preventDefault();
          window.history.pushState(null, '', url.pathname);
          setPublicPath(url.pathname.replace(/^\/portal/, ''));
          setMessage('');
          window.scrollTo({ top: 0 });
        }
      }}
    >
      <header className="site-header">
        <div className="site-header-bar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              JL
            </span>
            <span className="brand-name">JLUCraft</span>
            <h1 className="site-title">{t('皮肤站')}</h1>
          </div>
          {token && (
            <span className="user-chip">
              <Avatar hash={avatar ?? undefined} />
              <span className="user-chip-text">
                <span className="user-chip-label">{t('站点账号')}</span>
                <span className="user-chip-name">{accountLabel}</span>
              </span>
              <span className="user-chip-caret" aria-hidden="true">
                ▾
              </span>
            </span>
          )}
        </div>
        <nav className="portal-navigation" aria-label={t('皮肤站导航')}>
          {(
            [
              ...(token
                ? ([
                    ['textures', t('角色外观')],
                    ['wardrobe', t('衣柜')],
                  ] as const)
                : ([['login', t('登录 / 注册')]] as const)),
              ['library', t('皮肤库')],
              ...(token
                ? ([
                    [
                      'notifications',
                      unread > 0
                        ? `${t('站内通知')} · ${unread}`
                        : t('站内通知'),
                    ],
                  ] as const)
                : []),
              ...(token && siteAdmin
                ? ([['admin', t('站点管理')]] as const)
                : []),
              ...(token ? ([['account', t('账号安全')]] as const) : []),
              ...(token && (muaEnabled || muaMember)
                ? ([['community', t('高校社区')]] as const)
                : []),
            ] as const
          ).map(([key, label]) => (
            <button
              className={`portal-navigation-item${activePage === key ? ' portal-navigation-item--active' : ''}`}
              key={key}
              aria-current={activePage === key ? 'page' : undefined}
              onClick={() => goto(key)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      {message && (
        <div
          className={`${MSG_CLASS[msgKind]} toast`}
          role={msgKind === 'error' ? 'alert' : 'status'}
        >
          <span className="toast-text">{message}</span>
          <button
            type="button"
            className="toast-close"
            aria-label={t('关闭提示')}
            onClick={() => setMessage('')}
          >
            ×
          </button>
        </div>
      )}

      <Announcements />
      {publicView ? (
        <PublicPage
          key={publicPath}
          path={publicPath}
          token={token || undefined}
        />
      ) : (
        <div
          className={`portal-body${view === 'login' && !deviceCode ? ' auth-layout' : ''}`}
        >
          {view === 'login' && deviceCode && (
            <section
              className="panel panel--narrow panel--centered"
              aria-labelledby="device-wait-title"
            >
              <h2 className="section-title" id="device-wait-title">
                {t('启动器正在等待授权')}
              </h2>
              <p className="section-hint">
                {t(
                  '请先登录（没有账号请先注册），完成后会回到这里确认授权码：',
                )}
              </p>
              <p className="device-code">{deviceCode}</p>
            </section>
          )}
          {token && view === 'device' && (
            <DevicePanel
              token={token}
              userCode={deviceCode}
              notify={notify}
              onDone={() => {
                window.history.replaceState(null, '', window.location.pathname);
                setDeviceCode('');
                setPage('textures');
              }}
            />
          )}
          {view === 'login' && !deviceCode && (
            <div className="hero">
              <p className="hero-lead">
                {t('一个账号，进入各高校的 Minecraft 服务器。')}
              </p>
              <ul className="hero-features">
                {HERO_FEATURES.map(([mark, title, text]) => (
                  <li className="hero-feature" key={title}>
                    <span className="hero-feature-mark" aria-hidden="true">
                      {mark}
                    </span>
                    <span className="hero-feature-body">
                      <strong className="hero-feature-title">{title}</strong>
                      <span className="hero-feature-text">{text}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(view === 'login' || (token && view === 'account')) && (
            <section
              className={`panel${view === 'login' ? ' panel--narrow' : ''}`}
              aria-label={token ? undefined : t('登录或注册')}
              aria-labelledby={token ? 'auth-title' : undefined}
              aria-busy={capsLoading}
            >
              {capsLoading && (
                <p className="loading-note" role="status">
                  {t('正在加载可用学校…')}
                </p>
              )}

              {!token && !capsLoading && (
                <>
                  <div
                    className="tabs"
                    role="tablist"
                    aria-label={t('登录或注册')}
                    onKeyDown={onTabKeyDown}
                  >
                    {tabs.map((id) => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        id={`tab-${id}`}
                        tabIndex={tab === id ? 0 : -1}
                        aria-selected={tab === id}
                        aria-controls={`panel-${id}`}
                        className={`tab${tab === id ? ' tab--active' : ''}`}
                        onClick={() => selectTab(id)}
                      >
                        {TAB_LABELS[id]}
                      </button>
                    ))}
                  </div>

                  {tab === 'login' && (
                    <div
                      role="tabpanel"
                      id="panel-login"
                      aria-labelledby="tab-login"
                      className="tab-panel"
                    >
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void action(login);
                        }}
                      >
                        <div className="field-grid field-grid--stack">
                          <label className="field-label">
                            {t('学校邮箱')}
                            <input
                              className="input"
                              type="email"
                              autoComplete="username"
                              value={email}
                              onChange={(e) => setEmail(e.target.value)}
                              required
                            />
                          </label>
                          <label className="field-label">
                            {t('密码')}
                            <input
                              className="input"
                              type="password"
                              autoComplete="current-password"
                              value={password}
                              onChange={(e) => setPassword(e.target.value)}
                              minLength={12}
                              required
                            />
                          </label>
                        </div>
                        <InlineNote note={loginNote} />
                        <div className="actions">
                          <button
                            className="btn btn--primary"
                            disabled={busy}
                            type="submit"
                          >
                            {t('登录')}
                          </button>
                          {window.PublicKeyCredential && (
                            <button
                              type="button"
                              className="btn btn--secondary"
                              disabled={busy}
                              onClick={() =>
                                void action(async () => {
                                  const data = await loginWithPasskey();
                                  setToken(data.accessToken);
                                  setDisplayName(data.selectedProfile.name);
                                  setPassword('');
                                  setLoginNote(null);
                                  notify(t('登录成功'), 'success');
                                })
                              }
                            >
                              {t('使用通行密钥登录')}
                            </button>
                          )}
                        </div>
                      </form>
                      <button
                        type="button"
                        className="btn btn--link"
                        disabled={busy}
                        onClick={enterReset}
                      >
                        {t('忘记密码')}
                      </button>
                    </div>
                  )}

                  {tab === 'reset' && (
                    <div
                      role="tabpanel"
                      id="panel-reset"
                      aria-labelledby="tab-reset"
                      className="tab-panel"
                    >
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void action(async () => {
                            if (!resetSent) {
                              await request('/api/password/start', { email });
                              setResetSent(true);
                              setResetNote({
                                tone: 'info',
                                text: t('若该邮箱已注册，你将收到重置密码邮件'),
                              });
                            } else {
                              await request('/api/password/confirm', {
                                email,
                                code,
                                password,
                              });
                              leaveReset('login');
                              setLoginNote({
                                tone: 'success',
                                text: t('密码已更新，请重新登录'),
                              });
                            }
                          });
                        }}
                      >
                        <div className="field-grid field-grid--stack">
                          <label className="field-label">
                            {t('学校邮箱')}
                            <input
                              className="input"
                              type="email"
                              autoComplete="username"
                              value={email}
                              disabled={busy || resetSent}
                              onChange={(e) => setEmail(e.target.value)}
                              required
                            />
                          </label>
                          {resetSent && (
                            <>
                              <InlineNote note={resetNote} />
                              <label className="field-label">
                                {t('邮件验证码')}
                                <input
                                  className="input"
                                  value={code}
                                  onChange={(e) => setCode(e.target.value)}
                                  autoComplete="off"
                                  autoFocus
                                  required
                                />
                              </label>
                              <label className="field-label">
                                {t('新密码')}
                                <input
                                  className="input"
                                  type="password"
                                  autoComplete="new-password"
                                  minLength={12}
                                  value={password}
                                  onChange={(e) => setPassword(e.target.value)}
                                  required
                                />
                              </label>
                            </>
                          )}
                        </div>
                        <div className="actions">
                          <button
                            className="btn btn--primary"
                            type="submit"
                            disabled={busy}
                          >
                            {resetSent ? t('更新密码') : t('发送重置邮件')}
                          </button>
                          {resetSent && (
                            <button
                              type="button"
                              className="btn btn--secondary"
                              disabled={busy}
                              onClick={() =>
                                void action(async () => {
                                  await request('/api/password/start', {
                                    email,
                                  });
                                  setCode('');
                                  setResetNote({
                                    tone: 'info',
                                    text: tf(
                                      '重置密码邮件已重新发送至 {email}。',
                                      { email: address },
                                    ),
                                  });
                                })
                              }
                            >
                              {t('重新发送验证码')}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn--secondary"
                            disabled={busy}
                            onClick={() => leaveReset('login')}
                          >
                            {t('返回登录')}
                          </button>
                        </div>
                      </form>
                    </div>
                  )}

                  {tab === 'register' && (
                    <div
                      role="tabpanel"
                      id="panel-register"
                      aria-labelledby="tab-register"
                      className="tab-panel"
                    >
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void action(sendVerifyEmail);
                        }}
                      >
                        <div className="field-grid">
                          <label className="field-label">
                            {t('学校')}
                            <select
                              className="input"
                              aria-label={t('学校')}
                              value={school}
                              disabled={busy}
                              onChange={(e) =>
                                changeRegistration(() =>
                                  setSchool(e.target.value),
                                )
                              }
                              required
                            >
                              {schools.map((option) => (
                                <option key={option.id} value={option.id}>
                                  {option.id.toUpperCase()}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="field-label">
                            {t('学校邮箱')}
                            <input
                              className="input"
                              type="email"
                              autoComplete="username"
                              value={email}
                              disabled={busy}
                              onChange={(e) =>
                                changeRegistration(() =>
                                  setEmail(e.target.value),
                                )
                              }
                              required
                              aria-describedby="school-email-hint"
                            />
                            <span
                              className="field-hint"
                              id="school-email-hint"
                            >
                              {schoolDomains.length > 0
                                ? t('仅接受本校教育邮箱：')
                                : servedSchool
                                  ? tf('可用的学校邮箱后缀请向 {school} 确认。', {
                                      school: servedSchool.id.toUpperCase(),
                                    })
                                  : t('请选择学校后查看允许的邮箱后缀。')}
                              {schoolDomains.map((domain) => (
                                <span
                                  className="field-hint-domain"
                                  key={domain}
                                >
                                  @{domain}
                                </span>
                              ))}
                            </span>
                          </label>
                          <label className="field-label">
                            {t('游戏名称')}
                            <input
                              className="input"
                              value={name}
                              disabled={busy}
                              onChange={(e) =>
                                changeRegistration(() =>
                                  setName(e.target.value),
                                )
                              }
                              maxLength={16}
                              pattern="[A-Za-z0-9_]+"
                              title={t('1 到 16 位字母、数字或下划线')}
                              required
                              aria-describedby="name-hint"
                            />
                            <span className="field-hint" id="name-hint">
                              {t('1 到 16 位字母、数字或下划线')}
                            </span>
                          </label>
                          <label className="field-label">
                            {t('设置密码')}
                            <input
                              className="input"
                              type="password"
                              autoComplete="new-password"
                              value={password}
                              disabled={busy}
                              onChange={(e) =>
                                changeRegistration(() =>
                                  setPassword(e.target.value),
                                )
                              }
                              minLength={12}
                              required
                              aria-describedby="password-hint"
                            />
                            <span className="field-hint" id="password-hint">
                              {t('至少 12 位')}
                            </span>
                          </label>
                        </div>
                        <div className="actions">
                          <button
                            className={`btn ${codeSent ? 'btn--secondary' : 'btn--primary'}`}
                            disabled={busy}
                            type="submit"
                          >
                            {codeSent
                              ? t('重新发送验证邮件')
                              : t('发送验证邮件')}
                          </button>
                        </div>
                      </form>
                      {codeSent && (
                        <form
                          className="verify-step"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void action(confirmEmail);
                          }}
                        >
                          {codeStale ? (
                            <InlineNote
                              note={{
                                tone: 'warn',
                                text: t(
                                  '注册信息已变更，原验证码已失效。请重新发送验证邮件后再填写。',
                                ),
                              }}
                            />
                          ) : (
                            <InlineNote note={registerNote} />
                          )}
                          <div className="code-row">
                            <label className="field-label">
                              {t('邮件验证码')}
                              <input
                                className="input"
                                value={code}
                                onChange={(e) => setCode(e.target.value)}
                                autoComplete="off"
                                spellCheck={false}
                                placeholder={t('粘贴邮件中的完整验证码')}
                                disabled={codeStale}
                                autoFocus
                                required
                              />
                            </label>
                            <button
                              className="btn btn--primary"
                              type="submit"
                              disabled={busy || !code || codeStale}
                            >
                              {t('确认邮箱')}
                            </button>
                          </div>
                          <p className="section-hint">
                            {t(
                              '验证码是邮件中的一长串字符，请完整粘贴，15 分钟内有效。',
                            )}
                          </p>
                        </form>
                      )}
                    </div>
                  )}
                </>
              )}

              {token && (
                <div className="account-bar">
                  <h2 className="section-title" id="auth-title">
                    {displayName}
                  </h2>
                  <button
                    className="btn btn--danger"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await request('/authserver/invalidate', {
                          accessToken: token,
                        });
                        setToken('');
                        notify(t('已退出'), 'success');
                      })
                    }
                  >
                    {t('退出登录')}
                  </button>
                </div>
              )}
            </section>
          )}

          {token && view === 'notifications' && (
            <Notifications token={token} onRead={refreshNotices} />
          )}
          {token && siteAdmin && view === 'admin' && (
            <AdminPanel token={token} />
          )}
          {(view === 'wardrobe' || view === 'library') && (
            <WardrobePanel
              key={view}
              initialState={view === 'library' ? libraryState : undefined}
              onStateChange={view === 'library' ? setLibraryState : undefined}
              token={token || undefined}
              library={view === 'library'}
              notify={notify}
              onRequireLogin={() => goto('login')}
              onBrowseUpload={() => goto('textures')}
            />
          )}

          {token && view === 'textures' && (
            <TexturesPanel token={token} notify={notify} />
          )}

          {token && view === 'community' && muaEnabled && (
            <MuaAccountCard token={token} notify={notify} />
          )}

          {token && view === 'account' && (
            <>
              <PasskeysPanel token={token} notify={notify} />
              <ConnectPanel />
            </>
          )}
          {token && view === 'community' && muaMember && (
            <MuaPanel token={token} notify={notify} />
          )}
        </div>
      )}
      <footer className="site-footer">
        {t('JLUCraft 联邦皮肤站 · 兼容 Yggdrasil 外置登录')}
      </footer>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
