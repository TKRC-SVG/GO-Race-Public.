/* A fixed race and pilot can follow the same account across devices. */
const selectionDataKeys=['goRaceName','goRaceKey','goRaceCategory','goRaceCategories','goRaceStatus','goRaceDate','goLiveTimingUrl','goActivePilot','goPilots','goEverlapsUrl','goHistoryRemoved'];
const selectionKeys=[...selectionDataKeys,'goEverlapsByRace','goSelectionPinned'];
const accountKeys=[...selectionKeys,'goUploadsByRace','goPhase'];
let accountRevision=0,accountLoaded=false,accountBusy=null,accountTimer=null,changeSequence=Date.now();
let pendingAccountChanges=safeJSON('goSyncPending',{});
function syncStatus(message,status='pending'){const el=$('#syncStatus');el.textContent=message;el.dataset.state=status}
function accountSnapshot(){const values={};for(const key of accountKeys){const value=localStorage.getItem(key);if(value!==null)values[key]=value}return values}
function parseMap(value){try{const parsed=JSON.parse(value||'{}');return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{}}catch{return{}}}
function mergeDocuments(remote,local){
  const output=parseMap(remote);
  for(const [race,files] of Object.entries(parseMap(local))){
    if(['__proto__','constructor','prototype'].includes(race)||!files||typeof files!=='object')continue;
    output[race]={...output[race]};
    for(const [kind,file] of Object.entries(files))if(file&&typeof file==='object'&&!['__proto__','constructor','prototype'].includes(kind)){
      const prior=output[race][kind];if(!prior||String(file.addedAt||'')>String(prior.addedAt||''))output[race][kind]=file;
    }
  }
  return JSON.stringify(output);
}
function mergeAccountValues(remote,local,changes){
  const values={...remote};
  if(changes.selection){
    if(local.goSelectionPinned==='1'){
      for(const key of selectionKeys){if(key in local)values[key]=local[key];else delete values[key]}
    }else{
      for(const key of selectionDataKeys)delete values[key];
      values.goHistoryRemoved='1';values.goSelectionPinned='0';
    }
    values.goEverlapsByRace=JSON.stringify({...parseMap(remote?.goEverlapsByRace),...parseMap(local.goEverlapsByRace)});
  }
  if(changes.documents)values.goUploadsByRace=mergeDocuments(remote?.goUploadsByRace,local.goUploadsByRace);
  if(changes.phase)values.goPhase=local.goPhase||'entrenamientos';
  return values;
}
function persistPendingChanges(){localStorage.setItem('goSyncPending',JSON.stringify(pendingAccountChanges))}
function markCloudChange(group='selection',force=false){
  if(group==='selection'&&!force&&localStorage.getItem('goSelectionPinned')!=='1')return;
  pendingAccountChanges[group]=++changeSequence;persistPendingChanges();
  syncStatus('Sincronizando Mac e iPhone…');clearTimeout(accountTimer);accountTimer=setTimeout(syncAccountState,350);
}
function applyAccountValues(values){
  const localPinned=localStorage.getItem('goSelectionPinned')==='1';
  if(values.goSelectionPinned!=='1'){
    values={...values,goSelectionPinned:'0',goHistoryRemoved:'1'};
    if(localPinned){for(const key of selectionDataKeys)delete values[key]}
    else for(const key of selectionDataKeys){const current=localStorage.getItem(key);if(current===null)delete values[key];else values[key]=current}
    values.goHistoryRemoved='1';
  }
  const before=accountSnapshot();
  const selectionChanged=selectionKeys.some(key=>before[key]!==values[key]);
  if(selectionChanged&&before.goRaceKey)localStorage.setItem('goDeviceBackup',JSON.stringify({savedAt:new Date().toISOString(),values:before}));
  for(const key of accountKeys){if(key in values)localStorage.setItem(key,values[key]);else localStorage.removeItem(key)}
  const raceChanged=state.raceKey!==(values.goRaceKey||'')||before.goEverlapsByRace!==values.goEverlapsByRace||before.goRaceCategories!==values.goRaceCategories;
  if(raceChanged)stopEverlapsLive();
  try{state.raceCategories=JSON.parse(values.goRaceCategories||'[]');if(!Array.isArray(state.raceCategories))state.raceCategories=[];}catch{state.raceCategories=[];}
  state.raceName=values.goRaceName||'';state.raceKey=values.goRaceKey||'';state.raceCategory=values.goRaceCategory||'';
  state.raceStatus=values.goRaceStatus||'';state.raceDate=values.goRaceDate||'';state.liveTimingUrl=values.goLiveTimingUrl||'';
  try{state.pilots=JSON.parse(values.goPilots||'[]');if(!Array.isArray(state.pilots))state.pilots=[];}catch{state.pilots=[];}if(!state.pilots.length&&values.goActivePilot)state.pilots=[values.goActivePilot];state.activePilot=state.pilots[0]||'';state.isExample=false;
  state.uploadsByRace=parseMap(values.goUploadsByRace);state.uploads=uploadsForRace(state.raceKey,linkForRace());
  localStorage.setItem('goUploads',JSON.stringify(state.uploads));
  if(values.goPhase&&phaseLabels[values.goPhase])setPhase(values.goPhase);
  if(selectionChanged||raceChanged)applyRaceView();
  renderStatuses();renderPilots();
}
async function accountRequest(method='GET',body){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetch('/api/account-state',{method,credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{'Accept':'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    if(!response.ok&&response.status!==409)throw new Error(response.status===401?'Inicia sesión con la misma cuenta en ambos dispositivos.':'Sin conexión · cambios guardados aquí');
    const data=await response.json();if(!Number.isSafeInteger(data.revision)||data.revision<0)throw new Error('Sincronización pendiente');
    return {data,conflict:response.status===409};
  }finally{clearTimeout(timer)}
}
async function syncAccountState(){
  if(accountBusy)return accountBusy;
  accountBusy=(async()=>{
    await Promise.resolve();
    try{
      if(!navigator.onLine)throw new Error('Sin conexión · cambios guardados aquí');
      let {data:remote}=await accountRequest();
      const firstLoad=!accountLoaded,local=accountSnapshot();
      if(firstLoad&&!localStorage.getItem('goSyncMigrated')){
        // Preserve references from both devices; an existing cloud selection wins.
        if(Object.keys(parseMap(local.goUploadsByRace)).length)pendingAccountChanges.documents=++changeSequence;
        if(!remote.values&&local.goSelectionPinned==='1'&&local.goRaceKey)pendingAccountChanges.selection=++changeSequence;
        persistPendingChanges();
      }
      if(remote.values&&(firstLoad||remote.revision!==accountRevision))applyAccountValues(mergeAccountValues(remote.values,accountSnapshot(),pendingAccountChanges));
      accountRevision=remote.revision;accountLoaded=true;
      for(let attempt=0;attempt<3&&Object.keys(pendingAccountChanges).length;attempt++){
        const changes={...pendingAccountChanges},values=mergeAccountValues(remote.values||{},accountSnapshot(),changes);
        const result=await accountRequest('PUT',{baseRevision:remote.revision,values});
        remote=result.data;accountRevision=remote.revision;
        if(result.conflict)continue;
        for(const [group,sequence] of Object.entries(changes))if(pendingAccountChanges[group]===sequence)delete pendingAccountChanges[group];
        if(localStorage.getItem('goSelectionPinned')!=='1'&&!('selection' in pendingAccountChanges))localStorage.removeItem('goSelectionClearPending');
        persistPendingChanges();
        applyAccountValues(mergeAccountValues(remote.values,accountSnapshot(),pendingAccountChanges));
      }
      localStorage.setItem('goSyncMigrated','1');
      if(Object.keys(pendingAccountChanges).length){syncStatus('Sincronización pendiente');clearTimeout(accountTimer);accountTimer=setTimeout(syncAccountState,1500)}
      else syncStatus(localStorage.getItem('goSelectionPinned')==='1'?'Dispositivos sincronizados · circuito y piloto fijados':'Dispositivos sincronizados · marca «Dejarlo fijo» para guardar la selección','ready');
    }catch(error){syncStatus(error.message||'Sincronización pendiente','error')}
    finally{accountBusy=null}
  })();
  return accountBusy;
}
async function flushCloudState(){
  await syncAccountState();
  if(Object.keys(pendingAccountChanges).length)await syncAccountState();
  return !Object.keys(pendingAccountChanges).length;
}
let refreshingRaceData=false;
function raceIsInProgress(){return isActiveLivePresentation()&&!raceIsScheduledAhead()}
async function refreshRaceData(){
  if(refreshingRaceData||!navigator.onLine||document.visibilityState==='hidden'||!live.eventId||!raceIsInProgress())return;
  refreshingRaceData=true;
  try{await loadEverlapsSnapshot(live.eventId,live.snapshotToken,state.raceKey)}finally{refreshingRaceData=false}
}
function resumeAccount(){syncAccountState();refreshRaceData();if('serviceWorker' in navigator)navigator.serviceWorker.getRegistration().then(reg=>reg?.update()).catch(()=>{})}
syncAccountState();
setInterval(()=>{if(document.visibilityState!=='hidden')syncAccountState()},15000);
setInterval(refreshRaceData,30000);
window.addEventListener('focus',resumeAccount);
window.addEventListener('online',resumeAccount);
window.addEventListener('pageshow',resumeAccount);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')resumeAccount()});
