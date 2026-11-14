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
'$proof=@{token='+quoted(token)+';pid=$PID;cmd=$cmd;git=$git;visible=$visible}',
'[IO.File]::WriteAllText('+quoted(proofFile)+',($proof|ConvertTo-Json -Compress))',
'Start-Sleep -Seconds 35'
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
input:{command,description:'Isolated product Windows console verification',timeout:90000}};
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
let client,inspector,teamCreated=false,workerPid,toolPid;
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
try{
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
const request={teamName:team,cwd:f.projectPath,providerId:'anthropic',model:'claude-sonnet-4-6',
skipPermissions:true,syncModelsWithLead:false,
prompt:'TEST project only. Never access other paths or install packages.',
members:[{name:'worker',providerId:'anthropic',model:'claude-sonnet-4-6',role:'Test worker'}]};
await client.evaluate('(()=>{window.__winTeam={done:false};window.electronAPI.teams.createTeam('+
literal(request)+').then(v=>{window.__winTeam={done:true,value:v}},e=>{window.__winTeam={done:true,error:String(e)}});return true;})()');
await until('actual createTeam IPC',()=>client.evaluate('(()=>{const x=window.__winTeam;if(!x?.done)return null;if(x.error)throw Error(x.error);return x.value;})()'),240000);
teamCreated=true;
result.phase='real-member-ready';
const snapshot=await until('live worker in runtime snapshot',async()=>{const x=await api('window.electronAPI.teams.getTeamAgentRuntime('+literal(team)+')');
const m=x?.members?.worker;return m?.alive&&(m?.runtimePid||m?.pid)?x:false;},240000);
workerPid=snapshot.members.worker.runtimePid||snapshot.members.worker.pid;
assert(ownedAlive(workerPid,team),'Worker not bound to original test team');
result.realProductTeammateLaunch=true;result.initialWorkerPid=workerPid;
result.phase='real-manual-restart';
await client.evaluate('(()=>{window.__winRestart={done:false};window.electronAPI.teams.restartMember('+
literal(team)+',"worker").then(v=>{window.__winRestart={done:true,value:v}},e=>{window.__winRestart={done:true,error:String(e)}});return true;})()');
await until('manual restart IPC',()=>client.evaluate('(()=>{const x=window.__winRestart;if(!x?.done)return null;if(x.error)throw Error(x.error);return true;})()'),240000);
const restarted=await until('new live direct worker PID',async()=>{const x=await api('window.electronAPI.teams.getTeamAgentRuntime('+literal(team)+')');
const m=x?.members?.worker,p=m?.runtimePid||m?.pid;return m?.alive&&p&&p!==workerPid?x:false;},180000);
workerPid=restarted.members.worker.runtimePid||restarted.members.worker.pid;
assert.equal(restarted.members.worker.backendType,'process','Direct process restart not exercised');
assert(ownedAlive(workerPid,team),'Original restarted worker unavailable');
result.restartWorkerPid=workerPid;
result.phase='real-tool-turn';
const focusBefore=await client.evaluate('document.hasFocus()');
const nativeFocusBefore=await main('require("electron").BrowserWindow.getAllWindows().some(w=>w.isFocused())');
await api('window.electronAPI.teams.sendMessage('+literal(team)+','+
literal({member:'worker',from:'user',text:token+' Execute the current local TEST model shell command.'})+')');
const proof=await until('original shell PID and tool receipt',async()=>{try{return JSON.parse(await readFile(proofFile,'utf8'));}
catch(e){if(e?.code==='ENOENT')return false;throw e;}},180000);
assert.equal(proof.token,token);assert.equal(proof.cmd,'owned-cmd');
assert.match(proof.git,/^git version /);
assert.equal(proof.visible,false,'Visible Windows console window was created');
assert.equal(toolRequests,1,'Unexpected synthetic-model tool dispatches');
toolPid=proof.pid;assert(ownedAlive(toolPid,psFile),'Original tool process not alive');
const focusAfter=await client.evaluate('document.hasFocus()');
const nativeFocusAfter=await main('require("electron").BrowserWindow.getAllWindows().some(w=>w.isFocused())');
if(focusBefore&&nativeFocusBefore)assert(focusAfter&&nativeFocusAfter,'Electron lost focus');
result.focus={focusBefore,nativeFocusBefore,focusAfter,nativeFocusAfter};
result.tool=proof;result.realWindowsToolExecuted=true;
await client.screenshot(path.join(out,'real-team.png'));
result.phase='normal-product-stop';
await client.evaluate('(()=>{window.__winStop={done:false};window.electronAPI.teams.stop('+
literal(team)+').then(v=>{window.__winStop={done:true,value:v}},e=>{window.__winStop={done:true,error:String(e)}});return true;})()');
await until('Stop IPC',()=>client.evaluate('(()=>{const x=window.__winStop;if(!x?.done)return null;if(x.error)throw Error(x.error);return true;})()'),150000);
await until('original worker and tool retired',()=>!ownedAlive(workerPid,team)&&!ownedAlive(toolPid,psFile),60000);
result.originalWorkerAndToolRetired=true;result.success=true;result.phase='product-local-model-qualified';
}catch(e){result.error=String(e).slice(0,1500);result.toolNames=toolsAvailable;result.toolRequests=toolRequests;throw e;}
finally{await save();if(teamCreated&&client)await api('window.electronAPI.teams.stop('+literal(team)+')').catch(()=>{});
try{client?.socket?.close();}catch{}try{inspector?.socket?.close();}catch{}
if(app?.pid&&app.exitCode===null&&app.signalCode===null)app.kill('SIGKILL');
await model.close().catch(()=>{});}
console.log(JSON.stringify({success:result.success,phase:result.phase,realProductTeammateLaunch:result.realProductTeammateLaunch}));
