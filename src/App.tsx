import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, BackgroundVariant, Controls, Handle, Position, applyNodeChanges, type Edge, type Node, type NodeChange, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as chooseFolder } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useUpdater, type Updater } from './useUpdater';
import { createRepoInspector } from './repoInspector';
import { applyNodeSelection } from './nodeSelection';
import { Folder, GitBranch, Github, MoreHorizontal, Plus, RefreshCw, Settings2, Search, X, Minus, Maximize2, ChevronDown, GitPullRequest, ArrowUp, ArrowDown, Check, FileText, GitCommitHorizontal, History, PanelRightClose } from 'lucide-react';

type FileChange = { path:string; status:string; staged:boolean; unstaged:boolean };
type Repo = { path:string; name:string; branch:string; kind:string; files:FileChange[]; ahead:number; behind:number; upstream:string|null; remote:string|null; error:string|null };
type Section = { id:string; name:string; paths:string[] };
type Settings = { repos:string[]; sections:Section[]; layout:string; positions:Record<string,[number,number]>; viewport:[number,number,number]; grid:boolean; autoMonitor:boolean; appearance:string };
type OpResult = { path:string; status:string; detail:string; committed:boolean; pushed:boolean };
type BulkAction = 'commit_push'|'fetch'|'pull';
type BulkOptions = { paths:string[]; message:string; mode:string; includeUntracked:boolean };
type BulkJob = BulkOptions & { runId:string; action:BulkAction; pending:number; completed:number; busy:boolean; results:OpResult[]; error:string|null };
type TransferPreview = { scenario:string; files:string[]; commits:string[]; conflictFiles:string[]; warning:string };
type DeviceCode = { deviceCode:string; userCode:string; verificationUri:string; expiresIn:number; interval:number };
type NodeData = Record<string, unknown> & { title:string; subtitle:string; count?:number; dirty?:boolean; ahead?:number; behind?:number; error?:string; kind?:string };
const initialSettings:Settings = { repos:[],sections:[],layout:'horizontal',positions:{},viewport:[0,0,1],grid:true,autoMonitor:true,appearance:'light' };
const errText = (e:unknown) => typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
const nameOf = (path:string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
const plural = (n:number, word:string) => `${n} ${n===1?word:word==='repository'?'repositories':`${word}s`}`;
const api = <T,>(command:string,args?:Record<string,unknown>) => invoke<T>(command,args);
const inspectRepo = createRepoInspector((path:string) => api<Repo>('inspect_repo',{path}));

function CanvasNode({data}:NodeProps<Node<NodeData>>) {
  return <div className={`canvas-node repo-node ${data.error?'node-error':''}`}>
    <Handle type="target" position={Position.Left} className="node-handle" />
    <div className="node-icon"><Github size={17}/></div>
    <div className="node-copy"><strong title={data.title}>{data.title}</strong><span><GitBranch size={10}/>{data.subtitle}</span>
      <small className={data.error?'status-error':data.dirty?'status-dirty':'status-clean'}><i/>{data.error?'Unavailable':data.dirty?`${data.count} ${data.count===1?'file':'files'} changed`:'Clean'}{!data.dirty&&data.behind ? ` · ↓${data.behind}`:''}{!data.dirty&&data.ahead ? ` · ↑${data.ahead}`:''}</small>
    </div>
    <MoreHorizontal size={14} className="node-more"/>
    <Handle type="source" position={Position.Right} className="node-handle" />
  </div>;
}
const nodeTypes = { canvas: CanvasNode };

export default function App() {
  const updater=useUpdater();
  const [settings,setSettings]=useState<Settings>(initialSettings);
  const [repos,setRepos]=useState<Repo[]>([]);
  const [nodes,setNodes]=useState<Node<NodeData>[]>([]);
  const [selected,setSelected]=useState<string|null>(null);
  const [selectedPaths,setSelectedPaths]=useState<string[]>([]);
  const [activeSection,setActiveSection]=useState<string|null>(null);
  const [menu,setMenu]=useState(false);
  const [modal,setModal]=useState<'bulk'|'settings'|'sections'|'transfer'|'pr'|null>(null);
  const [bulkAction,setBulkAction]=useState<BulkAction>('commit_push');
  const [toast,setToast]=useState<string|null>(null);
  const [loading,setLoading]=useState(false);
  const [search,setSearch]=useState('');
  const [searchOpen,setSearchOpen]=useState(false);
  const [bulkJob,setBulkJob]=useState<BulkJob|null>(null);
  const bulkJobRef=useRef<BulkJob|null>(null); bulkJobRef.current=bulkJob;
  const bulkRunId=useRef('');
  const [settingsLoaded,setSettingsLoaded]=useState(false);
  const [flowReady,setFlowReady]=useState(false);
  const flow=useRef<ReactFlowInstance<Node<NodeData>,Edge>|null>(null);
  const flowWrap=useRef<HTMLDivElement|null>(null);
  const canvasReady=useRef(false);
  const refreshGeneration=useRef(0);
  const trackingGeneration=useRef(0);
  const settingsRef=useRef(settings); settingsRef.current=settings;
  const reposRef=useRef(repos); reposRef.current=repos;
  const isViewportSame=(current:[number,number,number], next:[number,number,number]) => Math.abs(current[0]-next[0]) < 0.5 && Math.abs(current[1]-next[1]) < 0.5 && Math.abs(current[2]-next[2]) < 0.0001;
  const notify=(message:string)=>{setToast(message);window.setTimeout(()=>setToast(null),6500)};
  const saveSettings=async (next:Settings)=>{
    if(JSON.stringify(next)===JSON.stringify(settingsRef.current))return;
    const generation=trackingGeneration.current;
    try{const saved=await api<Settings>('update_settings',{settings:next});if(generation===trackingGeneration.current){setSettings(saved);settingsRef.current=saved}}catch(e){notify(errText(e))}
  };
  const refreshRepo=useCallback(async (path:string)=>{try{const r=await inspectRepo(path,true);if(settingsRef.current.repos.includes(path))setRepos(prev=>prev.map(item=>item.path===path?r:item))}catch(e){if(settingsRef.current.repos.includes(path))setRepos(prev=>prev.map(item=>item.path===path?{...item,error:errText(e)}:item))}},[]);
  const refreshAll=useCallback(async (paths?:string[])=>{
    const generation=++refreshGeneration.current;
    const targets=paths||settingsRef.current.repos;
    setLoading(true);
    const found=await Promise.all(targets.map(async path=>{try{return await inspectRepo(path,true)}catch(e){return {path,name:nameOf(path),branch:'—',kind:'repository',files:[],ahead:0,behind:0,upstream:null,remote:null,error:errText(e)} as Repo}}));
    if(generation!==refreshGeneration.current)return;
    setRepos(found.filter(repo=>settingsRef.current.repos.includes(repo.path)));setLoading(false);
  },[]);
  useEffect(()=>{if(!('__TAURI_INTERNALS__' in window))return;api<Settings>('get_settings').then(s=>{setSettings(s);settingsRef.current=s;setSettingsLoaded(true);refreshAll(s.repos)}).catch(e=>notify(errText(e)))},[refreshAll]);
  useEffect(()=>{if(!('__TAURI_INTERNALS__' in window))return;let disposed=false;let a:(()=>void)|undefined,b:(()=>void)|undefined;let timer:number|undefined;const pending=new Set<string>();
    listen<string>('git-changed',e=>{if(disposed)return;pending.add(e.payload);window.clearTimeout(timer);timer=window.setTimeout(()=>{const changed=[...pending];pending.clear();const paths=new Set<string>();for(const path of changed){reposRef.current.filter(r=>path===r.path||path.startsWith(r.path+'/')||path.startsWith(r.path+'\\')).forEach(r=>paths.add(r.path))}paths.forEach(refreshRepo)},500)}).then(fn=>{if(disposed)fn();else a=fn});
    listen<{runId:string;index:number;total:number;result:OpResult}>('bulk-progress',e=>{
      if(disposed||e.payload.runId!==bulkRunId.current)return;
      setBulkJob(previous=>previous?{...previous,completed:e.payload.index,results:[...previous.results.filter(r=>r.path!==e.payload.result.path),e.payload.result]}:previous);
    }).then(fn=>{if(disposed)fn();else b=fn});
    return()=>{disposed=true;a?.();b?.();window.clearTimeout(timer)};
  },[refreshRepo]);
  const addPaths=async(paths:string[])=>{const added:string[]=[];const errors:string[]=[];for(const path of paths){try{const s=await api<Settings>('add_repos',{paths:[path]});trackingGeneration.current++;setSettings(s);settingsRef.current=s;added.push(path)}catch(e){errors.push(`${nameOf(path)}: ${errText(e)}`)}}if(added.length)await refreshAll();if(errors.length)notify(errors.join(' · '));else if(added.length)notify(`${plural(added.length,'repository')} added`)};
  const addRepos=async()=>{try{const chosen=await chooseFolder({directory:true,multiple:true,title:'Select Git repository folders'});if(!chosen)return;await addPaths(Array.isArray(chosen)?chosen:[chosen])}catch(e){notify(errText(e))}};
  const removeRepo=async(path:string)=>{try{const s=await api<Settings>('remove_repo',{path});trackingGeneration.current++;refreshGeneration.current++;setSettings(s);settingsRef.current=s;setRepos(prev=>prev.filter(repo=>repo.path!==path));setLoading(false);setSelected(v=>v===path?null:v);setSelectedPaths(v=>v.filter(p=>p!==path));notify(`${nameOf(path)} is no longer tracked`)}catch(e){notify(errText(e))}};
  const sectionFor=(path:string)=>settings.sections.find(section=>section.paths.includes(path));
  useEffect(()=>{if(activeSection&&activeSection!=='ungrouped'&&!settings.sections.some(s=>s.id===activeSection))setActiveSection(null)},[activeSection,settings.sections]);
  const visibleRepos=useMemo(()=>activeSection===null?repos:activeSection==='ungrouped'?repos.filter(r=>!settings.sections.some(s=>s.paths.includes(r.path))):repos.filter(r=>settings.sections.find(s=>s.id===activeSection)?.paths.includes(r.path)),[repos,settings.sections,activeSection]);
  const canvasPosition=(path:string,index:number,positions=settingsRef.current.positions):[number,number]=>positions[path]||[230+(index%4)*220,180+Math.floor(index/4)*105];
  const fitCanvas=(items=visibleRepos,positions=settingsRef.current.positions,duration=250)=>{
    const element=flowWrap.current;
    if(!flow.current||!element||!items.length||!element.clientWidth||!element.clientHeight)return;
    const points=items.map((repo,index)=>canvasPosition(repo.path,index,positions));
    const left=Math.min(...points.map(p=>p[0]));
    const top=Math.min(...points.map(p=>p[1]));
    const right=Math.max(...points.map(p=>p[0]+170));
    const bottom=Math.max(...points.map(p=>p[1]+90));
    const padding=48;
    const zoom=Math.min(1,Math.max(0.05,Math.min((element.clientWidth-padding*2)/(right-left),(element.clientHeight-padding*2)/(bottom-top))));
    const nextViewport={x:(element.clientWidth-(left+right)*zoom)/2,y:(element.clientHeight-(top+bottom)*zoom)/2,zoom};
    const current=flow.current.getViewport();
    if(isViewportSame([current.x,current.y,current.zoom],[nextViewport.x,nextViewport.y,nextViewport.zoom]))return;
    flow.current.setViewport(nextViewport,{duration});
  };
  useEffect(()=>{
    if(!settingsLoaded||!flowReady||!visibleRepos.length||canvasReady.current)return;
    const frame=requestAnimationFrame(()=>{
      const element=flowWrap.current;
      if(!element)return;
      const [x,y,zoom]=settingsRef.current.viewport;
      const valid=[x,y,zoom].every(Number.isFinite)&&zoom>=0.05&&zoom<=1.6;
      const inView=valid&&visibleRepos.some((repo,index)=>{
        const [px,py]=canvasPosition(repo.path,index);
        return px*zoom+x<element.clientWidth&&((px+170)*zoom+x)>0&&py*zoom+y<element.clientHeight&&((py+90)*zoom+y)>0;
      });
      canvasReady.current=true;
      const nextViewport={x,y,zoom};
      const current=flow.current?.getViewport();
      if(inView && current && !isViewportSame([current.x,current.y,current.zoom],[nextViewport.x,nextViewport.y,nextViewport.zoom]))flow.current?.setViewport(nextViewport);
      else if(!inView) fitCanvas(visibleRepos,settingsRef.current.positions,0);
    });
    return()=>cancelAnimationFrame(frame);
  },[settingsLoaded,flowReady,visibleRepos]);
  useEffect(()=>{
    if(!canvasReady.current||!visibleRepos.length)return;
    const frame=requestAnimationFrame(()=>fitCanvas(visibleRepos,settingsRef.current.positions,250));
    return()=>cancelAnimationFrame(frame);
  },[activeSection]);
  const autoLayout=useCallback((layout=settingsRef.current.layout, currentRepos=reposRef.current)=>{
    const positions:Record<string,[number,number]>={};
    currentRepos.forEach((repo,i)=>{if(layout==='radial'){const angle=(i/Math.max(currentRepos.length,1))*Math.PI*2;positions[repo.path]=[550+Math.cos(angle)*310,320+Math.sin(angle)*220]}else if(layout==='tree'){positions[repo.path]=[220+(i%4)*220,180+Math.floor(i/4)*105]}else{positions[repo.path]=[230+(i%4)*220,180+Math.floor(i/4)*105]}});
    saveSettings({...settingsRef.current,layout,positions});window.setTimeout(()=>fitCanvas(currentRepos,positions,350),120);
  },[]);
  useEffect(()=>{setNodes(previousNodes=>{
    // Keep React Flow's measurements and interaction state when repository data changes.
    const previousByPath=new Map(previousNodes.map(node=>[node.id,node]));
    const selection=new Set(selectedPaths);
    return visibleRepos.map((repo,i)=>{
      const pos=settings.positions[repo.path]||[230+(i%4)*220,180+Math.floor(i/4)*105];
      return {...previousByPath.get(repo.path),id:repo.path,type:'canvas',position:{x:pos[0],y:pos[1]},data:{title:repo.name,subtitle:repo.branch,count:repo.files.length,dirty:repo.files.length>0,ahead:repo.ahead,behind:repo.behind,error:repo.error||undefined,kind:repo.kind},selected:selection.has(repo.path)};
    });
  })},[visibleRepos,settings.positions,selectedPaths]);
  const edges=useMemo<Edge[]>(()=>[],[]);
  const onNodesChange=useCallback((changes:NodeChange<Node<NodeData>>[])=>{
    setNodes(prev=>applyNodeChanges(changes,prev));
    setSelectedPaths(prev=>applyNodeSelection(changes,prev));
  },[]);
  const persistPositions=()=>{const positions={...settingsRef.current.positions};nodes.forEach(n=>positions[n.id]=[n.position.x,n.position.y]);saveSettings({...settingsRef.current,positions})};
  const activeRepo=repos.find(r=>r.path===selected)||null;
  const scopedRepos=useMemo(()=>selectedPaths.length?visibleRepos.filter(r=>selectedPaths.includes(r.path)):visibleRepos,[selectedPaths,visibleRepos]);
  const runBulk=async(action:BulkAction,options:BulkOptions,retry=false)=>{
    const current=bulkJobRef.current;
    if(current?.busy)return;
    const pending=retry?(current?.results.filter(r=>r.status==='failed')||[]):options.paths.map(path=>({path,committed:false}));
    if(!pending.length)return;
    const runId=`${Date.now()}-${Math.random()}`;
    const job:BulkJob={...options,action,runId,pending:pending.length,completed:0,busy:true,results:retry?current?.results||[]:[],error:null};
    bulkRunId.current=runId;
    bulkJobRef.current=job;
    setBulkJob(job);
    setModal(null);
    try{
      const results=await api<OpResult[]>('bulk_operation',{request:{runId,paths:pending.map(r=>r.path),action,message:options.message,mode:options.mode,includeUntracked:options.includeUntracked,committedPaths:retry?pending.filter(r=>r.committed).map(r=>r.path):[]}});
      setBulkJob(previous=>previous?.runId===runId?{...previous,busy:false,completed:pending.length,results:[...previous.results.filter(old=>!results.some(r=>r.path===old.path)),...results]}:previous);
      refreshAll();
    }catch(e){
      setBulkJob(previous=>previous?.runId===runId?{...previous,busy:false,error:errText(e)}:previous);
    }
  };
  const launchBulk=(action:BulkAction)=>{if(bulkJobRef.current?.busy){notify('Wait for the current operation to finish');return}setBulkAction(action);setModal('bulk');setMenu(false)};
  const selectSection=(id:string|null)=>{setActiveSection(id);setSelected(null);setSelectedPaths([])};
  useEffect(()=>{const onKey=(e:KeyboardEvent)=>{const mod=e.metaKey||e.ctrlKey;if(e.key==='Escape'){setModal(null);setSelected(null);setMenu(false);setSearchOpen(false)}if(mod&&e.key.toLowerCase()==='o'){e.preventDefault();addRepos()}if(mod&&e.key.toLowerCase()==='r'){e.preventDefault();refreshAll()}if(mod&&e.key.toLowerCase()==='f'){e.preventDefault();setSearchOpen(true)}if(mod&&(e.key==='+'||e.key==='=')){e.preventDefault();flow.current?.zoomIn()}if(mod&&e.key==='-'){e.preventDefault();flow.current?.zoomOut()}};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey)},[refreshAll]);
  useEffect(()=>{if(!('__TAURI_INTERNALS__' in window))return;let unlisten:(()=>void)|undefined;getCurrentWindow().onDragDropEvent(async event=>{if(event.payload.type==='drop')await addPaths(event.payload.paths)}).then(fn=>unlisten=fn);return()=>unlisten?.()},[refreshAll]);
  const ungrouped=repos.filter(r=>!settings.sections.some(s=>s.paths.includes(r.path)));
  return <main className={`app theme-${settings.appearance} ${navigator.userAgent.includes('Mac')?'mac':''}`}>
    <header className="titlebar" data-tauri-drag-region><div className="brand" data-tauri-drag-region><span className="brand-mark"><GitBranch size={13}/></span><span data-tauri-drag-region>git-monitor</span></div><button className="icon-button search-button" aria-label="Search repositories" onClick={()=>setSearchOpen(true)}><Search size={15}/></button><div className="titlebar-spacer" data-tauri-drag-region/></header>
    <aside className="section-sidebar" aria-label="Repository sections"><div className="sidebar-heading"><span>Sections</span><button aria-label="Manage sections" title="Manage sections" onClick={()=>setModal('sections')}><Plus size={15}/></button></div><button className={`sidebar-section ${activeSection===null?'current':''}`} onClick={()=>selectSection(null)}><span>All repositories</span><small>{repos.length}</small></button>{settings.sections.map(section=><button key={section.id} className={`sidebar-section ${activeSection===section.id?'current':''}`} onClick={()=>selectSection(section.id)}><span>{section.name}</span><small>{section.paths.filter(p=>settings.repos.includes(p)).length}</small></button>)}{settings.sections.length>0&&ungrouped.length>0&&<button className={`sidebar-section ${activeSection==='ungrouped'?'current':''}`} onClick={()=>selectSection('ungrouped')}><span>Ungrouped</span><small>{ungrouped.length}</small></button>}<button className="sidebar-add" onClick={addRepos}><Plus size={15}/> Add repositories</button><div className="sidebar-bottom"><button onClick={()=>setModal('sections')}><Folder size={15}/> Organize</button><button onClick={()=>setModal('settings')}><Settings2 size={15}/> Settings</button></div></aside>
    {settings.repos.length===0?<section className="first-run"><div className="first-run-icon"><Github size={23}/></div><h1>Your repositories, in view.</h1><p>Select one or several Git repository folders to start monitoring.</p><button className="primary-button" onClick={addRepos}><Plus size={15}/> Add repositories</button></section>:<>
      <div className="breadcrumb"><Github size={14}/><span>{activeSection===null?'All repositories':activeSection==='ungrouped'?'Ungrouped':settings.sections.find(s=>s.id===activeSection)?.name}</span><span className="breadcrumb-count">{plural(visibleRepos.length,'repository')}</span></div>
      <div className="top-actions">{selectedPaths.length>0&&<span className="selection-count">{plural(selectedPaths.length,'selected')}</span>}<button className="round-action" aria-label="Refresh visible repositories" title="Refresh" onClick={()=>refreshAll()}><RefreshCw size={15} className={loading?'spin':''}/></button><button className="commit-all" onClick={()=>launchBulk('commit_push')}><ArrowUp size={15}/> {selectedPaths.length?'Commit & Push Selected':'Commit & Push All'}</button><div className="menu-wrap"><button className="round-action" aria-label="More actions" onClick={()=>setMenu(!menu)}><MoreHorizontal size={19}/></button>{menu&&<div className="action-menu">
        <button onClick={()=>launchBulk('commit_push')}>Commit & Push {selectedPaths.length?'Selected':'All'}</button><button onClick={()=>launchBulk('fetch')}>Fetch {selectedPaths.length?'Selected':'All'}</button><button onClick={()=>launchBulk('pull')}>Pull {selectedPaths.length?'Selected':'All'}</button><hr/><button onClick={()=>{setSelectedPaths(visibleRepos.map(r=>r.path));setMenu(false)}}>Select all visible</button><button onClick={()=>{setSelectedPaths(visibleRepos.filter(r=>r.files.length).map(r=>r.path));setMenu(false)}}>Select changed</button><button onClick={()=>{setSelectedPaths([]);setMenu(false)}}>Deselect all</button><hr/><button onClick={()=>{setModal('sections');setMenu(false)}}>Organize sections</button><button onClick={()=>{addRepos();setMenu(false)}}>Add repositories</button><button onClick={()=>{autoLayout();setMenu(false)}}>Auto Layout</button><button onClick={()=>{fitCanvas();setMenu(false)}}>Fit Canvas</button><hr/><button onClick={()=>{setModal('settings');setMenu(false)}}>Settings</button>
      </div>}</div></div>
      <div className="flow-wrap" ref={flowWrap}><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={i=>{flow.current=i;setFlowReady(true)}} onNodesChange={onNodesChange} onNodeDragStop={persistPositions} onNodeClick={(_,n)=>setSelected(n.id)}       onPaneClick={()=>{setSelected(null);setSelectedPaths([])}} onMoveEnd={(_,v)=>{if(!canvasReady.current)return;const nextViewport=[v.x,v.y,v.zoom] as [number,number,number];const old=settingsRef.current; if(!isViewportSame(old.viewport,nextViewport))saveSettings({...old,viewport:nextViewport})}} proOptions={{hideAttribution:true}} minZoom={0.05} maxZoom={1.6} selectionOnDrag multiSelectionKeyCode="Shift" panOnDrag><Background variant={BackgroundVariant.Dots} gap={18} size={0.7} color={settings.grid?'#dde4ee':'transparent'}/><Controls showInteractive={false} onFitView={()=>fitCanvas()} className="canvas-controls"/></ReactFlow>{visibleRepos.length===0&&<div className="section-empty"><Folder size={22}/><strong>No repositories in this section</strong><span>Use Organize to add repositories here.</span><button className="secondary-button" onClick={()=>setModal('sections')}>Organize repositories</button></div>}</div>    </>}
    {activeRepo&&<Inspector repo={activeRepo} refresh={()=>refreshRepo(activeRepo.path)} close={()=>setSelected(null)} remove={()=>removeRepo(activeRepo.path)} notify={notify} pull={()=>{if(bulkJobRef.current?.busy){notify('Wait for the current operation to finish');return}setSelected(null);runBulk('pull',{paths:[activeRepo.path],message:'',mode:'all',includeUntracked:true})}} openTransfer={()=>{setModal('transfer')}} openPr={()=>setModal('pr')}/>}
    {searchOpen&&<div className="search-overlay"><div className="search-dialog"><div className="search-input"><Search size={17}/><input autoFocus placeholder="Find a repository…" value={search} onChange={e=>setSearch(e.target.value)}/><button onClick={()=>setSearchOpen(false)}><X size={15}/></button></div><div className="search-results">{repos.filter(r=>r.name.toLowerCase().includes(search.toLowerCase())).slice(0,30).map(r=><button key={r.path} onClick={()=>{selectSection(null);setSelected(r.path);setSelectedPaths([r.path]);setSearchOpen(false);flow.current?.setCenter(settings.positions[r.path]?.[0]||230,settings.positions[r.path]?.[1]||180,{zoom:1,duration:300})}}><Github size={15}/><span>{r.name}</span><small>{sectionFor(r.path)?.name||'Ungrouped'}</small></button>)}</div></div></div>}
    {modal==='bulk'&&<BulkModal action={bulkAction} repos={scopedRepos} close={()=>setModal(null)} start={options=>runBulk(bulkAction,options)}/>}
    {modal==='settings'&&<SettingsModal settings={settings} save={saveSettings} close={()=>setModal(null)} addRepos={addRepos} removeRepo={removeRepo} autoLayout={autoLayout} notify={notify} updater={updater}/>}
    {modal==='sections'&&<SectionsModal settings={settings} save={saveSettings} close={()=>setModal(null)} />}
    {modal==='transfer'&&activeRepo&&<TransferModal repo={activeRepo} close={()=>setModal(null)} notify={notify} refresh={()=>refreshRepo(activeRepo.path)}/>}
    {modal==='pr'&&activeRepo&&<PrModal repo={activeRepo} close={()=>setModal(null)} notify={notify}/>}
    {bulkJob&&<BulkStatus job={bulkJob} retry={()=>runBulk(bulkJob.action,bulkJob,true)} dismiss={()=>setBulkJob(null)}/>}
    {updater.phase==='available'&&!updater.dismissed&&<aside className="update-notice" role="status"><div><strong>git-monitor {updater.availableVersion} is ready</strong><span>A new release is available to install.</span></div><button className="primary-button" onClick={updater.install}>Update</button><button className="update-dismiss" onClick={updater.dismiss} aria-label="Dismiss update notice"><X size={14}/></button></aside>}
    {(updater.phase==='downloading'||updater.phase==='installing')&&<aside className="update-notice" role="status"><RefreshCw size={16} className="spin"/><div><strong>{updater.message}</strong>{updater.progress!==null&&updater.phase==='downloading'&&<span>{updater.progress}% downloaded</span>}</div></aside>}
    {toast&&<div className="toast" role="status">{toast}<button onClick={()=>setToast(null)} aria-label="Dismiss"><X size={14}/></button></div>}
  </main>;
}

