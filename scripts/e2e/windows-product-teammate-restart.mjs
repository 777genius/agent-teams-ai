#!/usr/bin/env node
// Product-driven Windows teammate E2E. Real published orchestrator and IPC;
// only the model HTTP endpoint is local synthetic. No paid vendor inference.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {createServer} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareNativeDesktopEnvironment} from './opencode-native-desktop-environment.ts';
import {startGroupChatModelServer} from './group-chat-model-server.ts';
import {CdpClient} from './comment-notification/cdp.mjs';
import {processes, ownedTree, sameIdentity, powershell} from './opencode-diagnostics/platform.mjs';
assert.equal(process.platform,'win32','Native Windows runner required');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const f=await prepareNativeDesktopEnvironment();
const out=process.env.WINDOWS_PRODUCT_CONSOLE_EVIDENCE||path.join(os.tmpdir(),'windows-product-console-'+randomUUID());
await mkdir(out,{recursive:true});
const cli=path.join(repo,'resources/runtime/claude-multimodel.exe');
const lock=JSON.parse(await readFile(path.join(repo,'runtime.lock.json'),'utf8'));
assert((await stat(cli)).isFile(),'Pinned release runtime not staged');
assert.equal((await readFile(path.join(repo,'resources/runtime/VERSION'),'utf8')).trim(),lock.version);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const literal=value=>JSON.stringify(value);
const quoted=value=>"'"+value.replaceAll("'","''")+"'";
const token='WIN_TOOL_'+randomUUID().replaceAll('-','');
const psFile=path.join(f.projectPath,'owned-tool.ps1');
const proofFile=path.join(f.projectPath,'owned-tool.json');
await writeFile(psFile,[
"$ErrorActionPreference='Stop'",
'Set-Location -LiteralPath '+quoted(f.projectPath),
'$cmd=(& cmd.exe /d /s /c "echo owned-cmd").Trim()',
"if($LASTEXITCODE -ne 0 -or $cmd -ne 'owned-cmd'){throw 'cmd failed'}",
'$git=(& git.exe --version).Trim()',
"if($LASTEXITCODE -ne 0 -or !$git.StartsWith('git version')){throw 'git failed'}",
"Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CProof { [DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr p); }'",
'$h=[CProof]::GetConsoleWindow()',
'$visible=$h -ne [IntPtr]::Zero -and [CProof]::IsWindowVisible($h)',
'$proof=@{token='+quoted(token)+';pid=$PID;cmd=$cmd;git=$git;visible=$visible;launchedAt=(Get-Date).ToUniversalTime().ToString("o")}',
'$receiptTemp = '+quoted(proofFile+'.partial'),
'[IO.File]::WriteAllText($receiptTemp,($proof|ConvertTo-Json -Compress))',
// Publish only complete JSON; the reader polls for the final path.
'[IO.File]::Move($receiptTemp,'+quoted(proofFile)+')',
// Block well beyond the bounded Stop+retirement window; only product Stop may retire this tool.
'while ($true) { Start-Sleep -Seconds 30 }'
].join('\r\n')+'\r\n');
const command='powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+psFile.replaceAll('"','')+'"';
let toolRequests=0;
let toolsAvailable=[];
const model=await startGroupChatModelServer(path.join(f.root,'model.ndjson'),body=>{
const text=JSON.stringify(body.messages??[]);
if(!text.includes(token))return undefined;
const names=(Array.isArray(body.tools)?body.tools:[]).map(x=>String(x.function?.name??x.name??''));
toolsAvailable=names.slice(0,90);
const bash=names.find(name=>/(?:^|[_-])bash$/i.test(name));
if(!bash)return{id:'none_'+randomUUID().replaceAll('-',''),text:'NO_SHELL_TOOL'};
if(toolRequests++===0)return{id:'toolu_'+randomUUID().replaceAll('-',''),name:bash,
input:{command,description:'Isolated product Windows console verification',timeout:600000}};
return{id:'done_'+randomUUID().replaceAll('-',''),text:'OWNED_TOOL_DISPATCHED'};
});
const env={...f.env,CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH:cli,
ANTHROPIC_BASE_URL:model.baseUrl,ANTHROPIC_API_KEY:'synthetic-owned-key',
NODE_BINARY:process.execPath,CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS:'180000',
CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS:'180000',
AGENT_TEAMS_DISABLE_SOURCEMAPS:'1',pnpm_config_verify_deps_before_run:'false'};
await writeFile(path.join(env.CLAUDE_CONFIG_DIR,'settings.json'),
JSON.stringify({env:{ANTHROPIC_BASE_URL:model.baseUrl,ANTHROPIC_API_KEY:'synthetic-owned-key'}}));
await writeFile(path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT,'agent-teams-config.json'),
JSON.stringify({general:{appLocale:'en',agentLanguage:'en',theme:'dark',defaultTab:'teams'}}));
await mkdir(path.join(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT,'projects'),{recursive:true});
const port=await new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);
s.listen(0,'127.0.0.1',()=>{const a=s.address();s.close(e=>e?reject(e):resolve(a.port));});});
const app=spawn(process.env.ComSpec||'cmd.exe',['/d','/s','/c','pnpm dev:mcp --inspect='+port],
{cwd:repo,env,windowsHide:true,detached:false,stdio:['ignore','pipe','pipe']});
let logs='';
for(const stream of [app.stdout,app.stderr])stream?.on('data',b=>{logs=(logs+b.toString()).slice(-28000);});
let client,inspector,teamCreated=false,workerPid,toolPid,originalLauncherIdentity;
const team=f.teamName;
const result={schemaVersion:1,kind:'real-windows-product-synthetic-model',
team,realProductTeammateLaunch:false,realProviderInference:false,success:false,phase:'launch'};
const save=()=>writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2)+'\n');
async function until(label,read,timeout=180000){const deadline=Date.now()+timeout;
while(Date.now()<deadline){try{const v=await read();if(v)return v;}catch(e){
if(!/execution context was destroyed|cannot find.*execution context/i.test(String(e)))throw e;
}await delay(250);}throw new Error('Timeout: '+label);}
async function api(exp){assert(client);return client.evaluate('(async()=>await ('+exp+'))()');}
async function main(exp){assert(inspector);const r=await inspector.send('Runtime.evaluate',
{expression:exp,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error('Main inspector error');return r.result.value;}
function ownedAlive(pid,tag){assert(Number.isSafeInteger(pid)&&pid>0);
const ps="$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = "+pid+
"' -ErrorAction Stop; if($p -and $p.CommandLine -like '*"+tag+"*'){'alive'}else{'gone'}";
const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],
{windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:16384});
assert(!r.error&&r.status===0,'CIM failure; process state unknown');
const x=r.stdout.trim();assert(x==='alive'||x==='gone');return x==='alive';}
// A census that filters missing CreationDate is sufficient for positive
// ownership, not for negative retirement proof. Query the original target
// PIDs without that filter and refuse an unreadable target birth.
function strictTargetCensus(identities){
  const ids=identities.map(p=>p.pid);
  assert(ids.length>0&&ids.every(pid=>Number.isSafeInteger(pid)&&pid>0));
  const filter=ids.map(pid=>'ProcessId = '+pid).join(' OR ');
  const rows=JSON.parse(powershell(
    '$rows=@(Get-CimInstance Win32_Process -Filter "'+filter+'" -ErrorAction Stop | ForEach-Object {'+
    ' [pscustomobject]@{pid=[int]$_.ProcessId; birth=$(if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString("o")} else {$null})} });'+
    ' ConvertTo-Json -InputObject $rows -Compress'
  ).replace(/^\uFEFF/,'').trim());
  assert(Array.isArray(rows),'Native target census is not an array');
  const seen=new Set();
  for(const row of rows){
    assert(row&&ids.includes(row.pid)&&!seen.has(row.pid)&&typeof row.birth==='string'&&
      Number.isFinite(Date.parse(row.birth)),'Native target identity unavailable');
    seen.add(row.pid);
  }
  return rows;
}
function originalBirthsRetired(identities){
  const census=strictTargetCensus(identities);
  return identities.every(expected=>!census.some(p=>
    p.pid===expected.pid&&p.birth===expected.birth));
}
try{
originalLauncherIdentity=await until('original cmd launcher native identity',async()=>{
  const observed=processes().find(p=>p.pid===app.pid);
  return observed?.birth?observed:false;
},30000);
const url=await until('owned Main inspector',async()=>{const m=/Debugger listening on (ws:\/\/(?:127\.0\.0\.1|localhost):\d+\/[a-z0-9-]+)/i.exec(logs);
return m&&m[1].includes(':'+port+'/')?m[1]:false;},150000);
inspector=await CdpClient.connect(url);
result.mainPid=await main('process.pid');
client=await until('owned Electron renderer',async()=>{const p=/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(logs)?.[1];
if(!p)return false;try{const targets=await fetch('http://127.0.0.1:'+p+'/json/list').then(r=>r.json());
const t=targets.find(x=>x.type==='page'&&x.url?.startsWith('http://localhost:'));
return t?CdpClient.connect(t.webSocketDebuggerUrl):false;}catch{return false;}},150000);
await client.send('Page.enable');
await until('app startup',async()=>api('window.electronAPI?.startup?.getStatus().then(s=>s.ready)').catch(()=>false));
result.phase='create-real-team';
const request={projectContextMode:'shared',teamName:team,cwd:f.projectPath,providerId:'anthropic',model:'claude-sonnet-4-6',
skipPermissions:true,syncModelsWithLead:false,
prompt:'TEST project only. Never access other paths or install packages.',
members:[{name:'worker',providerId:'anthropic',model:'claude-sonnet-4-6',role:'Test worker'}]};
await client.evaluate('(()=>{window.__winTeam={done:false};window.electronAPI.teams.createTeam('+
literal(request)+').then(v=>{window.__winTeam={done:true,value:v}},e=>{window.__winTeam={done:true,error:String(e)}});return true;})()');
const creation=await until('actual createTeam IPC',()=>client.evaluate('(()=>{const x=window.__winTeam;if(!x?.done)return null;if(x.error)throw Error(x.error);return x.value;})()'),240000);
assert(typeof creation?.runId==='string'&&creation.runId.length>0,'No product createTeam runId');
teamCreated=true;
result.originalRunId=creation.runId;
result.phase='real-member-ready';
// A worker can bootstrap before provisioning promotes the owning run to ready.
// Observe both public IPC surfaces within the existing launch deadline, not a fixed delay.
const snapshot=await until('ready tracked team and live worker in runtime snapshot',async()=>{
const progress=await api('window.electronAPI.teams.getProvisioningStatus('+literal(creation.runId)+')');
assert.equal(progress?.runId,creation.runId,'Provisioning status belongs to a different launch');
result.provisioningStateBeforeRestart=progress.state;
assert(!['failed','cancelled','disconnected'].includes(progress.state),
  'Original team provisioning ended before restart: '+progress.state);
const x=await api('window.electronAPI.teams.getTeamAgentRuntime('+literal(team)+')');
const m=x?.members?.worker;
if(x?.runId!==creation.runId||!m?.alive||!m?.runtimePid||!m.historicalBootstrapConfirmed)return false;
result.teamRunAliveBeforeRestart=await api('window.electronAPI.teams.processAlive('+literal(team)+')');
result.aliveTeamNamesBeforeRestart=await api('window.electronAPI.teams.aliveList()');
assert(Array.isArray(result.aliveTeamNamesBeforeRestart),'Product active team inventory unreadable');
return progress.state==='ready'&&result.teamRunAliveBeforeRestart===true&&
  result.aliveTeamNamesBeforeRestart.includes(team)?x:false;
},240000);
assert.equal(snapshot.runId,creation.runId,'Original runtime snapshot belongs to a different launch');
assert.equal(snapshot.members.worker.backendType,'process','Original member must use direct process backend');
assert.equal(snapshot.members.worker.providerId,'anthropic','Original member provider differs from request');
assert.equal(snapshot.members.worker.runtimeModel,'claude-sonnet-4-6','Original member model differs from request');
workerPid=snapshot.members.worker.runtimePid;
assert(ownedAlive(workerPid,team),'Worker not bound to original test team');
const originalWorkerIdentity=processes().find(p=>p.pid===workerPid);
assert(originalWorkerIdentity?.birth,'Original native worker birth identity unavailable');
result.originalBootstrapConfirmed=true;
result.realProductTeammateLaunch=true;result.initialWorkerPid=workerPid;
// Preserve the public runtime evidence before the actual restart IPC. No raw
// process command lines or model data are included in the proof.
result.restartRuntimeEvidence={
  pid:snapshot.members.worker.pid??null,
  runtimePid:workerPid,
  pidSource:snapshot.members.worker.pidSource??null,
  backendType:snapshot.members.worker.backendType,
  livenessKind:snapshot.members.worker.livenessKind??null,
  restartable:snapshot.members.worker.restartable??null,
  birth:originalWorkerIdentity.birth
};
// A persisted worker PID is not proof of an active tracked team run. The
// product restart API explicitly requires getAliveRunId(teamName).
result.teamRunAliveBeforeRestart=await api('window.electronAPI.teams.processAlive('+literal(team)+')');
result.aliveTeamNamesBeforeRestart=await api('window.electronAPI.teams.aliveList()');
assert.equal(result.teamRunAliveBeforeRestart,true,
  'Worker is alive but the product no longer tracks an active run; manual restart is unsafe');
assert(result.aliveTeamNamesBeforeRestart.includes(team),
  'Team is absent from product active-run inventory before manual restart');
result.phase='real-manual-restart';
await client.evaluate('(()=>{window.__winRestart={done:false};window.electronAPI.teams.restartMember('+
literal(team)+',"worker").then(v=>{window.__winRestart={done:true,value:v}},e=>{window.__winRestart={done:true,error:String(e)}});return true;})()');
await until('manual restart IPC',()=>client.evaluate('(()=>{const x=window.__winRestart;if(!x?.done)return null;if(x.error)throw Error(x.error);return true;})()'),240000);
const restarted=await until('new live direct worker PID',async()=>{const x=await api('window.electronAPI.teams.getTeamAgentRuntime('+literal(team)+')');
const m=x?.members?.worker,p=m?.runtimePid;
return x?.runId===creation.runId&&m?.alive&&m?.historicalBootstrapConfirmed&&p&&p!==workerPid?x:false;},180000);
assert.equal(restarted.runId,creation.runId,'Restart changed the owning team run');
workerPid=restarted.members.worker.runtimePid;
assert.equal(restarted.members.worker.backendType,'process','Direct process restart not exercised');
assert(ownedAlive(workerPid,team),'Original restarted worker unavailable');
const restartedWorkerIdentity=processes().find(p=>p.pid===workerPid);
assert(restartedWorkerIdentity?.birth,'Restarted worker native birth identity unavailable');
result.restartWorkerPid=workerPid;
// Command-line visibility can become unreadable while a Win32 process remains
// live; only the original PID+birth disappearing from a full census proves retirement.
assert(originalBirthsRetired([originalWorkerIdentity]),
  'Original pre-restart worker birth survived replacement');
result.originalWorkerRetiredDuringRestart=true;
result.phase='real-tool-turn';
// The inspector runs in Main's global context, where bare require may be
// undefined; use the entry-module fallback and focus only our own window.
const nativeFocusBefore=await until('focused owned Electron window',async()=>main(`(()=>{
const req=typeof require==='function'?require:process.mainModule?.require?.bind(process.mainModule);
if(typeof req!=='function')throw Error('Electron Main module resolver unavailable');
const win=req('electron').BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('http://localhost:'));
if(!win)throw Error('Owned Electron window missing');
if(!win.isFocused())win.focus();
if(!globalThis.__winRestartFocus){
  globalThis.__winRestartFocus={blur:0};
  win.on('blur',()=>{globalThis.__winRestartFocus.blur++;});
}
return win.isFocused();
})()`),30000);
const focusBefore=await client.evaluate('document.hasFocus()');
assert(nativeFocusBefore&&focusBefore,'Could not establish focused owned Electron window');
await api('window.electronAPI.teams.sendMessage('+literal(team)+','+
literal({member:'worker',from:'user',text:token+' Execute the current local TEST model shell command.'})+')');
const proof=await until('original shell PID and tool receipt',async()=>{try{return JSON.parse(await readFile(proofFile,'utf8'));}
catch(e){if(e?.code==='ENOENT')return false;throw e;}},180000);
assert.equal(proof.token,token);assert.equal(proof.cmd,'owned-cmd');
assert.match(proof.git,/^git version /);
assert.equal(proof.visible,false,'Visible Windows console window was created');
assert.equal(toolRequests,1,'Unexpected synthetic-model tool dispatches');
toolPid=proof.pid;assert(ownedAlive(toolPid,psFile),'Original tool process not alive');
// A tool receipt proves subprocess execution, not which agent owned it.
// Verify the exact worker birth still exists and the actual PowerShell PID
// descends from it through a current, birth-ordered native process tree.
const nativeSnapshot=processes();
sameIdentity(restartedWorkerIdentity,nativeSnapshot.find(p=>p.pid===workerPid));
const workerDescendants=ownedTree(nativeSnapshot,restartedWorkerIdentity);
const originalToolIdentity=workerDescendants.find(p=>p.pid===toolPid);
assert(originalToolIdentity?.birth,'PowerShell tool is not a birth-bound descendant of the restarted teammate');
result.toolOwnedByRestartedWorker={
  workerPid,workerBirth:restartedWorkerIdentity.birth,
  toolPid,toolBirth:originalToolIdentity.birth
};
const focusAfter=await client.evaluate('document.hasFocus()');
const nativeFocusAfter=await main(`(()=>{
const req=typeof require==='function'?require:process.mainModule?.require?.bind(process.mainModule);
if(typeof req!=='function')throw Error('Electron Main module resolver unavailable');
const win=req('electron').BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('http://localhost:'));
return Boolean(win?.isFocused()&&globalThis.__winRestartFocus?.blur===0);
})()`);
assert(focusAfter&&nativeFocusAfter,'Owned Electron lost focus during real tool execution');
result.focus={focusBefore,nativeFocusBefore,focusAfter,nativeFocusAfter};
result.tool=proof;result.realWindowsToolExecuted=true;
await client.screenshot(path.join(out,'real-team.png'));
result.phase='normal-product-stop';
// The native tool has a 10-minute execution cap. Its age must leave enough
// room for the entire 150s Stop IPC plus 60s retirement check, with margin.
assert(Number.isFinite(Date.parse(proof.launchedAt)) &&
  Date.now()-Date.parse(proof.launchedAt)<300000,
  'Tool lifetime too old to distinguish product Stop from tool timeout');
assert(ownedAlive(workerPid,team),'Original worker died before product Stop');
assert(ownedAlive(toolPid,psFile),'Original tool died naturally before product Stop');
const stopCensus=strictTargetCensus([restartedWorkerIdentity,originalToolIdentity]);
for(const identity of [restartedWorkerIdentity,originalToolIdentity])
  sameIdentity(identity,stopCensus.find(p=>p.pid===identity.pid));
result.workerAndToolAliveImmediatelyBeforeStop=true;
await client.evaluate('(()=>{window.__winStop={done:false};window.electronAPI.teams.stop('+
literal(team)+').then(v=>{window.__winStop={done:true,value:v}},e=>{window.__winStop={done:true,error:String(e)}});return true;})()');
await until('Stop IPC',()=>client.evaluate('(()=>{const x=window.__winStop;if(!x?.done)return null;if(x.error)throw Error(x.error);return true;})()'),150000);
await until('original worker and tool births retired',()=>
  originalBirthsRetired([restartedWorkerIdentity,originalToolIdentity]),60000);
result.originalWorkerAndToolRetired=true;
result.originalBirthRetirement={
  workerPid:restartedWorkerIdentity.pid,workerBirth:restartedWorkerIdentity.birth,
  toolPid:originalToolIdentity.pid,toolBirth:originalToolIdentity.birth
};
// Physical child retirement alone is not proof that the product has cleared
// its active-run tracking. Verify the same team through the public product IPC.
await until('product active run retired after Stop',async()=>{
  const active=await api('window.electronAPI.teams.processAlive('+literal(team)+')');
  const names=await api('window.electronAPI.teams.aliveList()');
  if(!Array.isArray(names))throw Error('Product active team inventory unreadable');
  return active===false&&!names.includes(team);
},30000);
result.productRunRetiredAfterStop=true;
result.success=true;result.phase='product-local-model-qualified';
}catch(e){result.error=String(e).slice(0,1500);result.toolNames=toolsAvailable;result.toolRequests=toolRequests;throw e;}
finally{if(teamCreated&&client)await api('window.electronAPI.teams.stop('+literal(team)+')').catch(()=>{});
try{client?.socket?.close();}catch{}try{inspector?.socket?.close();}catch{}
// Kill the whole owned cmd -> pnpm -> Electron development tree, not only the
// outer cmd.exe. Do not trust a reused PID when the original launcher has exited.
if(app?.pid){
  const launcherKnownAlive=app.exitCode===null&&app.signalCode===null;
  let currentLauncher=null,launcherCensusError=null;
  try{currentLauncher=processes().find(p=>p.pid===app.pid)??null;}
  catch(e){launcherCensusError=String(e);}
  const launcherMatches=Boolean(!launcherCensusError&&launcherKnownAlive&&originalLauncherIdentity?.birth&&
    currentLauncher?.birth===originalLauncherIdentity.birth);
  if(launcherMatches){
    const cleanup=spawnSync('taskkill.exe',['/T','/F','/PID',String(app.pid)],
      {windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:65536});
    result.appTreeCleanup={
      exitCode:cleanup.status,
      error:cleanup.error?String(cleanup.error):null,
      output:String(cleanup.stdout||'').slice(-1000),
      stderr:String(cleanup.stderr||'').slice(-1000)
    };
    if(cleanup.error||cleanup.status!==0){
      result.cleanupUnconfirmed=true;
      result.success=false;
    }
  }else{
    // The launcher can exit while pnpm or Electron descendants survive.
    // A numeric PID is no longer sufficient authority for taskkill.
    result.appTreeCleanup={exitCode:null,error:launcherCensusError??'original_launcher_exited_or_identity_changed_before_cleanup'};
    result.cleanupUnconfirmed=true;
    result.success=false;
  }
  const pipeClosed=async(stream)=>{
    if(!stream||stream.closed||stream.destroyed)return true;
    return new Promise(resolve=>{
      const done=(ok)=>{clearTimeout(timer);stream.off('close',closed);resolve(ok);};
      const closed=()=>done(true);
      const timer=setTimeout(()=>{stream.off('close',closed);resolve(false);},15000);
      stream.once('close',closed);
    });
  };
  const closed=await Promise.all([pipeClosed(app.stdout),pipeClosed(app.stderr)]);
  result.appTreePipesClosed=closed.every(Boolean);
  if(!result.appTreePipesClosed){result.cleanupUnconfirmed=true;result.success=false;}
}
await model.close().catch(()=>{});await save();
if(result.cleanupUnconfirmed)throw Error('Owned development process tree cleanup unconfirmed');}
console.log(JSON.stringify({success:result.success,phase:result.phase,realProductTeammateLaunch:result.realProductTeammateLaunch}));
