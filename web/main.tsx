import { t } from './i18n';
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { MuaPanel } from './MuaPanel';
import { TexturesPanel } from './TexturesPanel';
import { WardrobePanel } from './WardrobePanel';
import { PasskeysPanel, loginWithPasskey } from './PasskeysPanel';
import { ConnectPanel } from './ConnectPanel';
import { DevicePanel } from './DevicePanel';
import { ApiError, apiRequest, errorText } from './api';

type MsgKind = 'success' | 'error';
type AuthTab = 'login' | 'register' | 'reset';

const TAB_LABELS: Record<AuthTab, string> = {
  login: t('登录'),
  register: t('注册新账号'),
  reset: t('重置密码'),
};

const MSG_CLASS: Record<MsgKind, string> = {
  success: 'msg msg--success',
  error: 'msg msg--error',
};

function App() {
  const [schools, setSchools] = useState<string[]>([]);
  const [capsLoading, setCapsLoading] = useState(true);
  const [page, setPage] = useState<
    'textures' | 'wardrobe' | 'library' | 'account' | 'community'
  >('textures');
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
        const list: string[] = c.schools ?? [];
        setSchools(list);
        setSchool((current) =>
          list.includes(current) ? current : (list[0] ?? ''),
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
  const notify = (text: string, kind: MsgKind) => {
    setMessage(text);
    setMsgKind(kind);
  };

  async function request(path: string, body: unknown) {
    return apiRequest(path, {
      method: 'POST',
      body,
      errorMessage: t('请求被拒绝，请检查信息或稍后重试'),
    });
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
    selectTab('reset');
  }
  function leaveReset(next: AuthTab) {
    setCode('');
    setPassword('');
    selectTab(next);
  }

  function changeRegistration(update: () => void) {
    update();
    setCode('');
    setCodeSent(false);
    setMessage('');
  }

  async function sendVerifyEmail() {
    await request('/api/email/start', { email, password, name, school });
    setCodeSent(true);
    notify(t('验证邮件已发送，15 分钟内有效'), 'success');
  }
  async function confirmEmail() {
    await request('/api/email/confirm', { email, code });
    setCode('');
    setCodeSent(false);
    setTab('login');
    notify(t('邮箱验证完成，请使用邮箱和密码登录'), 'success');
  }
  async function login() {
    const data = await request('/authserver/authenticate', {
      username: email,
      password,
    });
    setToken(data.accessToken);
    setDisplayName((data.selectedProfile ?? data.availableProfiles[0]).name);
    setPassword('');
    notify(t('登录成功'), 'success');
  }

  const tabs: AuthTab[] =
    tab === 'reset' ? ['login', 'register', 'reset'] : ['login', 'register'];

  return (
    <main className="app-main">
      <header className="site-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            JL
          </span>
          <span className="brand-name">JLUCraft</span>
        </div>
        <h1 className="site-title">{t('皮肤站')}</h1>
      </header>

      {message && (
        <p
          className={MSG_CLASS[msgKind]}
          role={msgKind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {message}
        </p>
      )}

      <div className={token ? 'portal-workspace' : undefined}>
        {token && (
          <nav className="portal-navigation" aria-label={t('皮肤站导航')}>
            {(
              [
                ['textures', t('角色外观')],
                ['wardrobe', t('衣柜')],
                ['library', t('皮肤库')],
                ['account', t('账号安全')],
                ['community', t('高校社区')],
              ] as const
            ).map(
              ([key, label]) =>
                (key !== 'community' || muaEnabled || muaMember) && (
                  <button
                    className={`btn portal-navigation-item${page === key ? ' portal-navigation-item--active' : ''}`}
                    key={key}
                    aria-current={page === key ? 'page' : undefined}
                    onClick={() => {
                      setPage(key);
                      setMessage('');
                    }}
                  >
                    {label}
                  </button>
                ),
            )}
          </nav>
        )}

        <div className="portal-content">
          {!token && deviceCode && (
            <section
              className="panel panel--narrow"
              aria-labelledby="device-wait-title"
            >
              <h2 className="section-title" id="device-wait-title">
                {t('启动器正在等待授权')}
              </h2>
              <p className="section-hint">
                {t('请先登录（没有账号请先注册），完成后会回到这里确认授权码：')}
              </p>
              <p className="device-code">{deviceCode}</p>
            </section>
          )}
          {token && deviceCode && (
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
          {(!token || page === 'account') && (
            <section
              className="panel"
              aria-labelledby="auth-title"
              aria-busy={capsLoading}
            >
              <div className="section-head">
                <h2 className="section-title" id="auth-title">
                  {token ? displayName : t('登录')}
                </h2>
              </div>
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
                        className={`btn tab${tab === id ? ' tab--active' : ''}`}
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
                        <div className="field-grid">
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
                              notify(
                                t('若该邮箱已注册，你将收到重置密码邮件'),
                                'success',
                              );
                            } else {
                              await request('/api/password/confirm', {
                                email,
                                code,
                                password,
                              });
                              leaveReset('login');
                              notify(t('密码已更新，请重新登录'), 'success');
                            }
                          });
                        }}
                      >
                        <div className="field-grid">
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
                              <label className="field-label">
                                {t('邮件验证码')}
                                <input
                                  className="input"
                                  value={code}
                                  onChange={(e) => setCode(e.target.value)}
                                  autoComplete="off"
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
                              {schools.map((id) => (
                                <option key={id} value={id}>
                                  {id.toUpperCase()}
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
                            />
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
                            className="btn btn--primary"
                            disabled={busy}
                            type="submit"
                          >
                            {t('发送验证邮件')}
                          </button>
                        </div>
                      </form>
                      {codeSent && (
                        <div className="verify-step">
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
                              />
                            </label>
                            <button
                              className="btn btn--primary"
                              type="button"
                              disabled={busy || !code}
                              onClick={() => void action(confirmEmail)}
                            >
                              {t('确认邮箱')}
                            </button>
                          </div>
                          <p className="section-hint">
                            {t(
                              '验证码是邮件中的一长串字符，请完整粘贴，15 分钟内有效。',
                            )}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {token && (
                <>
                  <div className="actions">
                    <button
                      className="btn btn--secondary"
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
                </>
              )}
            </section>
          )}

          {token && (page === 'wardrobe' || page === 'library') && (
            <WardrobePanel
              key={page}
              token={token}
              library={page === 'library'}
              notify={notify}
            />
          )}

          {token && page === 'textures' && (
            <TexturesPanel token={token} notify={notify} />
          )}

          {token && page === 'community' && muaEnabled && (
            <section className="panel" aria-labelledby="mua-title">
              <div className="section-head">
                <h2 className="section-title" id="mua-title">
                  {t('MUA 账号')}
                </h2>
                <p className="section-hint">
                  {t('连接跨校社区，管理你的 MUA 账号关联。')}
                </p>
              </div>
              <div className="actions">
                <button
                  className="btn btn--primary"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const r = await fetch('/api/mua/link', {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token}` },
                      });
                      if (!r.ok) throw new Error(t('暂时无法关联 MUA'));
                      const data = await r.json();
                      window.location.assign(data.url);
                    })
                  }
                >
                  {t('关联 MUA 账号')}
                </button>
                <button
                  className="btn btn--secondary"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const r = await fetch('/api/mua/link', {
                        method: 'DELETE',
                        headers: { Authorization: `Bearer ${token}` },
                      });
                      if (!r.ok) throw new Error(t('解除关联失败'));
                      notify(t('已解除 MUA 关联'), 'success');
                    })
                  }
                >
                  {t('解除关联')}
                </button>
              </div>
            </section>
          )}

          {token && page === 'account' && (
            <>
              <PasskeysPanel token={token} notify={notify} />
              <ConnectPanel />
            </>
          )}
          {token && page === 'community' && muaMember && (
            <MuaPanel token={token} notify={notify} />
          )}
        </div>
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