function Diff({text}: {text:string}) {let oldLine=0,newLine=0;return <pre className="diff">{text?text.split('\n').map((line,i)=>{const hunk=line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);if(hunk){oldLine=Number(hunk[1]);newLine=Number(hunk[2])}const added=line.startsWith('+')&&!line.startsWith('+++'),removed=line.startsWith('-')&&!line.startsWith('---'),context=line.startsWith(' ');const oldNum=removed||context?oldLine++:'';const newNum=added||context?newLine++:'';return <div key={i} className={added?'diff-add':removed?'diff-remove':hunk?'diff-hunk':''}><span className="diff-num">{oldNum}<b>{newNum}</b></span><code>{line||' '}</code></div>}):<div className="diff-empty">No diff in this view.</div>}</pre>}

function Inspector({repo,refresh,close,remove,notify,pull,openTransfer,openPr}:{repo:Repo;refresh:()=>void;close:()=>void;remove:()=>void;notify:(s:string)=>void;pull:()=>void;openTransfer:()=>void;openPr:()=>void}) {
  const [file,setFile]=useState<string|null>(null),[diff,setDiff]=useState(''),[stagedView,setStagedView]=useState(false),[message,setMessage]=useState(''),[mode,setMode]=useState('all'),[include,setInclude]=useState(true),[amend,setAmend]=useState(false),[busy,setBusy]=useState(false),[section,setSection]=useState<'changes'|'branches'|'history'|'prs'>('changes'),[branches,setBranches]=useState<string[]>([]),[history,setHistory]=useState<string[]>([]),[historyDiff,setHistoryDiff]=useState(''),[prs,setPrs]=useState<any[]>([]),[newBranch,setNewBranch]=useState('');
  useEffect(()=>{setFile(null);setDiff('');setSection('changes')},[repo.path]);
  useEffect(()=>{if(!file)return;api<string>('file_diff',{path:repo.path,file,staged:stagedView}).then(setDiff).catch(e=>notify(errText(e)))},[file,stagedView,repo.path,repo.files]);
  const run=async(fn:()=>Promise<unknown>)=>{setBusy(true);try{await fn();refresh()}catch(e){notify(errText(e))}finally{setBusy(false)}};
  const doCommit=async(push:boolean)=>{setBusy(true);try{const r=await api<OpResult>('commit_repo',{path:repo.path,message,mode,includeUntracked:include,push,amend});notify(r.detail);if(r.status==='success'){setMessage('');refresh()}}catch(e){notify(errText(e))}finally{setBusy(false)}};
  const chooseSection=(s:typeof section)=>{setSection(s);if(s==='branches')api<string[]>('list_branches',{path:repo.path}).then(setBranches).catch(e=>notify(errText(e)));if(s==='history')api<string[]>('repo_history',{path:repo.path}).then(setHistory).catch(e=>notify(errText(e)));if(s==='prs')api<any[]>('github_prs',{path:repo.path}).then(setPrs).catch(e=>notify(errText(e)))};
  const branchAction=(action:string,name:string,other?:string)=>run(async()=>{const r=await api<string>('manage_branch',{path:repo.path,action,name,other});notify(r);setBranches(await api('list_branches',{path:repo.path}))});
  return <aside className="inspector"><div className="inspector-head"><div><small>Repository</small><h2>{repo.name}</h2><span><GitBranch size={13}/>{repo.branch}{repo.upstream&&<em> · {repo.upstream}</em>}</span></div><div className="inspector-head-actions"><button className="stop-tracking" onClick={remove} title="Remove this repository from git-monitor; files stay on disk">Stop tracking</button><button aria-label="Close inspector" className="icon-button" onClick={close}><PanelRightClose size={18}/></button></div></div>
    <div className="inspector-tabs">{(['changes','branches','history','prs'] as const).map(s=><button key={s} className={section===s?'current':''} onClick={()=>chooseSection(s)}>{s==='prs'?'PRs':s[0].toUpperCase()+s.slice(1)}</button>)}</div>
    {section==='changes'&&<><div className="section-label"><strong>{repo.files.length?plural(repo.files.length,'file')+' changed':'Working tree clean'}</strong><div><button onClick={()=>run(async()=>{await api('stage_files',{path:repo.path,files:[],all:true,includeUntracked:true})})} disabled={!repo.files.length||busy}>Stage all</button><button onClick={()=>run(async()=>{await api('unstage_files',{path:repo.path,files:[],all:true})})} disabled={!repo.files.some(f=>f.staged)||busy}>Unstage all</button></div></div>
    <div className="file-list">{repo.files.map(f=><div className={`file-row ${file===f.path?'active':''}`} key={f.path}><button className="file-open" onClick={()=>{setFile(f.path);setStagedView(false)}}><span className={`file-code code-${f.status}`}>{f.status}</span><span title={f.path}>{f.path}</span></button><button className="file-stage" title={f.staged?'Unstage':'Stage'} onClick={()=>run(async()=>{await api(f.staged?'unstage_files':'stage_files',{path:repo.path,files:[f.path],all:false,includeUntracked:true})})}>{f.staged?<Minus size={13}/>:<Plus size={13}/>}</button></div>)}{!repo.files.length&&<div className="quiet-empty"><Check size={19}/>Everything is up to date locally.</div>}</div>
    {file&&<div className="diff-panel"><div className="diff-header"><span title={file}>{file}</span><div><button className={!stagedView?'active':''} onClick={()=>setStagedView(false)}>Working</button><button className={stagedView?'active':''} onClick={()=>setStagedView(true)}>Staged</button></div></div><Diff text={diff}/></div>}
    <div className="commit-box"><input placeholder="Commit message…" value={message} onChange={e=>setMessage(e.target.value)}/><div className="commit-options"><select value={mode} onChange={e=>setMode(e.target.value)} aria-label="Changes to commit"><option value="all">All changes</option><option value="tracked">Tracked files</option><option value="staged">Staged only</option></select><label><input type="checkbox" checked={include} onChange={e=>setInclude(e.target.checked)} disabled={mode!=='all'}/> Include untracked</label><label><input type="checkbox" checked={amend} onChange={e=>setAmend(e.target.checked)}/> Amend last commit</label></div>{amend&&<p className="amend-warning">Rewrites the last unpublished local commit.</p>}<div className="commit-buttons"><button onClick={()=>doCommit(false)} disabled={busy||!repo.files.length||(!message.trim()&&!amend)}>Commit</button><button className="primary-button" onClick={()=>doCommit(true)} disabled={busy||!repo.files.length||(!message.trim()&&!amend)}>Commit & Push <ArrowUp size={14}/></button></div></div></>}
    {section==='branches'&&<div className="inspector-section"><div className="branch-list">{branches.map(b=><div key={b}><GitBranch size={14}/><span>{b}</span>{b===repo.branch&&<small>current</small>}<button onClick={()=>branchAction('switch',b)} disabled={b===repo.branch||busy}>Switch</button><button onClick={()=>branchAction('publish',b)} disabled={busy}>Publish</button>{b!==repo.branch&&<button onClick={()=>branchAction('delete',b)} disabled={busy}>Delete</button>}</div>)}</div><div className="inline-form"><input placeholder="New branch name" value={newBranch} onChange={e=>setNewBranch(e.target.value)}/><button onClick={()=>branchAction('create',newBranch)} disabled={!newBranch||busy}>Create</button></div><button className="text-action" onClick={()=>run(async()=>{await api('fetch_repo',{path:repo.path});notify('Fetched remote branches')})}>Fetch remote branches</button><button className="text-action" onClick={()=>{const next=prompt('Rename current branch to:');if(next)branchAction('rename',repo.branch,next)}}>Rename current branch</button></div>}
    {section==='history'&&<div className="history-list">{history.map(row=>{const [hash,date,...message]=row.split('\t');return <button key={hash} onClick={()=>api<string>('history_detail',{path:repo.path,hash}).then(setHistoryDiff).catch(e=>notify(errText(e)))}><GitCommitHorizontal size={15}/><span><strong>{message.join(' ')}</strong><small>{hash} · {date}</small></span></button>})}{!history.length&&<p>No commits yet.</p>}{historyDiff&&<Diff text={historyDiff}/>}</div>}
    {section==='prs'&&<div className="inspector-section"><button className="primary-button full" onClick={openPr}><GitPullRequest size={15}/> Create Pull Request</button><button className="secondary-button full" onClick={openTransfer}>PR from Different Branch</button><div className="pr-list">{prs.map(pr=><button key={pr.id} onClick={()=>openUrl(pr.html_url)}><GitPullRequest size={15}/><span>{pr.title}<small>#{pr.number} · {pr.state}</small></span></button>)}</div></div>}
    <div className="inspector-footer"><button onClick={()=>run(async()=>{notify(await api<string>('fetch_repo',{path:repo.path}))})} disabled={busy}><RefreshCw size={14}/> Fetch</button><button onClick={pull} disabled={busy}><ArrowDown size={14}/> Pull</button><button onClick={()=>run(async()=>{notify(await api<string>('manage_branch',{path:repo.path,action:'publish',name:repo.branch}))})} disabled={busy}><ArrowUp size={14}/> Push</button></div>
  </aside>;
}

function BulkModal({action,repos,close,start}:{action:BulkAction;repos:Repo[];close:()=>void;start:(options:BulkOptions)=>void}) {
  const eligible=useMemo(()=>repos.filter(r=>action==='commit_push'?r.files.length>0:action==='fetch'?!!r.remote:!!r.upstream&&r.behind>0),[repos,action]);
  const [excludedPaths,setExcludedPaths]=useState<string[]>([]),[message,setMessage]=useState(''),[mode,setMode]=useState('all'),[include,setInclude]=useState(true);
  const paths=eligible.filter(repo=>!excludedPaths.includes(repo.path)).map(repo=>repo.path);
  const title=action==='commit_push'?'Commit & Push All':action==='fetch'?'Fetch All':'Pull All';
  return <div className="modal-backdrop"><div className="dialog bulk-dialog"><button className="close" aria-label="Close" onClick={close}><X size={16}/></button><h2>{title}</h2><p>{action==='commit_push'?'Each selected repository receives its own commit and push.':action==='fetch'?'Download remote updates without changing working files.':'Only branches that can fast-forward safely will update.'}</p>{action==='commit_push'&&<><input className="dialog-input" placeholder="Commit message" value={message} onChange={e=>setMessage(e.target.value)}/><div className="bulk-options"><select value={mode} onChange={e=>setMode(e.target.value)}><option value="all">Commit all changes</option><option value="tracked">Commit tracked changes</option><option value="staged">Staged only</option></select><label><input type="checkbox" checked={include} onChange={e=>setInclude(e.target.checked)} disabled={mode!=='all'}/> Include untracked files</label></div></>}
    <div className="bulk-list">{eligible.map(r=><label key={r.path}><input type="checkbox" checked={paths.includes(r.path)} onChange={e=>setExcludedPaths(p=>e.target.checked?p.filter(x=>x!==r.path):[...p,r.path])}/><span className="bulk-repo">{r.name}</span><small>{action==='commit_push'?plural(r.files.length,'file'):r.upstream||r.remote}</small></label>)}{!eligible.length&&<div className="quiet-empty">No repositories need this action.</div>}</div>
    <div className="dialog-actions"><button onClick={close}>Cancel</button><button className="primary-button" disabled={!paths.length||(action==='commit_push'&&!message.trim())} onClick={()=>start({paths,message,mode,includeUntracked:include})}>{title}</button></div></div></div>;
}

function BulkStatus({job,retry,dismiss}:{job:BulkJob;retry:()=>void;dismiss:()=>void}) {
  const [expanded,setExpanded]=useState(false);
  const failed=job.results.filter(r=>r.status==='failed').length;
  const label=job.action==='commit_push'?'Commit & push':job.action==='fetch'?'Fetch':'Pull';
  const summary=job.busy?`${job.completed} of ${job.pending} completed`:job.error?'Operation interrupted':failed?`${failed} failed · ${job.results.length-failed} completed`:`${job.results.length} completed`;
  return <aside className="bulk-status" aria-label={`${label} status`}>
    <div className="bulk-status-head"><span className={`bulk-status-icon ${job.busy?'spin':''}`}>{job.busy?<RefreshCw size={15}/>:failed||job.error?<X size={15}/>:<Check size={15}/>}</span><div><strong>{label} {job.busy?'in progress':job.error?'interrupted':'complete'}</strong><small role="status" aria-live="polite">{summary}</small></div>{!job.busy&&<button className="bulk-status-close" onClick={dismiss} aria-label="Dismiss operation status"><X size={14}/></button>}</div>
    {job.busy&&<div className="bulk-status-track" role="progressbar" aria-valuemin={0} aria-valuemax={job.pending} aria-valuenow={job.completed}><span style={{width:`${job.pending?job.completed/job.pending*100:0}%`}}/></div>}
    {job.error&&<p className="bulk-status-error">{job.error}</p>}
    {(job.results.length>0||job.error)&&<div className="bulk-status-actions"><button onClick={()=>setExpanded(value=>!value)} aria-expanded={expanded}>{expanded?'Hide details':'Show details'} <ChevronDown size={13}/></button>{!job.busy&&failed>0&&<button onClick={retry}>Retry failed</button>}</div>}
    {expanded&&<div className="bulk-status-results">{job.results.map(r=><div key={r.path}><strong title={r.path}>{nameOf(r.path)}</strong><span className={r.status}>{r.status}</span><small>{r.detail}</small></div>)}</div>}
  </aside>;
}

function SettingsModal({settings,save,close,addRepos,removeRepo,autoLayout,notify,updater}:{settings:Settings;save:(s:Settings)=>Promise<void>;close:()=>void;addRepos:()=>void;removeRepo:(s:string)=>void;autoLayout:(layout:string)=>void;notify:(s:string)=>void;updater:Updater}) {
  const [gitVersion,setGitVersion]=useState('Checking…'),[connected,setConnected]=useState(false),[device,setDevice]=useState<DeviceCode|null>(null),[connecting,setConnecting]=useState(false);
  useEffect(()=>{api<string>('git_version').then(setGitVersion).catch(e=>setGitVersion(errText(e)));api<boolean>('github_connected').then(setConnected)},[]);
  const connect=async()=>{try{setConnecting(true);const code=await api<DeviceCode>('github_begin');setDevice(code);await openUrl(code.verificationUri);await api('github_finish',{code});setConnected(true);setDevice(null);notify('GitHub connected')}catch(e){notify(errText(e))}finally{setConnecting(false)}};
  return <div className="modal-backdrop"><div className="dialog settings-dialog"><button className="close" aria-label="Close" onClick={close}><X size={16}/></button><h2>Settings</h2><div className="settings-group"><h3>Repositories</h3>{settings.repos.map(r=><div className="settings-root" key={r}><Github size={15}/><span title={r}>{r}</span><button onClick={()=>removeRepo(r)} aria-label={`Stop tracking ${nameOf(r)}`} title="Remove from git-monitor; files stay on disk">Stop tracking</button></div>)}<button className="text-action" onClick={addRepos}><Plus size={14}/> Add repositories</button></div>
  <div className="settings-group"><h3>Canvas</h3><label>Layout<select value={settings.layout} onChange={e=>autoLayout(e.target.value)}><option value="horizontal">Horizontal</option><option value="tree">Tree</option><option value="radial">Radial</option></select></label><label>Appearance<select value={settings.appearance} onChange={e=>save({...settings,appearance:e.target.value})}><option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option></select></label><label><input type="checkbox" checked={settings.grid} onChange={e=>save({...settings,grid:e.target.checked})}/> Show canvas dots</label><label><input type="checkbox" checked={settings.autoMonitor} onChange={e=>save({...settings,autoMonitor:e.target.checked})}/> Monitor file changes</label></div>
  <div className="settings-group"><h3>Integrations</h3><div className="integration-row"><span><GitBranch size={15}/> Git <small>{gitVersion}</small></span></div><div className="integration-row"><span><Github size={15}/> GitHub <small>{connected?'Connected':'Not connected'}</small></span>{connected?<button onClick={async()=>{try{await api('github_disconnect');setConnected(false)}catch(e){notify(errText(e))}}}>Disconnect</button>:<button onClick={connect} disabled={connecting}>{connecting?'Connecting…':'Connect'}</button>}</div>{device&&<p className="device-code">Enter code <strong>{device.userCode}</strong> at GitHub in your browser.</p>}</div>
  <div className="settings-group"><h3>App updates</h3><div className="integration-row"><span>git-monitor <small>{updater.version?`v${updater.version}`:'Checking version…'}</small></span><button onClick={()=>updater.checkForUpdates(true)} disabled={updater.phase==='checking'||updater.phase==='downloading'||updater.phase==='installing'}>{updater.phase==='checking'?'Checking…':'Check for updates'}</button></div>{updater.phase==='available'&&<div className="integration-row"><span>Version {updater.availableVersion} available</span><button onClick={updater.install}>Download and install</button></div>}{updater.message&&<p className={`update-message ${updater.phase==='error'?'failed':''}`} role="status">{updater.message}</p>}</div><div className="dialog-actions"><button className="primary-button" onClick={close}>Done</button></div></div></div>;
}

function SectionsModal({settings,save,close}:{settings:Settings;save:(s:Settings)=>Promise<void>;close:()=>void}) {
  const [name,setName]=useState('');
  const [editing,setEditing]=useState<string|null>(settings.sections[0]?.id||null);
  const [draft,setDraft]=useState(settings.sections[0]?.name||'');
  const section=settings.sections.find(s=>s.id===editing);
  const create=async()=>{const trimmed=name.trim();if(!trimmed||settings.sections.some(s=>s.name.toLowerCase()===trimmed.toLowerCase()))return;const id=crypto.randomUUID();await save({...settings,sections:[...settings.sections,{id,name:trimmed,paths:[]}]});setEditing(id);setDraft(trimmed);setName('')};
  const update=async(next:Section[])=>{await save({...settings,sections:next})};
  const toggle=async(path:string,checked:boolean)=>{if(!section)return;await update(settings.sections.map(s=>({...s,paths:s.id===section.id?(checked?[...s.paths,path]:s.paths.filter(p=>p!==path)):s.paths.filter(p=>p!==path)})))};
  const rename=async()=>{if(!section)return;const trimmed=draft.trim();if(!trimmed||settings.sections.some(s=>s.id!==section.id&&s.name.toLowerCase()===trimmed.toLowerCase()))return;await update(settings.sections.map(s=>s.id===section.id?{...s,name:trimmed}:s))};
  const remove=async()=>{if(!section)return;await update(settings.sections.filter(s=>s.id!==section.id));const remaining=settings.sections.filter(s=>s.id!==section.id);setEditing(remaining[0]?.id||null);setDraft(remaining[0]?.name||'')};
  return <div className="modal-backdrop"><div className="dialog sections-dialog"><button className="close" aria-label="Close" onClick={close}><X size={16}/></button><h2>Organize repositories</h2><p>Create sections for related repositories, then choose which repositories belong in each one.</p><div className="section-create"><input className="dialog-input" value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')create()}} placeholder="New section name" aria-label="New section name"/><button className="primary-button" onClick={create} disabled={!name.trim()||settings.sections.some(s=>s.name.toLowerCase()===name.trim().toLowerCase())}><Plus size={14}/> Create</button></div><div className="section-editor"><div className="section-editor-list">{settings.sections.map(s=><button className={editing===s.id?'current':''} key={s.id} onClick={()=>{setEditing(s.id);setDraft(s.name)}}><Folder size={14}/><span>{s.name}</span><small>{s.paths.length}</small></button>)}{!settings.sections.length&&<p>Create your first section.</p>}</div>{section&&<div className="section-editor-main"><div className="section-name-row"><input value={draft} onChange={e=>setDraft(e.target.value)} onBlur={rename} onKeyDown={e=>{if(e.key==='Enter')rename()}} aria-label="Section name"/><button onClick={remove} title="Delete section" aria-label={`Delete ${section.name}`}><X size={15}/></button></div><div className="section-repo-list">{settings.repos.map(path=><label key={path}><input type="checkbox" checked={section.paths.includes(path)} onChange={e=>toggle(path,e.target.checked)}/><span><strong>{nameOf(path)}</strong><small title={path}>{path}</small></span></label>)}{!settings.repos.length&&<p>Add repositories to organize them.</p>}</div></div>}</div><div className="dialog-actions"><button className="primary-button" onClick={close}>Done</button></div></div></div>;
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
