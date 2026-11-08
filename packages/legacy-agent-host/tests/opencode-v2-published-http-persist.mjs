// TEST-only discovery: published OpenCode 2.0.21 HTTP server with durable events.
// Not an executable/Host-custody or production V01-V08 certificate.
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

if (process.argv[2] === '--worker') {
  const { ServerProcess } = await import('@opencode/server/process');
  const { NodeServices } = await import('@effect/platform-node');
  const { LayerNode } = await import('@opencode/util/effect/layer-node');
  const { Global } = await import('@opencode/util/global');
  const { AppProcess } = await import('@opencode/util/process');
  const { Effect } = await import('effect');
  const options = {
    app: { name: 'TEST-owned-v2-http', version: '2.0.21' },
    hostname: '127.0.0.1', port: Number(process.env.TEST_V2_HTTP_PORT),
    password: process.env.TEST_V2_HTTP_PASSWORD,
    events: { persist: true },
    database: { path: process.env.TEST_V2_HTTP_DB },
    models: { fetch: false },
    config: { directory: process.env.XDG_CONFIG_HOME, project: false },
    fs: { filewatcher: false, fff: false },
  };
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* ServerProcess.start(options);
    return yield* Effect.never;
  })).pipe(Effect.provide(LayerNode.compile(LayerNode.group([Global.node, AppProcess.node]), {
    replacements: [Global.node.replace(Global.layerWith({ config: process.env.XDG_CONFIG_HOME }))],
  })), Effect.provide(NodeServices.layer)));
} else {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw Error('TEST_platform_unsupported');
  const prefix = process.env.OPENCODE_V2_TEST_SDK_PREFIX;
  const head = process.env.OPENCODE_V2_TEST_SOURCE_HEAD;
  if (!prefix?.startsWith('/') || !/^[a-f0-9]{40}$/.test(head || '') ||
    execFileSync('git', ['rev-parse','HEAD'], {encoding:'utf8'}).trim() !== head)
    throw Error('TEST_source_or_prefix_unqualified');
  const { parseOwnedDurableLog } = await import('./opencode-v2-native-log-parse.mjs');
  const root = mkdtempSync(join(tmpdir(), 'TEST-opencode-v2-persist-'));
  const receiptPath = resolve(process.env.OPENCODE_V2_TEST_HTTP_RECEIPT || 'opencode-v2-http-persist.json');
  const receipt = {kind:'TEST_V2_HTTP_DURABLE_DISCOVERY', sourceHead:head, version:'2.0.21',
    qualified:false, packagedElectronQualified:false, modelTurnProven:false,
    processCustodyQualified:false, steps:[], cleanup:false};
  const hash = value => createHash('sha256').update(value).digest('hex');
  const db = join(root,'data','v2.sqlite');
  for (const name of ['home','workspace','config','data','cache','state','temp'])
    mkdirSync(join(root,name));
  const workspace = join(root,'workspace');
  const canonicalPrefix = realpathSync(prefix);
  const packageRoot = realpathSync(join(prefix,'node_modules','@opencode','sdk'));
  const serverRoot = realpathSync(join(prefix,'node_modules','@opencode','server'));
  if (!packageRoot.startsWith(canonicalPrefix+'/node_modules/') ||
      !serverRoot.startsWith(canonicalPrefix+'/node_modules/'))
    throw Error('TEST_published_package_escape');
  const sdk = JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8'));
  const server = JSON.parse(readFileSync(join(serverRoot,'package.json'),'utf8'));
  if (sdk.name !== '@opencode/sdk' || sdk.version !== '2.0.21' ||
      server.name !== '@opencode/server' || server.version !== '2.0.21')
    throw Error('TEST_published_version_unqualified');
  const worker = join(prefix, 'TEST-v2-http-owned-worker.mjs');
  copyFileSync(fileURLToPath(import.meta.url),worker);
  const password = randomBytes(24).toString('hex');
  const env = { PATH:process.env.PATH || '/usr/bin:/bin', HOME:join(root,'home'),
    XDG_CONFIG_HOME:join(root,'config'), XDG_CACHE_HOME:join(root,'cache'),
    XDG_DATA_HOME:join(root,'data'), XDG_STATE_HOME:join(root,'state'),
    TMPDIR:join(root,'temp'), OPENCODE_DISABLE_MODELS_FETCH:'true',
    CI:'true', NO_COLOR:'1', TEST_V2_HTTP_DB:db,
    TEST_V2_HTTP_PASSWORD:password };
  let child, port, startTicks, stopSignalSent = false;
  function startIdentity(pid) {
    try {
      const stat=readFileSync('/proc/'+pid+'/stat','utf8');
      const end=stat.lastIndexOf(') ');
      if(end<0)throw Error('TEST_process_identity_invalid');
      const fields=stat.slice(end+2).trim().split(/\s+/);
      if(Number(fields[2])!==pid||Number(fields[3])!==pid||
         !/^\d+$/.test(fields[19]||''))throw Error('TEST_process_not_isolated');
      return fields[19];
    } catch(e){if(e?.code==='ENOENT')return undefined;throw e;}
  }
  const present = pid => { try {process.kill(pid,0);return true;}
    catch(e){if(e.code==='ESRCH')return false;throw e;} };
  async function stop() {
    if (!child?.pid) return true;
    const pid=child.pid;
    const actual=startIdentity(pid);
    if(actual!==undefined && actual!==startTicks)return false;
    if(!stopSignalSent && actual===startTicks) {
      stopSignalSent=true;
      try {process.kill(-pid,'SIGTERM');}
      catch(e){if(e.code!=='ESRCH')throw e;}
    }
    for (let n=0;n<60;n++) {
      if (!present(-pid)) {child=undefined;return true;}
      await delay(100);
    }
    return false;
  }
  async function reservePort() {
    const s = createServer();
    await new Promise((yes,no)=>s.once('error',no).listen(0,'127.0.0.1',yes));
    const result=s.address().port;
    await new Promise((yes,no)=>s.close(e=>e?no(e):yes()));
    return result;
  }
  async function call(path,method='GET',payload) {
    const res=await fetch('http://127.0.0.1:'+port+path,{
      method,redirect:'error',signal:AbortSignal.timeout(7000),
      headers:{authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64'),
        ...(payload?{'content-type':'application/json'}:{})},
      body:payload?JSON.stringify(payload):undefined,
    });
    const chunks=[];let size=0;
    if(res.body)for await(const chunk of res.body){
      size+=chunk.byteLength;
      if(size>1024*1024)throw Error('TEST_unbounded_HTTP_response');
      chunks.push(chunk);
    }
    const txt=Buffer.concat(chunks).toString('utf8');
    return {status:res.status,text:txt,data:txt&&!txt.startsWith('data:')?JSON.parse(txt):null};
  }
  async function start() {
    port=await reservePort();env.TEST_V2_HTTP_PORT=String(port);
    stopSignalSent=false;
    child=spawn(process.execPath,[worker,'--worker'],{
      cwd:workspace,env,detached:true,stdio:'ignore',
    });
    startTicks=child.pid?startIdentity(child.pid):undefined;
    if (!startTicks || readFileSync('/proc/'+child.pid+'/exe').length===0)
      throw Error('TEST_owned_process_missing');
    const expected=hash(readFileSync(process.execPath));
    if (hash(readFileSync('/proc/'+child.pid+'/exe'))!==expected)
      throw Error('TEST_worker_executable_changed');
    for (let n=0;n<80;n++) {
      if (!present(child.pid))break;
      try {const info=await call('/api/info');
        if(info.status===200&&info.data?.pid===child.pid&&info.data?.version==='2.0.21')
          return child.pid;
      } catch { /* Only read-only server-start polling. */ }
      await delay(125);
    }
    throw Error('TEST_published_HTTP_server_start_unqualified');
  }
  async function readLog(id) {
    const response=await call('/api/experimental/session/'+encodeURIComponent(id)+'/log?follow=false');
    if(response.status!==200)throw Error('TEST_durable_log_unavailable');
    const events=[];
    const outcome=parseOwnedDurableLog(response.text,id,workspace,e=>events.push(e));
    if(outcome.eventCount!==1||events[0]?.type!=='session.created')
      throw Error('TEST_durable_session_create_missing');
    return {id:events[0].id,seq:events[0].durable.seq,sync:outcome.watermark};
  }
  try {
    const firstPid=await start();
    receipt.steps.push('TEST_published_server_real_authenticated_HTTP_ready');
    const unauth=await fetch('http://127.0.0.1:'+port+'/api/info',{
      redirect:'error',signal:AbortSignal.timeout(7000)});
    if(unauth.status!==401)throw Error('TEST_missing_HTTP_auth');
    receipt.steps.push('TEST_no_unauthenticated_HTTP_access');
    const created=await call('/api/session','POST',{
      location:{directory:workspace},agent:'build',
      permissions:[{action:'external_directory',resource:'*',effect:'deny'}],
    });
    const sessionId=created.data?.data?.id;
    if(created.status!==200||!/^ses_[A-Za-z0-9_-]+$/.test(sessionId||''))
      throw Error('TEST_session_create_unqualified');
    const before=await readLog(sessionId);
    receipt.steps.push('TEST_official_HTTP_session_created_event_persisted');
    if(!await stop())throw Error('TEST_first_process_cleanup_unknown');
    const secondPid=await start();
    if(firstPid===secondPid)throw Error('TEST_cold_restart_pid_reused');
    const restored=await call('/api/session/'+encodeURIComponent(sessionId));
    if(restored.status!==200||restored.data?.data?.id!==sessionId)
      throw Error('TEST_cold_session_readback_failed');
    const after=await readLog(sessionId);
    if(after.id!==before.id||after.seq!==before.seq||after.sync!==before.sync)
      throw Error('TEST_cold_durable_event_identity_changed');
    receipt.durableHTTPEvents=1;
    receipt.steps.push('TEST_durable_HTTP_session_identity_survives_cold_restart_no_prompt');
  } catch (e) {
    receipt.failure = /^TEST_[A-Za-z0-9_]+$/.test(e?.message || '')
      ? e.message : 'TEST_published_HTTP_persist_unqualified';
    throw Error(receipt.failure);
  } finally {
    receipt.cleanup=await stop().catch(()=>false);
    if(receipt.cleanup)rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n');
  }
  if(!receipt.cleanup)throw Error('TEST_worker_cleanup_unknown');
}
