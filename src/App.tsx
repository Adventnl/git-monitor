import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, BackgroundVariant, Controls, Handle, Position, applyNodeChanges, type Edge, type Node, type NodeChange, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as chooseFolder } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Folder, GitBranch, Github, MoreHorizontal, Plus, RefreshCw, Settings2, Search, X, Minus, Maximize2, ChevronDown, GitPullRequest, ArrowUp, ArrowDown, Check, FileText, GitCommitHorizontal, History, PanelRightClose } from 'lucide-react';

type FileChange = { path:string; status:string; staged:boolean; unstaged:boolean };
type Repo = { path:string; name:string; branch:string; kind:string; files:FileChange[]; ahead:number; behind:number; upstream:string|null; remote:string|null; error:string|null };
type Settings = { roots:string[]; layout:string; positions:Record<string,[number,number]>; viewport:[number,number,number]; maxDepth:number; grid:boolean; autoMonitor:boolean; appearance:string };
type OpResult = { path:string; status:string; detail:string; committed:boolean; pushed:boolean };
type TransferPreview = { scenario:string; files:string[]; commits:string[]; conflictFiles:string[]; warning:string };
type DeviceCode = { deviceCode:string; userCode:string; verificationUri:string; expiresIn:number; interval:number };
type NodeData = Record<string, unknown> & { title:string; subtitle:string; count?:number; root?:boolean; dirty?:boolean; ahead?:number; behind?:number; error?:string; kind?:string };
const initialSettings:Settings = { roots:[],layout:'horizontal',positions:{},viewport:[0,0,1],maxDepth:32,grid:true,autoMonitor:true,appearance:'light' };
const errText = (e:unknown) => typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
const nameOf = (path:string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
const plural = (n:number, word:string) => `${n} ${n===1?word:word==='repository'?'repositories':`${word}s`}`;
const api = <T,>(command:string,args?:Record<string,unknown>) => invoke<T>(command,args);

function CanvasNode({data}:NodeProps<Node<NodeData>>) {
  return <div className={`canvas-node ${data.root?'root-node':'repo-node'} ${data.error?'node-error':''}`}>
    <Handle type="target" position={Position.Left} className="node-handle" />
    <div className="node-icon">{data.root?<Folder size={18}/>:<Github size={17}/>}</div>
    <div className="node-copy"><strong title={data.title}>{data.title}</strong><span>{data.root?data.subtitle:<><GitBranch size={10}/>{data.subtitle}</>}</span>
      {!data.root&&<small className={data.error?'status-error':data.dirty?'status-dirty':'status-clean'}><i/>{data.error?'Unavailable':data.dirty?`${data.count} ${data.count===1?'file':'files'} changed`:'Clean'}{!data.dirty&&data.behind ? ` · ↓${data.behind}`:''}{!data.dirty&&data.ahead ? ` · ↑${data.ahead}`:''}</small>}
    </div>
    <MoreHorizontal size={14} className="node-more"/>
    <Handle type="source" position={Position.Right} className="node-handle" />
  </div>;
}
const nodeTypes = { canvas: CanvasNode };

export default function App() {
  const [settings,setSettings]=useState<Settings>(initialSettings);
  const [repos,setRepos]=useState<Repo[]>([]);
  const [nodes,setNodes]=useState<Node<NodeData>[]>([]);
  const [selected,setSelected]=useState<string|null>(null);
  const [selectedPaths,setSelectedPaths]=useState<string[]>([]);
  const [selectedRoot,setSelectedRoot]=useState<string|null>(null);
  const [menu,setMenu]=useState(false);
  const [modal,setModal]=useState<'bulk'|'settings'|'transfer'|'pr'|null>(null);
  const [bulkAction,setBulkAction]=useState<'commit_push'|'fetch'|'pull'>('commit_push');
  const [toast,setToast]=useState<string|null>(null);
  const [loading,setLoading]=useState(false);
  const [search,setSearch]=useState('');
  const [searchOpen,setSearchOpen]=useState(false);
  const [progress,setProgress]=useState<{index:number;total:number}|null>(null);
  const [results,setResults]=useState<OpResult[]|null>(null);
  const flow=useRef<ReactFlowInstance<Node<NodeData>,Edge>|null>(null);
  const settingsRef=useRef(settings); settingsRef.current=settings;
  const reposRef=useRef(repos); reposRef.current=repos;
  const notify=(message:string)=>{setToast(message);window.setTimeout(()=>setToast(null),6500)};
  const saveSettings=async (next:Settings)=>{setSettings(next);settingsRef.current=next;try{await api('update_settings',{settings:next})}catch(e){notify(errText(e))}};
  const refreshRepo=useCallback(async (path:string)=>{try{const r=await api<Repo>('inspect_repo',{path});setRepos(prev=>prev.map(item=>item.path===path?r:item))}catch(e){setRepos(prev=>prev.map(item=>item.path===path?{...item,error:errText(e)}:item))}},[]);
  const refreshAll=useCallback(async (roots?:string[])=>{
    const paths=roots||settingsRef.current.roots;
    setLoading(true);
    const found=await Promise.all(paths.map(async path=>{try{return await api<Repo[]>('scan_root',{path,maxDepth:settingsRef.current.maxDepth})}catch(e){notify(`${nameOf(path)}: ${errText(e)}`);return []}}));
    setRepos(found.flat());setLoading(false);
    if(!Object.keys(settingsRef.current.positions).length)window.setTimeout(()=>flow.current?.fitView({padding:0.25,maxZoom:1,duration:250}),140);
  },[]);
  useEffect(()=>{api<Settings>('get_settings').then(s=>{setSettings(s);settingsRef.current=s;refreshAll(s.roots);if(s.viewport[2]>0)window.setTimeout(()=>flow.current?.setViewport({x:s.viewport[0],y:s.viewport[1],zoom:s.viewport[2]}),250)}).catch(e=>notify(errText(e)))},[refreshAll]);
  useEffect(()=>{let a:(()=>void)|undefined,b:(()=>void)|undefined;let timer:number|undefined;const pending=new Set<string>();
    listen<string>('git-changed',e=>{pending.add(e.payload);window.clearTimeout(timer);timer=window.setTimeout(()=>{const changed=[...pending];pending.clear();const paths=new Set<string>();let rescan=false;for(const path of changed){const found=reposRef.current.filter(r=>path===r.path||path.startsWith(r.path+'/')||path.startsWith(r.path+'\\'));if(found.length)found.forEach(r=>paths.add(r.path));else rescan=true}if(rescan)refreshAll();else paths.forEach(refreshRepo)},500)}).then(fn=>a=fn);
    listen<{index:number;total:number}>('bulk-progress',e=>setProgress({index:e.payload.index,total:e.payload.total})).then(fn=>b=fn);
    return()=>{a?.();b?.();window.clearTimeout(timer)};
  },[refreshRepo,refreshAll]);
  const addFolder=async()=>{try{const path=await chooseFolder({directory:true,multiple:false,title:'Choose a folder to monitor'});if(typeof path!=='string')return;const s=await api<Settings>('add_root',{path});setSettings(s);settingsRef.current=s;await refreshAll(s.roots)}catch(e){notify(errText(e))}};
  const removeFolder=async(path:string)=>{try{const s=await api<Settings>('remove_root',{path});setSettings(s);settingsRef.current=s;setSelectedRoot(null);await refreshAll(s.roots)}catch(e){notify(errText(e))}};
  const autoLayout=useCallback((layout=settingsRef.current.layout, currentRepos=reposRef.current, roots=settingsRef.current.roots)=>{
    const positions:Record<string,[number,number]>={};
    roots.forEach((root,ri)=>{
      const group=currentRepos.filter(r=>r.path===root||r.path.startsWith(root+'/')||r.path.startsWith(root+'\\'));
      const centerY=ri* Math.max(460,Math.ceil(group.length/5)*410);
      positions[`root:${root}`]=[layout==='radial'?420:360,centerY+Math.max(0,group.length-1)*38];
      group.forEach((repo,i)=>{
        if(layout==='radial') {const angle=(i/group.length)*Math.PI*2;positions[repo.path]=[650+Math.cos(angle)*300,centerY+220+Math.sin(angle)*190]}
        else if(layout==='tree') {positions[repo.path]=[620+(i%3)*215,centerY+Math.floor(i/3)*94]}
        else {const col=Math.floor(i/8),row=i%8;positions[repo.path]=[650+col*240,centerY+row*92]}
      });
    });
    saveSettings({...settingsRef.current,layout,positions});
    window.setTimeout(()=>flow.current?.fitView({padding:0.2,duration:350,maxZoom:1}),120);
  },[]);
  useEffect(()=>{
    const s=settingsRef.current;
    const generated:Node<NodeData>[]=[];
    s.roots.forEach((root,ri)=>{
      const group=repos.filter(r=>r.path===root||r.path.startsWith(root+'/')||r.path.startsWith(root+'\\'));
      const rootKey=`root:${root}`;
      const rootPos=s.positions[rootKey]||[360,ri*500+Math.max(0,group.length-1)*38];
      generated.push({id:rootKey,type:'canvas',position:{x:rootPos[0],y:rootPos[1]},data:{title:nameOf(root),subtitle:plural(group.length,'repository'),root:true},selected:selectedRoot===root});
      group.forEach((repo,i)=>{const pos=s.positions[repo.path]||[650+Math.floor(i/8)*240,ri*500+(i%8)*92];generated.push({id:repo.path,type:'canvas',position:{x:pos[0],y:pos[1]},data:{title:repo.name,subtitle:repo.branch,count:repo.files.length,dirty:repo.files.length>0,ahead:repo.ahead,behind:repo.behind,error:repo.error||undefined,kind:repo.kind},selected:selected===repo.path||selectedPaths.includes(repo.path)})});
    });
    setNodes(generated);
  },[repos,settings.roots,settings.positions,selected,selectedRoot,selectedPaths]);
  const edges=useMemo<Edge[]>(()=>settings.roots.flatMap(root=>repos.filter(r=>r.path===root||r.path.startsWith(root+'/')||r.path.startsWith(root+'\\')).map(r=>({id:`${root}-${r.path}`,source:`root:${root}`,target:r.path,type:'default',style:{stroke:'#8bb5fa',strokeWidth:1.25},animated:false}))),[repos,settings.roots]);
  const onNodesChange=(changes:NodeChange<Node<NodeData>>[])=>setNodes(prev=>applyNodeChanges(changes,prev));
  const persistPositions=()=>{const positions={...settingsRef.current.positions};nodes.forEach(n=>positions[n.id]=[n.position.x,n.position.y]);saveSettings({...settingsRef.current,positions})};
  const activeRepo=repos.find(r=>r.path===selected)||null;
  const rootRepos=selectedRoot?repos.filter(r=>r.path===selectedRoot||r.path.startsWith(selectedRoot+'/')||r.path.startsWith(selectedRoot+'\\')):repos;
  const scopedRepos=selectedPaths.length?rootRepos.filter(r=>selectedPaths.includes(r.path)):rootRepos;
  const launchBulk=(action:'commit_push'|'fetch'|'pull')=>{setBulkAction(action);setResults(null);setProgress(null);setModal('bulk');setMenu(false)};
  useEffect(()=>{const onKey=(e:KeyboardEvent)=>{const mod=e.metaKey||e.ctrlKey;if(e.key==='Escape'){setModal(null);setSelected(null);setSelectedRoot(null);setMenu(false);setSearchOpen(false)}if(mod&&e.key.toLowerCase()==='o'){e.preventDefault();addFolder()}if(mod&&e.key.toLowerCase()==='r'){e.preventDefault();refreshAll()}if(mod&&e.key.toLowerCase()==='f'){e.preventDefault();setSearchOpen(true)}if(mod&&(e.key==='+'||e.key==='=')){e.preventDefault();flow.current?.zoomIn()}if(mod&&e.key==='-'){e.preventDefault();flow.current?.zoomOut()}};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey)},[refreshAll]);
  useEffect(()=>{let unlisten:(()=>void)|undefined;getCurrentWindow().onDragDropEvent(async event=>{
    if(event.payload.type!=='drop')return;
    for(const path of event.payload.paths){try{const s=await api<Settings>('add_root',{path});setSettings(s);settingsRef.current=s}catch(e){notify(`${nameOf(path)}: ${errText(e)}`)}}
    refreshAll();
  }).then(fn=>unlisten=fn);return()=>unlisten?.()},[refreshAll]);
  return <main className={`app theme-${settings.appearance} ${navigator.userAgent.includes('Mac')?'mac':''}`}>
    <header className="titlebar" data-tauri-drag-region><div className="brand" data-tauri-drag-region><span className="brand-mark"><GitBranch size={13}/></span><span data-tauri-drag-region>git-monitor</span></div><button className="icon-button search-button" aria-label="Search repositories" onClick={()=>setSearchOpen(true)}><Search size={15}/></button><div className="titlebar-spacer" data-tauri-drag-region/></header>
    <aside className="rail"><button className="rail-button active" aria-label="Canvas" onClick={()=>{setSelected(null);setSelectedRoot(null)}}><span className="rail-canvas"/></button><button className="rail-button" aria-label="Add folder" onClick={addFolder}><Plus size={19}/></button><span className="rail-spacer"/><button className="rail-button" aria-label="Settings" onClick={()=>setModal('settings')}><Settings2 size={17}/></button></aside>
    {settings.roots.length===0?<section className="first-run"><div className="first-run-icon"><Folder size={23}/></div><h1>Your repositories, in view.</h1><p>Choose a folder and git-monitor will find its Git repositories.</p><button className="primary-button" onClick={addFolder}><Plus size={15}/> Add Folder</button></section>:<>
      <div className="breadcrumb"><Folder size={14}/><button onClick={()=>setSelectedRoot(settings.roots[0])}>{settings.roots.length===1?nameOf(settings.roots[0]):`${settings.roots.length} folders`}</button><button className="crumb-add" aria-label="Add folder" onClick={addFolder}><Plus size={14}/></button></div>
      <div className="top-actions">{selectedPaths.length>0&&<span className="selection-count">{plural(selectedPaths.length,'selected')}</span>}<button className="round-action" aria-label="Refresh all" title="Refresh all" onClick={()=>refreshAll()}><RefreshCw size={15} className={loading?'spin':''}/></button><button className="commit-all" onClick={()=>launchBulk('commit_push')}><ArrowUp size={15}/> {selectedPaths.length?'Commit & Push Selected':'Commit & Push All'}</button><div className="menu-wrap"><button className="round-action" aria-label="More actions" onClick={()=>setMenu(!menu)}><MoreHorizontal size={19}/></button>{menu&&<div className="action-menu">
        <button onClick={()=>launchBulk('commit_push')}>Commit & Push {selectedPaths.length?'Selected':'All'}</button><button onClick={()=>launchBulk('fetch')}>Fetch {selectedPaths.length?'Selected':'All'}</button><button onClick={()=>launchBulk('pull')}>Pull {selectedPaths.length?'Selected':'All'}</button><hr/><button onClick={()=>{setSelectedPaths(repos.map(r=>r.path));setMenu(false)}}>Select all</button><button onClick={()=>{setSelectedPaths(repos.filter(r=>r.files.length).map(r=>r.path));setMenu(false)}}>Select changed</button><button onClick={()=>{setSelectedPaths([]);setMenu(false)}}>Deselect all</button><hr/><button onClick={()=>{refreshAll();setMenu(false)}}>Refresh All</button><button onClick={()=>{autoLayout();setMenu(false)}}>Auto Layout</button><button onClick={()=>{flow.current?.fitView({padding:0.2,duration:300});setMenu(false)}}>Fit Canvas</button><hr/><button onClick={()=>{setModal('settings');setMenu(false)}}>Settings</button>
      </div>}</div></div>
      <div className="flow-wrap"><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={i=>{flow.current=i; if(settingsRef.current.viewport[2]===1) i.fitView({padding:0.3,maxZoom:1})}} onNodesChange={onNodesChange} onNodeDragStop={persistPositions} onSelectionChange={({nodes:chosen})=>{const next=chosen.filter(n=>!n.id.startsWith('root:')).map(n=>n.id);setSelectedPaths(old=>old.join('|')===next.join('|')?old:next)}} onNodeClick={(_,n)=>{if(n.id.startsWith('root:')){setSelectedRoot(n.id.slice(5));setSelected(null)}else{setSelected(n.id);setSelectedRoot(null)}}} onPaneClick={()=>{setSelected(null);setSelectedRoot(null);setSelectedPaths([])}} onMoveEnd={(_,v)=>{const old=settingsRef.current;if(Math.abs(old.viewport[0]-v.x)>1||Math.abs(old.viewport[1]-v.y)>1||Math.abs(old.viewport[2]-v.zoom)>.01)saveSettings({...old,viewport:[v.x,v.y,v.zoom]})}} fitView proOptions={{hideAttribution:true}} minZoom={0.25} maxZoom={1.6} selectionOnDrag multiSelectionKeyCode="Shift" panOnDrag><Background variant={BackgroundVariant.Dots} gap={18} size={0.7} color={settings.grid?'#dde4ee':'transparent'}/><Controls showInteractive={false} className="canvas-controls"/></ReactFlow></div>
    </>}
    {activeRepo&&<Inspector repo={activeRepo} refresh={()=>refreshRepo(activeRepo.path)} close={()=>setSelected(null)} notify={notify} openTransfer={()=>{setModal('transfer')}} openPr={()=>setModal('pr')}/>}
    {selectedRoot&&<div className="root-popover"><button className="close" aria-label="Close" onClick={()=>setSelectedRoot(null)}><X size={16}/></button><div className="popover-heading"><Folder size={20}/><div><strong>{nameOf(selectedRoot)}</strong><span>{plural(rootRepos.length,'repository')}</span></div></div><div className="root-actions"><button onClick={()=>launchBulk('commit_push')}><ArrowUp size={15}/> Commit & Push All</button><button onClick={()=>launchBulk('fetch')}><ArrowDown size={15}/> Fetch All</button><button onClick={()=>launchBulk('pull')}><GitBranch size={15}/> Pull All</button><button onClick={()=>refreshAll()}><RefreshCw size={15}/> Refresh</button></div><button className="remove-root" onClick={()=>removeFolder(selectedRoot)}>Remove monitored folder</button></div>}
    {searchOpen&&<div className="search-overlay"><div className="search-dialog"><div className="search-input"><Search size={17}/><input autoFocus placeholder="Find a repository…" value={search} onChange={e=>setSearch(e.target.value)}/><button onClick={()=>setSearchOpen(false)}><X size={15}/></button></div><div className="search-results">{repos.filter(r=>r.name.toLowerCase().includes(search.toLowerCase())).slice(0,30).map(r=><button key={r.path} onClick={()=>{setSelected(r.path);setSearchOpen(false);flow.current?.setCenter(settings.positions[r.path]?.[0]||700,settings.positions[r.path]?.[1]||300,{zoom:1,duration:300})}}><Github size={15}/><span>{r.name}</span><small>{r.branch}</small></button>)}</div></div></div>}
    {modal==='bulk'&&<BulkModal action={bulkAction} repos={scopedRepos} close={()=>setModal(null)} refresh={()=>refreshAll()} notify={notify} progress={progress} setProgress={setProgress} results={results} setResults={setResults}/>}
    {modal==='settings'&&<SettingsModal settings={settings} save={saveSettings} close={()=>setModal(null)} addFolder={addFolder} removeFolder={removeFolder} autoLayout={autoLayout} notify={notify}/>}
    {modal==='transfer'&&activeRepo&&<TransferModal repo={activeRepo} close={()=>setModal(null)} notify={notify} refresh={()=>refreshRepo(activeRepo.path)}/>}
    {modal==='pr'&&activeRepo&&<PrModal repo={activeRepo} close={()=>setModal(null)} notify={notify}/>}
    {toast&&<div className="toast" role="status">{toast}<button onClick={()=>setToast(null)} aria-label="Dismiss"><X size={14}/></button></div>}
  </main>;
}

