import React,{useEffect,useState} from 'react';
type Kind='skin'|'cape';
type Texture={kind:Kind;hash:string;model:string};
export function TexturesPanel({token,notify}:{token:string;notify:(message:string,kind:'success'|'error')=>void}){
  const [profile,setProfile]=useState(''),[textures,setTextures]=useState<Texture[]>([]),[model,setModel]=useState('default'),[busy,setBusy]=useState(false);
  const headers={Authorization:`Bearer ${token}`};
  async function refresh(){const response=await fetch('/api/me',{headers});if(!response.ok)throw new Error('无法读取角色信息，请重新登录');const value=await response.json();setProfile(value.profileId);setTextures(value.textures??[]);setModel(value.textures?.find((t:Texture)=>t.kind==='skin')?.model??'default');}
  useEffect(()=>{void refresh().catch(e=>notify(String(e),'error'));},[token]);
  async function change(kind:Kind,file?:File){if(!profile)return;setBusy(true);try{
    const form=new FormData();if(file){form.append('model',kind==='skin'?model:'default');form.append('file',file);}
    const response=await fetch(`/api/user/profile/${profile}/${kind}`,{method:file?'PUT':'DELETE',headers,body:file?form:undefined});
    if(!response.ok)throw new Error('材质更新失败，请检查图片格式与尺寸');await refresh();notify(file?'材质已更新':'材质已移除','success');
  }catch(e){notify(String(e),'error');}finally{setBusy(false);}}
  return <section aria-labelledby="textures-title"><div className="section-head"><h2 id="textures-title">角色外观</h2><p className="section-hint">皮肤支持 64×32、64×64 及等比例 PNG；披风支持 64×32 或 22×17 及等比例 PNG。文件不超过 1 MiB。</p></div>
    <div className="texture-grid">{(['skin','cape'] as Kind[]).map(kind=>{const current=textures.find(t=>t.kind===kind);return <div key={kind} className="texture-card"><h3>{kind==='skin'?'皮肤':'披风'}</h3>
      {current?<img className="texture-preview" src={`/textures/${current.hash}`} alt={kind==='skin'?'当前皮肤材质':'当前披风材质'}/>:<p className="section-hint">尚未设置</p>}
      {kind==='skin'&&<label>手臂模型<select value={model} disabled={busy} onChange={e=>setModel(e.target.value)}><option value="default">标准</option><option value="slim">纤细</option></select></label>}
      <div className="actions"><label className="upload-btn">{kind==='skin'?'上传皮肤':'上传披风'}<input type="file" accept="image/png" disabled={busy||!profile} onChange={e=>{const file=e.target.files?.[0];if(file)void change(kind,file);e.target.value='';}}/></label><button className="btn-secondary" disabled={busy||!current} onClick={()=>void change(kind)}>移除</button></div>
    </div>;})}</div></section>;
}
