import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';
import {MuaPanel} from './MuaPanel';
import {TexturesPanel} from './TexturesPanel';

type MsgKind='success'|'error';
type AuthTab='login'|'register';

function App(){
  const [schools,setSchools]=useState<string[]>([]);
  const [resetting,setResetting]=useState(false),[resetSent,setResetSent]=useState(false);
  const [muaEnabled,setMuaEnabled]=useState(false);
  const [muaMember,setMuaMember]=useState(false);
  useEffect(()=>{void fetch('/api/capabilities').then(r=>r.json()).then(c=>{setMuaEnabled(c.muaOAuth===true);setMuaMember(c.muaMember===true);setSchools(c.schools??[]);setSchool(current=>(c.schools??[]).includes(current)?current:(c.schools?.[0]??''));}).catch(()=>{});},[]);
  const [email,setEmail]=useState(''),[name,setName]=useState(''),[school,setSchool]=useState('jlu'),[password,setPassword]=useState(''),[code,setCode]=useState(''),[token,setToken]=useState(''),[message,setMessage]=useState(''),[msgKind,setMsgKind]=useState<MsgKind>('success'),[busy,setBusy]=useState(false);
  const [tab,setTab]=useState<AuthTab>('login'),[codeSent,setCodeSent]=useState(false);
  const notify=(text:string,kind:MsgKind)=>{setMessage(text);setMsgKind(kind);};
  async function request(path:string,body:unknown){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error('请求被拒绝，请检查信息或稍后重试');return r.status===204?null:r.json();}
  async function action(fn:()=>Promise<void>){setBusy(true);try{await fn();}catch(e){notify(String(e),'error');}finally{setBusy(false);}}

  function selectTab(next:AuthTab){setTab(next);document.getElementById(`tab-${next}`)?.focus();}
  function onTabKeyDown(e:React.KeyboardEvent){if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();selectTab(tab==='login'?'register':'login');}else if(e.key==='Home'){e.preventDefault();selectTab('login');}else if(e.key==='End'){e.preventDefault();selectTab('register');}}

  async function sendVerifyEmail(){await request('/api/email/start',{email,password,name,school});setCodeSent(true);notify('验证邮件已发送，15 分钟内有效','success');}
  async function confirmEmail(){await request('/api/email/confirm',{email,code});setCode('');setCodeSent(false);setTab('login');notify('邮箱验证完成，请使用邮箱和密码登录','success');}
  async function login(){const data=await request('/authserver/authenticate',{username:email,password});setToken(data.accessToken);setPassword('');notify(`欢迎，${data.selectedProfile.name}`,'success');}

  return <main>
    <header className="site-header">
      <div className="brand"><span className="brand-mark" aria-hidden="true">JL</span><span className="brand-name">JLUCraft / Federation</span></div>
      <h1>一个身份，连接高校社区。</h1>
      <p className="tagline">管理游戏账号与皮肤，加入你的高校社区。</p>
    </header>

    <section aria-labelledby="auth-title">
      <div className="section-head">
        <h2 id="auth-title">{token?'账号已登录':'登录或注册'}</h2>
        {!token&&<p className="section-hint">已验证学校邮箱的账号可直接登录；新账号请在「注册新账号」标签中完成邮箱验证。</p>}
      </div>

      {!token&&<>
        <div className="tabs" role="tablist" aria-label="登录或注册" onKeyDown={onTabKeyDown}>
          <button type="button" role="tab" id="tab-login" tabIndex={tab==='login'?0:-1} aria-selected={tab==='login'} aria-controls="panel-login" onClick={()=>setTab('login')}>登录</button>
          <button type="button" role="tab" id="tab-register" tabIndex={tab==='register'?0:-1} aria-selected={tab==='register'} aria-controls="panel-register" onClick={()=>setTab('register')}>注册新账号</button>
        </div>

        {tab==='login'&&!resetting&&<div role="tabpanel" id="panel-login" aria-labelledby="tab-login" className="tab-panel">
          <form onSubmit={e=>{e.preventDefault();void action(login);}}>
            <div className="field-grid">
              <label>学校邮箱<input type="email" autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} required/></label>
              <label>密码<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} minLength={12} required/></label>
            </div>
            <div className="actions"><button disabled={busy} type="submit">登录</button></div>
          </form>
          <button type="button" className="link" disabled={busy} onClick={()=>{setResetting(true);setCode('');setPassword('');}}>忘记密码</button>
          <p className="switch-hint">还没有账号？<button type="button" className="link" onClick={()=>selectTab('register')}>前往注册新账号</button></p>
        </div>}

        {tab==='login'&&resetting&&<div className="tab-panel" role="tabpanel" id="panel-login" aria-labelledby="tab-login">
          <h3>重置密码</h3>
          <form onSubmit={e=>{e.preventDefault();void action(async()=>{
            if(!resetSent){await request('/api/password/start',{email});setResetSent(true);notify('若该邮箱已注册，你将收到重置密码邮件','success');}
            else {await request('/api/password/confirm',{email,code,password});setResetting(false);setResetSent(false);setCode('');setPassword('');notify('密码已更新，请重新登录','success');}
          });}}>
            <div className="field-grid">
              <label>学校邮箱<input type="email" autoComplete="username" value={email} disabled={busy||resetSent} onChange={e=>setEmail(e.target.value)} required/></label>
              {resetSent&&<><label>邮件验证码<input value={code} onChange={e=>setCode(e.target.value)} autoComplete="off" required/></label><label>新密码<input type="password" autoComplete="new-password" minLength={12} value={password} onChange={e=>setPassword(e.target.value)} required/></label></>}
            </div>
            <div className="actions"><button type="submit" disabled={busy}>{resetSent?'更新密码':'发送重置邮件'}</button><button type="button" className="btn-secondary" disabled={busy} onClick={()=>{setResetting(false);setResetSent(false);setCode('');}}>返回登录</button></div>
          </form>
        </div>}
        {tab==='register'&&<div role="tabpanel" id="panel-register" aria-labelledby="tab-register" className="tab-panel">
          <form onSubmit={e=>{e.preventDefault();void action(sendVerifyEmail);}}>
            <div className="field-grid">
              <label>学校<select aria-label="学校" value={school} onChange={e=>setSchool(e.target.value)} required>{schools.map(id=><option key={id} value={id}>{id.toUpperCase()}</option>)}</select></label>
              <label>学校邮箱<input type="email" autoComplete="username" value={email} onChange={e=>{setEmail(e.target.value);setCodeSent(false);}} required/></label>
              <label>游戏名称<input value={name} onChange={e=>setName(e.target.value)} maxLength={16}/></label>
              <label>设置密码<input type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} minLength={12} required/></label>
            </div>
            <div className="actions"><button disabled={busy} type="submit">发送验证邮件</button></div>
          </form>
          {codeSent&&<div className="verify-step">
            <div className="code-row">
              <label>邮件验证码<input value={code} onChange={e=>setCode(e.target.value)} autoComplete="off" spellCheck={false} placeholder="粘贴邮件中的完整验证码"/></label>
              <button type="button" disabled={busy||!code} onClick={()=>void action(confirmEmail)}>确认邮箱</button>
            </div>
            <p className="section-hint">验证码是邮件中的一长串字符，请完整粘贴，15 分钟内有效。</p>
          </div>}
        </div>}
      </>}

      {token&&<p className="logged-in">当前已登录，可在下方管理皮肤与跨校身份。</p>}
    </section>

    {token&&<><TexturesPanel token={token} notify={notify}/><div className="actions"><button className="btn-secondary" disabled={busy} onClick={()=>void action(async()=>{await request('/authserver/invalidate',{accessToken:token});setToken('');notify('已退出','success');})}>退出登录</button></div></>}

    {token&&muaEnabled&&<section aria-labelledby="mua-title">
      <div className="section-head">
        <h2 id="mua-title">MUA 账号</h2>
        <p className="section-hint">连接跨校社区，管理你的 MUA 账号关联。</p>
      </div>
      <div className="actions">
        <button disabled={busy} onClick={()=>void action(async()=>{const r=await fetch('/api/mua/link',{method:'POST',headers:{Authorization:`Bearer ${token}`}});if(!r.ok)throw new Error('暂时无法关联 MUA');const data=await r.json();window.location.assign(data.url);})}>关联 MUA 账号</button>
        <button className="btn-secondary" disabled={busy} onClick={()=>void action(async()=>{const r=await fetch('/api/mua/link',{method:'DELETE',headers:{Authorization:`Bearer ${token}`}});if(!r.ok)throw new Error('解除关联失败');notify('已解除 MUA 关联','success');})}>解除关联</button>
      </div>
    </section>}

    {token&&muaMember&&<MuaPanel token={token} notify={notify}/>}

    <p className={`msg msg-${msgKind}`} role="status" aria-live="polite">{message}</p>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