function Diff({text}: {text:string}) {let oldLine=0,newLine=0;return <pre className="diff">{text?text.split('\n').map((line,i)=>{const hunk=line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);if(hunk){oldLine=Number(hunk[1]);newLine=Number(hunk[2])}const added=line.startsWith('+')&&!line.startsWith('+++'),removed=line.startsWith('-')&&!line.startsWith('---'),context=line.startsWith(' ');const oldNum=removed||context?oldLine++:'';const newNum=added||context?newLine++:'';return <div key={i} className={added?'diff-add':removed?'diff-remove':hunk?'diff-hunk':''}><span className="diff-num">{oldNum}<b>{newNum}</b></span><code>{line||' '}</code></div>}):<div className="diff-empty">No diff in this view.</div>}</pre>}

function Inspector({repo,refresh,close,notify,openTransfer,openPr}:{repo:Repo;refresh:()=>void;close:()=>void;notify:(s:string)=>void;openTransfer:()=>void;openPr:()=>void}) {
  const [file,setFile]=useState<string|null>(null),[diff,setDiff]=useState(''),[stagedView,setStagedView]=useState(false),[message,setMessage]=useState(''),[mode,setMode]=useState('all'),[include,setInclude]=useState(true),[amend,setAmend]=useState(false),[busy,setBusy]=useState(false),[section,setSection]=useState<'changes'|'branches'|'history'|'prs'>('changes'),[branches,setBranches]=useState<string[]>([]),[history,setHistory]=useState<string[]>([]),[historyDiff,setHistoryDiff]=useState(''),[prs,setPrs]=useState<any[]>([]),[newBranch,setNewBranch]=useState('');
  useEffect(()=>{setFile(null);setDiff('');setSection('changes')},[repo.path]);
  useEffect(()=>{if(!file)return;api<string>('file_diff',{path:repo.path,file,staged:stagedView}).then(setDiff).catch(e=>notify(errText(e)))},[file,stagedView,repo.path,repo.files]);
  const run=async(fn:()=>Promise<unknown>)=>{setBusy(true);try{await fn();refresh()}catch(e){notify(errText(e))}finally{setBusy(false)}};
  const doCommit=async(push:boolean)=>{setBusy(true);try{const r=await api<OpResult>('commit_repo',{path:repo.path,message,mode,includeUntracked:include,push,amend});notify(r.detail);if(r.status==='success'){setMessage('');refresh()}}catch(e){notify(errText(e))}finally{setBusy(false)}};
  const chooseSection=(s:typeof section)=>{setSection(s);if(s==='branches')api<string[]>('list_branches',{path:repo.path}).then(setBranches).catch(e=>notify(errText(e)));if(s==='history')api<string[]>('repo_history',{path:repo.path}).then(setHistory).catch(e=>notify(errText(e)));if(s==='prs')api<any[]>('github_prs',{path:repo.path}).then(setPrs).catch(e=>notify(errText(e)))};
  const branchAction=(action:string,name:string,other?:string)=>run(async()=>{const r=await api<string>('manage_branch',{path:repo.path,action,name,other});notify(r);setBranches(await api('list_branches',{path:repo.path}))});
  return <aside className="inspector"><div className="inspector-head"><div><small>Repository</small><h2>{repo.name}</h2><span><GitBranch size={13}/>{repo.branch}{repo.upstream&&<em> · {repo.upstream}</em>}</span></div><button aria-label="Close inspector" className="icon-button" onClick={close}><PanelRightClose size={18}/></button></div>
    <div className="inspector-tabs">{(['changes','branches','history','prs'] as const).map(s=><button key={s} className={section===s?'current':''} onClick={()=>chooseSection(s)}>{s==='prs'?'PRs':s[0].toUpperCase()+s.slice(1)}</button>)}</div>
    {section==='changes'&&<><div className="section-label"><strong>{repo.files.length?plural(repo.files.length,'file')+' changed':'Working tree clean'}</strong><div><button onClick={()=>run(async()=>{await api('stage_files',{path:repo.path,files:[],all:true,includeUntracked:true})})} disabled={!repo.files.length||busy}>Stage all</button><button onClick={()=>run(async()=>{await api('unstage_files',{path:repo.path,files:[],all:true})})} disabled={!repo.files.some(f=>f.staged)||busy}>Unstage all</button></div></div>
    <div className="file-list">{repo.files.map(f=><div className={`file-row ${file===f.path?'active':''}`} key={f.path}><button className="file-open" onClick={()=>{setFile(f.path);setStagedView(false)}}><span className={`file-code code-${f.status}`}>{f.status}</span><span title={f.path}>{f.path}</span></button><button className="file-stage" title={f.staged?'Unstage':'Stage'} onClick={()=>run(async()=>{await api(f.staged?'unstage_files':'stage_files',{path:repo.path,files:[f.path],all:false,includeUntracked:true})})}>{f.staged?<Minus size={13}/>:<Plus size={13}/>}</button></div>)}{!repo.files.length&&<div className="quiet-empty"><Check size={19}/>Everything is up to date locally.</div>}</div>
    {file&&<div className="diff-panel"><div className="diff-header"><span title={file}>{file}</span><div><button className={!stagedView?'active':''} onClick={()=>setStagedView(false)}>Working</button><button className={stagedView?'active':''} onClick={()=>setStagedView(true)}>Staged</button></div></div><Diff text={diff}/></div>}
    <div className="commit-box"><input placeholder="Commit message…" value={message} onChange={e=>setMessage(e.target.value)}/><div className="commit-options"><select value={mode} onChange={e=>setMode(e.target.value)} aria-label="Changes to commit"><option value="all">All changes</option><option value="tracked">Tracked files</option><option value="staged">Staged only</option></select><label><input type="checkbox" checked={include} onChange={e=>setInclude(e.target.checked)} disabled={mode!=='all'}/> Include untracked</label><label><input type="checkbox" checked={amend} onChange={e=>setAmend(e.target.checked)}/> Amend last commit</label></div>{amend&&<p className="amend-warning">Rewrites the last unpublished local commit.</p>}<div className="commit-buttons"><button onClick={()=>doCommit(false)} disabled={busy||!repo.files.length||(!message.trim()&&!amend)}>Commit</button><button className="primary-button" onClick={()=>doCommit(true)} disabled={busy||!repo.files.length||(!message.trim()&&!amend)}>Commit & Push <ArrowUp size={14}/></button></div></div></>}
    {section==='branches'&&<div className="inspector-section"><div className="branch-list">{branches.map(b=><div key={b}><GitBranch size={14}/><span>{b}</span>{b===repo.branch&&<small>current</small>}<button onClick={()=>branchAction('switch',b)} disabled={b===repo.branch||busy}>Switch</button><button onClick={()=>branchAction('publish',b)} disabled={busy}>Publish</button>{b!==repo.branch&&<button onClick={()=>branchAction('delete',b)} disabled={busy}>Delete</button>}</div>)}</div><div className="inline-form"><input placeholder="New branch name" value={newBranch} onChange={e=>setNewBranch(e.target.value)}/><button onClick={()=>branchAction('create',newBranch)} disabled={!newBranch||busy}>Create</button></div><button className="text-action" onClick={()=>run(async()=>{await api('fetch_repo',{path:repo.path});notify('Fetched remote branches')})}>Fetch remote branches</button><button className="text-action" onClick={()=>{const next=prompt('Rename current branch to:');if(next)branchAction('rename',repo.branch,next)}}>Rename current branch</button></div>}
    {section==='history'&&<div className="history-list">{history.map(row=>{const [hash,date,...message]=row.split('\t');return <button key={hash} onClick={()=>api<string>('history_detail',{path:repo.path,hash}).then(setHistoryDiff).catch(e=>notify(errText(e)))}><GitCommitHorizontal size={15}/><span><strong>{message.join(' ')}</strong><small>{hash} · {date}</small></span></button>})}{!history.length&&<p>No commits yet.</p>}{historyDiff&&<Diff text={historyDiff}/>}</div>}
    {section==='prs'&&<div className="inspector-section"><button className="primary-button full" onClick={openPr}><GitPullRequest size={15}/> Create Pull Request</button><button className="secondary-button full" onClick={openTransfer}>PR from Different Branch</button><div className="pr-list">{prs.map(pr=><button key={pr.id} onClick={()=>openUrl(pr.html_url)}><GitPullRequest size={15}/><span>{pr.title}<small>#{pr.number} · {pr.state}</small></span></button>)}</div></div>}
    <div className="inspector-footer"><button onClick={()=>run(async()=>{notify(await api<string>('fetch_repo',{path:repo.path}))})} disabled={busy}><RefreshCw size={14}/> Fetch</button><button onClick={()=>run(async()=>{notify(await api<string>('pull_repo',{path:repo.path}))})} disabled={busy}><ArrowDown size={14}/> Pull</button><button onClick={()=>run(async()=>{notify(await api<string>('manage_branch',{path:repo.path,action:'publish',name:repo.branch}))})} disabled={busy}><ArrowUp size={14}/> Push</button></div>
  </aside>;
}

function BulkModal({action,repos,close,refresh,notify,progress,setProgress,results,setResults}:{action:'commit_push'|'fetch'|'pull';repos:Repo[];close:()=>void;refresh:()=>void;notify:(s:string)=>void;progress:{index:number;total:number}|null;setProgress:(v:{index:number;total:number}|null)=>void;results:OpResult[]|null;setResults:(v:OpResult[]|null)=>void}) {
  const eligible=useMemo(()=>repos.filter(r=>action==='commit_push'?r.files.length>0:action==='fetch'?!!r.remote:!!r.upstream&&r.behind>0),[repos,action]);
  const [paths,setPaths]=useState<string[]>(eligible.map(r=>r.path)),[message,setMessage]=useState(''),[mode,setMode]=useState('all'),[include,setInclude]=useState(true),[busy,setBusy]=useState(false);
  useEffect(()=>setPaths(eligible.map(r=>r.path)),[eligible]);
  const title=action==='commit_push'?'Commit & Push All':action==='fetch'?'Fetch All':'Pull All';
  const run=async(retry=false)=>{setBusy(true);const pending=retry?(results||[]).filter(r=>r.status==='failed'):paths.map(path=>({path,committed:false}));setProgress({index:0,total:pending.length});try{const produced:OpResult[]=[];for(const item of pending){const nextAction=retry&&item.committed?'push':action;const [result]=await api<OpResult[]>('bulk_operation',{request:{paths:[item.path],action:nextAction,message,mode,includeUntracked:include}});produced.push(result);setProgress({index:produced.length,total:pending.length})}setResults(retry?[...(results||[]).filter(r=>r.status!=='failed'),...produced]:produced);refresh()}catch(e){notify(errText(e))}finally{setBusy(false)}};
  return <div className="modal-backdrop"><div className="dialog bulk-dialog"><button className="close" aria-label="Close" onClick={close}><X size={16}/></button><h2>{title}</h2><p>{action==='commit_push'?'Each selected repository receives its own commit and push.':action==='fetch'?'Download remote updates without changing working files.':'Only branches that can fast-forward safely will update.'}</p>{action==='commit_push'&&<><input className="dialog-input" placeholder="Commit message" value={message} onChange={e=>setMessage(e.target.value)}/><div className="bulk-options"><select value={mode} onChange={e=>setMode(e.target.value)}><option value="all">Commit all changes</option><option value="tracked">Commit tracked changes</option><option value="staged">Staged only</option></select><label><input type="checkbox" checked={include} onChange={e=>setInclude(e.target.checked)} disabled={mode!=='all'}/> Include untracked files</label></div></>}
    <div className="bulk-list">{eligible.map(r=><label key={r.path}><input type="checkbox" checked={paths.includes(r.path)} onChange={e=>setPaths(p=>e.target.checked?[...p,r.path]:p.filter(x=>x!==r.path))}/><span className="bulk-repo">{r.name}</span><small>{action==='commit_push'?plural(r.files.length,'file'):r.upstream||r.remote}</small><span className="bulk-result">{results?.find(x=>x.path===r.path)?.status||''}</span></label>)}{!eligible.length&&<div className="quiet-empty">No repositories need this action.</div>}</div>
    {progress&&<p className="progress">{progress.index} / {progress.total} repositories completed</p>}{results&&<div className="result-list">{results.map(r=><div key={r.path}><strong>{nameOf(r.path)}</strong><span className={r.status}>{r.status}</span><small>{r.detail}</small></div>)}</div>}
    <div className="dialog-actions"><button onClick={close}>{results?'Done':'Cancel'}</button><button className="primary-button" disabled={busy||(results?!results.some(r=>r.status==='failed'):!paths.length||(action==='commit_push'&&!message.trim()))} onClick={()=>run(!!results)}>{busy?'Working…':results?'Retry failed':title}</button></div></div></div>;
}

function SettingsModal({settings,save,close,addFolder,removeFolder,autoLayout,notify}:{settings:Settings;save:(s:Settings)=>Promise<void>;close:()=>void;addFolder:()=>void;removeFolder:(s:string)=>void;autoLayout:(layout:string)=>void;notify:(s:string)=>void}) {
  const [gitVersion,setGitVersion]=useState('Checking…'),[connected,setConnected]=useState(false),[device,setDevice]=useState<DeviceCode|null>(null),[connecting,setConnecting]=useState(false);
  useEffect(()=>{api<string>('git_version').then(setGitVersion).catch(e=>setGitVersion(errText(e)));api<boolean>('github_connected').then(setConnected)},[]);
  const connect=async()=>{try{setConnecting(true);const code=await api<DeviceCode>('github_begin');setDevice(code);await openUrl(code.verificationUri);await api('github_finish',{code});setConnected(true);setDevice(null);notify('GitHub connected')}catch(e){notify(errText(e))}finally{setConnecting(false)}};
  return <div className="modal-backdrop"><div className="dialog settings-dialog"><button className="close" aria-label="Close" onClick={close}><X size={16}/></button><h2>Settings</h2><div className="settings-group"><h3>Folders</h3>{settings.roots.map(r=><div className="settings-root" key={r}><Folder size={15}/><span title={r}>{r}</span><button onClick={()=>removeFolder(r)} aria-label={`Remove ${r}`}><X size={14}/></button></div>)}<button className="text-action" onClick={addFolder}><Plus size={14}/> Add folder</button></div>
  <div className="settings-group"><h3>Canvas</h3><label>Layout<select value={settings.layout} onChange={e=>autoLayout(e.target.value)}><option value="horizontal">Horizontal</option><option value="tree">Tree</option><option value="radial">Radial</option></select></label><label>Appearance<select value={settings.appearance} onChange={e=>save({...settings,appearance:e.target.value})}><option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option></select></label><label>Scan depth<input type="number" min="1" max="100" value={settings.maxDepth} onChange={e=>save({...settings,maxDepth:Number(e.target.value)})}/></label><label><input type="checkbox" checked={settings.grid} onChange={e=>save({...settings,grid:e.target.checked})}/> Show canvas dots</label><label><input type="checkbox" checked={settings.autoMonitor} onChange={e=>save({...settings,autoMonitor:e.target.checked})}/> Monitor file changes</label></div>
  <div className="settings-group"><h3>Integrations</h3><div className="integration-row"><span><GitBranch size={15}/> Git <small>{gitVersion}</small></span></div><div className="integration-row"><span><Github size={15}/> GitHub <small>{connected?'Connected':'Not connected'}</small></span>{connected?<button onClick={async()=>{try{await api('github_disconnect');setConnected(false)}catch(e){notify(errText(e))}}}>Disconnect</button>:<button onClick={connect} disabled={connecting}>{connecting?'Connecting…':'Connect'}</button>}</div>{device&&<p className="device-code">Enter code <strong>{device.userCode}</strong> at GitHub in your browser.</p>}</div><div className="dialog-actions"><button className="primary-button" onClick={close}>Done</button></div></div></div>;
}

function TransferModal({repo,close,notify,refresh}:{repo:Repo;close:()=>void;notify:(s:string)=>void;refresh:()=>void}) {
  const [target,setTarget]=useState(repo.branch),[branch,setBranch]=useState(''),[message,setMessage]=useState(''),[body,setBody]=useState(''),[preview,setPreview]=useState<TransferPreview|null>(null),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[link,setLink]=useState('');
  useEffect(()=>{api<TransferPreview>('transfer_preview',{path:repo.path,target}).then(setPreview).catch(e=>notify(errText(e)))},[repo.path,target]);
  const run=async()=>{setBusy(true);try{const url=await api<string>('transfer_pr',{path:repo.path,target,branch,message,body,confirmRewrite:confirm});setLink(url);refresh()}catch(e){notify(errText(e))}finally{setBusy(false)}};
  return <div className="modal-backdrop"><div className="dialog transfer-dialog"><button className="close" aria-label="Close" onClick={close}><X size={16}/></button><h2>PR from Different Branch</h2><p>Move this work to a new branch, publish it, and open a GitHub pull request.</p>{preview&&<div className="transfer-preview"><strong>{preview.scenario==='local_commits'?`${plural(preview.commits.length,'local commit')} ahead`:`${plural(preview.files.length,'changed file')}`}</strong>{preview.commits.map(c=><span key={c}>{c}</span>)}{preview.files.map(f=><span key={f}>{f}</span>)}<p>{preview.warning}</p>{preview.conflictFiles.length>0&&<p className="warning">Possible merge conflicts: {preview.conflictFiles.join(', ')}</p>}</div>}
  <label>New branch<input value={branch} onChange={e=>setBranch(e.target.value)} placeholder="name/feature-update"/></label><label>Target branch<input value={target} onChange={e=>setTarget(e.target.value)}/></label><label>Commit message / PR title<input value={message} onChange={e=>setMessage(e.target.value)} placeholder="Describe the change"/></label><label>PR description<textarea value={body} onChange={e=>setBody(e.target.value)}/></label>{preview?.scenario==='local_commits'&&<label className="confirm-row"><input type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)}/> After publishing, restore my local {target} to origin/{target}.</label>}{link&&<button className="pr-link" onClick={()=>openUrl(link)}>Open created pull request ↗</button>}<div className="dialog-actions"><button onClick={close}>Close</button><button className="primary-button" onClick={run} disabled={busy||!preview||!branch||!message}>{busy?'Publishing…':'Create branch & PR'}</button></div></div></div>;
}

function PrModal({repo,close,notify}:{repo:Repo;close:()=>void;notify:(s:string)=>void}) {
  const [head,setHead]=useState(repo.branch),[base,setBase]=useState('main'),[title,setTitle]=useState(''),[body,setBody]=useState(''),[busy,setBusy]=useState(false),[link,setLink]=useState('');
  const run=async()=>{setBusy(true);try{setLink(await api('github_create_pr',{path:repo.path,head,base,title,body}))}catch(e){notify(errText(e))}finally{setBusy(false)}};
  return <div className="modal-backdrop"><div className="dialog transfer-dialog"><button className="close" aria-label="Close" onClick={close}><X size={16}/></button><h2>Create Pull Request</h2><p>Publish an existing branch as a GitHub pull request.</p><label>Source branch<input value={head} onChange={e=>setHead(e.target.value)}/></label><label>Target branch<input value={base} onChange={e=>setBase(e.target.value)}/></label><label>Title<input value={title} onChange={e=>setTitle(e.target.value)}/></label><label>Description<textarea value={body} onChange={e=>setBody(e.target.value)}/></label>{link&&<button className="pr-link" onClick={()=>openUrl(link)}>Open created pull request ↗</button>}<div className="dialog-actions"><button onClick={close}>Close</button><button className="primary-button" disabled={busy||!head||!base||!title} onClick={run}>{busy?'Creating…':'Create PR'}</button></div></div></div>;
}
