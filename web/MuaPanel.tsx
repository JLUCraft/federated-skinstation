import React,{useEffect,useState} from 'react';

type BlacklistEntry={id:number;email:string;reason:string;source:string;valid_until:string|null};
export function MuaPanel({token,notify}:{token:string;notify:(text:string,kind:'success'|'error')=>void}){
 const [ticket,setTicket]=useState(()=>new URLSearchParams(location.hash.slice(1)).get('mua-grant')??'');
 const [admin,setAdmin]=useState(false),[busy,setBusy]=useState(false),[binding,setBinding]=useState(''),[target,setTarget]=useState('');
 const [generated,setGenerated]=useState(''),[uuid,setUuid]=useState(''),[page,setPage]=useState(1),[entries,setEntries]=useState<BlacklistEntry[]>([]);
 const [query,setQuery]=useState(''),[email,setEmail]=useState(''),[reason,setReason]=useState('');
 async function api(path:string,method='GET',body?:unknown){
  const response=await fetch(path,{method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw new Error('操作未完成，请检查信息或稍后重试');
  return response.status===204?{}:response.json();
 }
 async function action(fn:()=>Promise<void>){setBusy(true);try{await fn();}catch{notify('操作未完成，请检查信息或稍后重试','error');}finally{setBusy(false);}}
 useEffect(()=>{let live=true;void api('/api/me').then(a=>{if(live){setAdmin(a.muaAdmin===true);setUuid(a.profileId);}}).catch(()=>{});return()=>{live=false;};},[token]);
 const load=async()=>{const result=await api(`/api/mua/admin/blacklist?page=${page}${query?'&q='+encodeURIComponent(query):''}`);setEntries(Array.isArray(result.data)?result.data:Object.values(result.data??{}));};
 return <>
  {ticket&&<section aria-labelledby="mua-consent"><div className="section-head"><h2 id="mua-consent">授权 MUA 登录</h2><p className="section-hint">继续后，你的昵称和注册邮箱将提供给 MUA，用于完成此次登录。</p></div><div className="actions"><button disabled={busy} onClick={()=>void action(async()=>{const r=await api('/api/mua/authorize','POST',{ticket,consent:true});location.assign(r.url);})}>同意并继续</button><button className="btn-secondary" disabled={busy} onClick={()=>{setTicket('');history.replaceState(null,'',location.pathname);}}>取消</button></div></section>}
  <section aria-labelledby="mua-bind-title"><div className="section-head"><h2 id="mua-bind-title">跨校角色绑定</h2><p className="section-hint">仅绑定你本人持有的角色。绑定码用于在另一所学校的皮肤站确认关联，请勿交给他人。</p></div><p className="entry-meta">当前角色：{uuid}</p>
   <div className="actions"><button disabled={busy} onClick={()=>void action(async()=>{const r=await api('/api/mua/profiles/bind','POST',{});setGenerated(String(r.token??''));})}>生成绑定码</button><button className="btn-secondary" disabled={busy} onClick={()=>void action(async()=>{await api('/api/mua/profiles/unbind','POST',{});notify('角色绑定已解除','success');})}>解除角色绑定</button></div>
   {generated&&<label>本次绑定码<input className="bind-code" readOnly value={generated}/></label>}
   <div className="subsection"><h3 className="subsection-title">绑定另一角色</h3>
    <form onSubmit={e=>{e.preventDefault();void action(async()=>{await api('/api/mua/profiles/bindto','POST',{token:binding});setBinding('');notify('角色绑定已更新','success');});}}><label>另一角色的绑定码<input value={binding} onChange={e=>setBinding(e.target.value)} autoComplete="off" required/></label><div className="actions"><button disabled={busy} type="submit">绑定角色</button></div></form></div>
   <details><summary>统一游戏角色 UUID</summary><p className="section-hint">先完成角色绑定，再指定要使用的 UUID。变更会影响游戏存档身份，并要求重新登录。</p><form onSubmit={e=>{e.preventDefault();void action(async()=>{await api('/api/mua/profiles/remapuuid','POST',{target});notify('UUID 变更请求已提交，请重新登录','success');});}}><label>目标 UUID<input value={target} onChange={e=>setTarget(e.target.value)} pattern="[a-f0-9]{32}" required/></label><div className="actions"><button disabled={busy} type="submit">提交 UUID 变更</button></div></form></details>
  </section>
  {admin&&<section aria-labelledby="mua-admin-title"><div className="section-head"><h2 id="mua-admin-title">联合黑名单</h2></div>
   <form onSubmit={e=>{e.preventDefault();void action(load);}}><div className="field-grid"><label>搜索<input value={query} onChange={e=>setQuery(e.target.value)}/></label><label>页码<input type="number" min={1} max={100000} value={page} onChange={e=>setPage(Number(e.target.value))}/></label></div><div className="actions"><button disabled={busy} type="submit">查询</button></div></form>
   {!entries.length&&<p className="empty-note">暂无黑名单记录</p>}
   {entries.map(entry=><article className="entry-card" key={entry.id}><p className="entry-meta">{entry.email} · 来源：{entry.source}</p><p>{entry.reason}</p><p><span className="status-pill">{entry.valid_until??'长期有效'}</span></p><div className="actions">{(['invalidate','delete'] as const).map(op=><button className="btn-secondary" disabled={busy} key={op} onClick={()=>void action(async()=>{if(!confirm(op==='delete'?'确认删除这条记录？':'确认使这条记录失效？'))return;await api(`/api/mua/admin/blacklist/${entry.id}/${op}`,'POST',{});await load();})}>{op==='delete'?'删除':'设为失效'}</button>)}</div></article>)}
   <div className="subsection"><h3 className="subsection-title">添加记录</h3><form onSubmit={e=>{e.preventDefault();void action(async()=>{await api('/api/mua/admin/blacklist','POST',{email,reason});setReason('');await load();notify('记录已提交','success');});}}><div className="field-grid"><label>邮箱<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required/></label><label>原因<input value={reason} onChange={e=>setReason(e.target.value)} maxLength={4096} required/></label></div><div className="actions"><button disabled={busy} type="submit">提交记录</button><button disabled={busy} type="button" className="btn-secondary" onClick={()=>void action(async()=>{await api('/api/mua/admin/synchronize','POST',{});notify('角色同步已安排','success');})}>重新同步角色</button></div></form></div>
  </section>}
 </>;
}
