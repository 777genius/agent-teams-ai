// TEST-only discovery: published OpenCode 2.0.21 HTTP server with durable events.
// Node worker is a TEST owner only; no production executable/Host custody or V01–V08 certificate.
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  const { parseOwnedDurableLog, retainsOwnedDurablePrefix } = await import('./opencode-v2-native-log-parse.mjs');
  const root = mkdtempSync(join(tmpdir(), 'TEST-opencode-v2-persist-'));
  const receiptPath = resolve(process.env.OPENCODE_V2_TEST_HTTP_RECEIPT || 'opencode-v2-http-persist.json');
  const receipt = {kind:'TEST_V2_HTTP_DURABLE_DISCOVERY', sourceHead:head, version:'2.0.21',
    qualified:false, packagedElectronQualified:false, modelTurnProven:false,
    processCustodyQualified:false, steps:[], cleanup:false};
  const hash = value => createHash('sha256').update(value).digest('hex');
  const db = join(root,'data','v2.sqlite');
  const workspace = join(root,'workspace');
  let worker, password, env;
  // No native worker exists during setup; still finalize a failed TEST
  // receipt and remove the owned temporary root on any package/IO failure.
  try {
    for (const name of ['home','workspace','config','data','cache','state','temp'])
      mkdirSync(join(root,name));
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
    // The worker must live inside this run's disposable namespace, never
    // overwrite a shared SDK prefix used by another TEST owner. Only this
    // root is removed on confirmed process-tree teardown.
    worker = join(root, 'TEST-v2-http-owned-worker.mjs');
    // Node's ESM resolver finds the *pinned TEST installation* through this
    // read-only dependency link; removing root does not remove its target.
    symlinkSync(join(canonicalPrefix, 'node_modules'), join(root, 'node_modules'), 'dir');
    copyFileSync(fileURLToPath(import.meta.url),worker);
    // TEST-only fault injection after copying into the owned root. Never
    // touch the shared pinned SDK package directory on setup failure.
    if (process.env.OPENCODE_V2_TEST_ABORT_AFTER_COPY === '1') {
      receipt.testOwnedWorkerPath = worker;
      receipt.testOwnedWorkerCopySha256 = hash(readFileSync(worker));
      throw Error('TEST_owned_worker_postcopy_failure');
    }
    password = randomBytes(24).toString('hex');
    env = { PATH:process.env.PATH || '/usr/bin:/bin', HOME:join(root,'home'),
      XDG_CONFIG_HOME:join(root,'config'), XDG_CACHE_HOME:join(root,'cache'),
      XDG_DATA_HOME:join(root,'data'), XDG_STATE_HOME:join(root,'state'),
      TMPDIR:join(root,'temp'), OPENCODE_DISABLE_MODELS_FETCH:'true',
      CI:'true', NO_COLOR:'1', TEST_V2_HTTP_DB:db,
      TEST_V2_HTTP_PASSWORD:password };
  } catch (error) {
    receipt.failure = /^TEST_[A-Za-z0-9_]+$/.test(error?.message || '')
      ? error.message : 'TEST_published_HTTP_persist_unqualified';
    try {
      rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
      receipt.cleanup = true;
    } catch {
      receipt.cleanup = false;
    }
    writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n');
    throw Error(receipt.failure);
  }
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
      if (!present(-pid)) {if (child?.pid === pid) child = undefined;return true;}
      await delay(100);
    }
    return false;
  }
  // A CI cancellation must not orphan this TEST-owned detached worker group.
  // Validate its PID/start identity before any signal, as normal stop() does.
  // Share one cancellation promise with normal catch/finally: stopping the
  // worker may reject an in-flight HTTP request. That rejection must neither
  // overwrite the interrupted receipt nor terminate the parent before reaping.
  let interruptionTask;
  function interruptOwned(signal) {
    if (interruptionTask) return;
    interruptionTask = (async () => {
      receipt.failure = 'TEST_interrupted_' + signal;
      let cleaned = false;
      try {
        cleaned = await stop();
        if (cleaned) rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
      } catch { cleaned = false; }
      receipt.cleanup = cleaned;
      try { writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n'); }
      catch { /* Failed receipt persistence cannot qualify this TEST. */ }
      process.exit(signal === 'SIGINT' ? 130 : 143);
    })();
  }
  process.on('SIGINT', () => { void interruptOwned('SIGINT'); });
  process.on('SIGTERM', () => { void interruptOwned('SIGTERM'); });

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
    if (interruptionTask) throw Error('TEST_interrupted_before_start');
    port=await reservePort();env.TEST_V2_HTTP_PORT=String(port);
    if (interruptionTask) throw Error('TEST_interrupted_before_start');
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
        if(info.status===200&&info.data?.pid===child.pid&&info.data?.version==='2.0.21') {
          // Optional isolated negative-test handshake, never emitted normally.
          if (process.env.OPENCODE_V2_TEST_READY_FILE)
            writeFileSync(process.env.OPENCODE_V2_TEST_READY_FILE,
              JSON.stringify({pid:child.pid,startIdentity:startTicks})+'\n');
          return child.pid;
        }
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
    return {...outcome,positions:[events[0].durable.seq],fingerprints:[hash(JSON.stringify(events[0]))]};
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
    // The actual V2 HTTP engine must reject an unauthenticated destructive
    // request BEFORE route handling. A 401 alone is insufficient: read back
    // the same TEST session to prove the unauthenticated DELETE did not act.
    const anonymousDelete=await fetch('http://127.0.0.1:'+port+
      '/api/session/'+encodeURIComponent(sessionId),{
      method:'DELETE',redirect:'error',signal:AbortSignal.timeout(7000),
    });
    if(anonymousDelete.status!==401)
      throw Error('TEST_native_unauthenticated_delete_not_rejected');
    const afterAnonymousDelete=await call('/api/session/'+encodeURIComponent(sessionId));
    if(afterAnonymousDelete.status!==200||
       afterAnonymousDelete.data?.data?.id!==sessionId||
       afterAnonymousDelete.data?.data?.permissions?.[0]?.action!=='external_directory'||
       afterAnonymousDelete.data?.data?.permissions?.[0]?.effect!=='deny')
      throw Error('TEST_native_unauthenticated_delete_changed_session');
    receipt.nativeUnauthenticatedDeleteRejected=true;
    // A real native session round-trip of ordered permission rules, NOT a
    // tool-execution or fully assembled agent/global policy certificate.
    // Late wildcard grants must never be promoted to the captured Host deny.
    const { preflightOpenCodeV2EffectiveExternalDirectory } =
      await import('../dist/composition/openCodeV2StaticPreflight.js');
    const guard = (action, effect) => ({ action, resource:'*', effect });
    for (const { rules, admissible } of [
      { rules:[guard('external_directory','deny'),guard('*','allow')],
        admissible:false },
      { rules:[guard('*','allow'),guard('external_directory','deny')],
        admissible:true },
    ]) {
      const createdRules=await call('/api/session','POST',{
        location:{directory:workspace},agent:'build',permissions:rules,
      });
      const testId=createdRules.data?.data?.id;
      if(createdRules.status!==200 || !/^ses_[A-Za-z0-9_-]+$/.test(testId||''))
        throw Error('TEST_native_ordered_session_create_unqualified');
      const readback=await call('/api/session/'+encodeURIComponent(testId));
      const nativeRules=readback.data?.data?.permissions;
      if(readback.status!==200 || readback.data?.data?.id!==testId ||
         !Array.isArray(nativeRules) || nativeRules.length!==rules.length ||
         !rules.every((rule,index)=>Object.keys(nativeRules[index]||{}).length===3 &&
           Object.entries(rule).every(([key,value])=>nativeRules[index]?.[key]===value)))
        throw Error('TEST_native_permission_order_readback_unqualified');
      const admission=preflightOpenCodeV2EffectiveExternalDirectory(nativeRules,'deny');
      if((admission.kind==='policy-candidate')!==admissible)
        throw Error('TEST_native_late_permission_override_not_fenced');
    }
    receipt.nativeSessionPermissionOrderReadbackProven=true;
    const {observeShellFlagPermissionSplit}=await import('./opencode-v2-shell-flag-policy-probe.mjs');
    const shellFlag=await observeShellFlagPermissionSplit(call,workspace,root);
    receipt.nativeShellFlagPermissionSplitObserved=shellFlag.decisionSplitObserved;
    receipt.steps.push('TEST_native_shell_flag_permission_split_not_tool_enforcement');
    // This checks the real published V2 Permission.Service resolver, NOT a
    // session readback, model turn, tool execution, or effective agent policy.
    // All resources are disposable and outside this TEST workspace only.
    const externalResource=join(root,'temp','TEST-external-resource');
    let rejectNoReplay=false;
    for(const scenario of [
      {first:'allow',last:'deny',expected:'deny'},
      {first:'deny',last:'allow',expected:'allow'},
      {first:'allow',last:'ask',expected:'ask'},
    ]) {
      const rules=[
        {action:'external_directory',resource:'*',effect:scenario.first},
        {action:'external_directory',resource:'*',effect:scenario.last},
      ];
      const made=await call('/api/session','POST',{
        location:{directory:workspace},agent:'build',permissions:rules,
      });
      const id=made.data?.data?.id;
      if(made.status!==200||!/^ses_[A-Za-z0-9_-]+$/.test(id||''))
        throw Error('TEST_native_resolver_session_missing');
      const base='/api/session/'+encodeURIComponent(id);
      const decision=await call(base+'/permission','POST',{
        action:'external_directory',resources:[externalResource],
        ...(scenario.expected==='ask'?{save:[externalResource]}:{}),
      });
      if(decision.status!==200||decision.data?.data?.effect!==scenario.expected)
        throw Error('TEST_native_last_matching_permission_not_effective');
      const pending=await call(base+'/permission');
      const requests=pending.data?.data;
      if(pending.status!==200||!Array.isArray(requests)||
         requests.length!==(scenario.expected==='ask'?1:0))
        throw Error('TEST_native_permission_pending_count_invalid');
      if(scenario.expected==='ask') {
        const permissionId=decision.data?.data?.id;
        if(!/^per[A-Za-z0-9_-]+$/.test(permissionId||'')||
           requests[0]?.id!==permissionId||requests[0]?.sessionID!==id||
           requests[0]?.save?.length!==1||requests[0]?.save?.[0]!==externalResource)
          throw Error('TEST_native_ask_identity_invalid');
        // A different TEST session must never grant this request. Its
        // possession of the same loopback secret is not session authority.
        const foreign='/api/session/'+encodeURIComponent(sessionId)+
          '/permission/'+encodeURIComponent(permissionId)+'/reply';
        if((await call(foreign,'POST',{decision:'always'})).status!==404)
          throw Error('TEST_foreign_permission_reply_accepted');
        const still=await call(base+'/permission');
        if(still.status!==200||still.data?.data?.length!==1||
           still.data.data[0]?.id!==permissionId)
          throw Error('TEST_foreign_permission_changed_owner');
        const reply=base+'/permission/'+encodeURIComponent(permissionId)+'/reply';
        // The unauthorized caller must not grant a pending native permission.
        // Confirm the original ID is still pending before the authorized reject.
        const anonymousGrant=await fetch('http://127.0.0.1:'+port+reply,{
          method:'POST',redirect:'error',signal:AbortSignal.timeout(7000),
          headers:{'content-type':'application/json'},
          body:JSON.stringify({decision:'always'}),
        });
        if(anonymousGrant.status!==401)
          throw Error('TEST_native_unauthenticated_permission_grant_not_rejected');
        const afterAnonymousGrant=await call(base+'/permission');
        if(afterAnonymousGrant.status!==200||
           !Array.isArray(afterAnonymousGrant.data?.data)||
           afterAnonymousGrant.data.data.length!==1||
           afterAnonymousGrant.data.data[0]?.id!==permissionId||
           afterAnonymousGrant.data.data[0]?.sessionID!==id)
          throw Error('TEST_native_unauthenticated_permission_grant_changed_pending');
        if((await call(reply,'POST',{decision:'reject'})).status!==204)
          throw Error('TEST_native_permission_reject_failed');
        if((await call(reply,'POST',{decision:'once'})).status!==404)
          throw Error('TEST_native_permission_reply_replayed');
        const cleared=await call(base+'/permission');
        if(cleared.status!==200||cleared.data?.data?.length!==0)
          throw Error('TEST_native_permission_after_reject_not_empty');
        // A 401 must not install a saved approval for the ORIGINAL resource.
        const fresh=await call(base+'/permission','POST',{
          action:'external_directory',resources:[externalResource],
        });
        const freshId=fresh.data?.data?.id;
        if(fresh.status!==200||fresh.data?.data?.effect!=='ask'||
           !/^per[A-Za-z0-9_-]+$/.test(freshId||'')||freshId===permissionId)
          throw Error('TEST_native_unauthenticated_grant_changed_effective_policy');
        const freshPending=await call(base+'/permission');
        if(freshPending.status!==200||!Array.isArray(freshPending.data?.data)||
           freshPending.data.data.length!==1||
           freshPending.data.data[0]?.id!==freshId||
           freshPending.data.data[0]?.sessionID!==id)
          throw Error('TEST_native_unauthenticated_grant_fresh_pending_unqualified');
        if((await call(base+'/permission/'+encodeURIComponent(freshId)+
           '/reply','POST',{decision:'reject'})).status!==204)
          throw Error('TEST_native_fresh_permission_reject_failed');
        const afterFreshReject=await call(base+'/permission');
        if(afterFreshReject.status!==200||afterFreshReject.data?.data?.length!==0)
          throw Error('TEST_native_fresh_permission_not_cleared');
        receipt.nativeUnauthenticatedPermissionGrantRejected=true;
        rejectNoReplay=true;
      }
      if((await call(base,'DELETE')).status!==204)
        throw Error('TEST_native_resolver_session_cleanup_failed');
    }
    if(!rejectNoReplay)throw Error('TEST_native_permission_negative_not_executed');
    if(receipt.nativeUnauthenticatedDeleteRejected!==true||
       receipt.nativeUnauthenticatedPermissionGrantRejected!==true)
      throw Error('TEST_native_unauthenticated_mutation_negative_incomplete');
    receipt.steps.push('TEST_native_unauthenticated_mutations_rejected');
    receipt.nativePermissionResolverProven=true;
    receipt.nativePermissionReplyRejectNoReplayProven=true;
    receipt.steps.push('TEST_published_native_permission_resolver_and_nonreplay');
    // Actual native effective policy is NOT equal to the session's ordered
    // readback: a TEST-only project-scoped "always" grant can override ASK.
    // Keep this saved resource unique so the existing stale/unauthorized
    // permission matrix cannot inherit the grant. No user config is touched.
    const savedResource=join(root,'temp','TEST-saved-always-unique');
    const savedRules=[{action:'external_directory',resource:'*',effect:'ask'}];
    const savedCreated=await call('/api/session','POST',{
      location:{directory:workspace},agent:'build',permissions:savedRules,
    });
    const savedId=savedCreated.data?.data?.id;
    if(savedCreated.status!==200||!/^ses_[A-Za-z0-9_-]+$/.test(savedId||''))
      throw Error('TEST_saved_permission_session_missing');
    const savedPath='/api/session/'+encodeURIComponent(savedId);
    const savedAsk=await call(savedPath+'/permission','POST',{
      action:'external_directory',resources:[savedResource],save:[savedResource],
    });
    const savedRequestId=savedAsk.data?.data?.id;
    if(savedAsk.status!==200||savedAsk.data?.data?.effect!=='ask'||
       !/^per[A-Za-z0-9_-]+$/.test(savedRequestId||''))
      throw Error('TEST_saved_permission_initial_ask_missing');
    const savedPending=await call(savedPath+'/permission');
    if(savedPending.status!==200||savedPending.data?.data?.length!==1||
       savedPending.data.data[0]?.id!==savedRequestId||
       savedPending.data.data[0]?.sessionID!==savedId)
      throw Error('TEST_saved_permission_request_identity_mismatch');
    if((await call(savedPath+'/permission/'+encodeURIComponent(savedRequestId)+
       '/reply','POST',{decision:'always'})).status!==204)
      throw Error('TEST_saved_permission_always_unconfirmed');
    const savedReadback=await call(savedPath);
    const savedCleared=await call(savedPath+'/permission');
    if(savedReadback.status!==200||
       JSON.stringify(savedReadback.data?.data?.permissions)!==JSON.stringify(savedRules)||
       savedCleared.status!==200||savedCleared.data?.data?.length!==0||
       preflightOpenCodeV2EffectiveExternalDirectory(savedRules,'ask').kind!=='policy-candidate')
      throw Error('TEST_saved_permission_readback_or_cleanup_mismatch');
    // A newly created session STILL reads back ASK, but the native resolver
    // must observe the persisted project-wide grant for this exact resource.
    const savedFollow=await call('/api/session','POST',{
      location:{directory:workspace},agent:'build',permissions:savedRules,
    });
    const savedFollowId=savedFollow.data?.data?.id;
    if(savedFollow.status!==200||!/^ses_[A-Za-z0-9_-]+$/.test(savedFollowId||'')||
       savedFollowId===savedId)
      throw Error('TEST_saved_permission_followup_session_missing');
    const savedFollowPath='/api/session/'+encodeURIComponent(savedFollowId);
    const savedFollowReadback=await call(savedFollowPath);
    if(savedFollowReadback.status!==200||
       JSON.stringify(savedFollowReadback.data?.data?.permissions)!==JSON.stringify(savedRules))
      throw Error('TEST_saved_permission_followup_ask_not_captured');
    const savedAllowed=await call(savedFollowPath+'/permission','POST',{
      action:'external_directory',resources:[savedResource],
    });
    const savedFollowPending=await call(savedFollowPath+'/permission');
    if(savedAllowed.status!==200||savedAllowed.data?.data?.effect!=='allow'||
       savedFollowPending.status!==200||savedFollowPending.data?.data?.length!==0)
      throw Error('TEST_saved_always_did_not_override_ask');
    // An explicit captured DENY must remain stronger than that same saved
    // approval. Never turn source-only ASK readback into execution proof.
    const denyRules=[{action:'external_directory',resource:'*',effect:'deny'}];
    const savedDeny=await call('/api/session','POST',{
      location:{directory:workspace},agent:'build',permissions:denyRules,
    });
    const savedDenyId=savedDeny.data?.data?.id;
    if(savedDeny.status!==200||!/^ses_[A-Za-z0-9_-]+$/.test(savedDenyId||''))
      throw Error('TEST_saved_permission_deny_session_missing');
    const savedDenyPath='/api/session/'+encodeURIComponent(savedDenyId);
    const savedDenied=await call(savedDenyPath+'/permission','POST',{
      action:'external_directory',resources:[savedResource],
    });
    const savedDenyPending=await call(savedDenyPath+'/permission');
    if(savedDenied.status!==200||savedDenied.data?.data?.effect!=='deny'||
       savedDenyPending.status!==200||savedDenyPending.data?.data?.length!==0)
      throw Error('TEST_saved_allow_overrode_explicit_deny');
    receipt.nativeSavedAlwaysOverridesAskProven=true;
    receipt.nativeExplicitDenyBeatsSavedAlwaysProven=true;
    // A cold native restart must never let an old permission prompt grant a
    // new process authority. Capture three independent TEST permissions
    // before restart, then test reject/once/always against different stale IDs.
    // Every native stale reply is sent only once, against its own captured
    // permission ID. Never turn a lost-ACK retry into a passing test.
    // In particular, a stale `once`/`always` must not grant on a cold owner.
    const stalePermissionClaims = [];
    for (const decision of ['reject', 'once', 'always']) {
      const staleCreated=await call('/api/session','POST',{
        location:{directory:workspace},agent:'build',
        permissions:[{action:'external_directory',resource:'*',effect:'ask'}],
      });
      const staleSessionId=staleCreated.data?.data?.id;
      if(staleCreated.status!==200||!/^ses_[A-Za-z0-9_-]+$/.test(staleSessionId||''))
        throw Error('TEST_stale_permission_session_create_failed');
      const stalePath='/api/session/'+encodeURIComponent(staleSessionId);
      const staleResource=join(root,'temp','TEST-stale-'+decision);
      const pendingAsk=await call(stalePath+'/permission','POST',{
        action:'external_directory',resources:[staleResource],save:[staleResource],
      });
      const stalePermissionId=pendingAsk.data?.data?.id;
      if(pendingAsk.status!==200||pendingAsk.data?.data?.effect!=='ask'||
         !/^per[A-Za-z0-9_-]+$/.test(stalePermissionId||'')||
         stalePermissionClaims.some(claim=>claim.permissionId===stalePermissionId))
        throw Error('TEST_stale_permission_ask_not_created');
      const pendingBefore=await call(stalePath+'/permission');
      if(pendingBefore.status!==200||!Array.isArray(pendingBefore.data?.data)||
         pendingBefore.data.data.length!==1||
         pendingBefore.data.data[0]?.id!==stalePermissionId||
         pendingBefore.data.data[0]?.sessionID!==staleSessionId||
         pendingBefore.data.data[0]?.save?.length!==1||
         pendingBefore.data.data[0]?.save?.[0]!==staleResource)
        throw Error('TEST_stale_permission_not_pending_before_restart');
      stalePermissionClaims.push({path:stalePath,sessionId:staleSessionId,
        permissionId:stalePermissionId,decision,resource:staleResource});
    }
    if(stalePermissionClaims.length!==3)
      throw Error('TEST_stale_permission_negative_matrix_incomplete');
    receipt.steps.push('TEST_real_pending_permission_exists_before_cold_restart');
    const before=await readLog(sessionId);
    receipt.steps.push('TEST_official_HTTP_session_created_event_persisted');
    if(!await stop())throw Error('TEST_first_process_cleanup_unknown');
    const secondPid=await start();
    if(firstPid===secondPid)throw Error('TEST_cold_restart_pid_reused');
    const restored=await call('/api/session/'+encodeURIComponent(sessionId));
    if(restored.status!==200||restored.data?.data?.id!==sessionId)
      throw Error('TEST_cold_session_readback_failed');
    const after=await readLog(sessionId);
    if(after.watermark!==before.watermark||after.eventCount!==before.eventCount||!retainsOwnedDurablePrefix(before,after))
      throw Error('TEST_cold_durable_event_identity_changed');
    // Saved permissions must be evaluated by the newly started native
    // process, not inferred from a cached session rules array or old PID.
    const coldSaved=await call(savedFollowPath+'/permission','POST',{
      action:'external_directory',resources:[savedResource],
    });
    const coldSavedPending=await call(savedFollowPath+'/permission');
    const coldDenied=await call(savedDenyPath+'/permission','POST',{
      action:'external_directory',resources:[savedResource],
    });
    const coldDenyPending=await call(savedDenyPath+'/permission');
    if(coldSaved.status!==200||coldSaved.data?.data?.effect!=='allow'||
       coldSavedPending.status!==200||coldSavedPending.data?.data?.length!==0||
       coldDenied.status!==200||coldDenied.data?.data?.effect!=='deny'||
       coldDenyPending.status!==200||coldDenyPending.data?.data?.length!==0)
      throw Error('TEST_cold_saved_permission_policy_changed');
    // A fresh session created AFTER the cold restart must inherit the
    // project-scoped saved grant. A pre-restart session alone cannot prove
    // that this authority belongs to the project rather than the session.
    const coldFresh=await call('/api/session','POST',{
      location:{directory:workspace},agent:'build',permissions:savedRules,
    });
    const coldFreshId=coldFresh.data?.data?.id;
    if(coldFresh.status!==200||!/^ses_[A-Za-z0-9_-]+$/.test(coldFreshId||'')||
       [savedId,savedFollowId,savedDenyId].includes(coldFreshId))
      throw Error('TEST_cold_fresh_saved_session_missing');
    const coldFreshPath='/api/session/'+encodeURIComponent(coldFreshId);
    const coldFreshReadback=await call(coldFreshPath);
    if(coldFreshReadback.status!==200||
       coldFreshReadback.data?.data?.id!==coldFreshId||
       coldFreshReadback.data?.data?.location?.directory!==workspace||
       JSON.stringify(coldFreshReadback.data?.data?.permissions)!==JSON.stringify(savedRules))
      throw Error('TEST_cold_fresh_session_ask_readback_changed');
    const coldFreshAllowed=await call(coldFreshPath+'/permission','POST',{
      action:'external_directory',resources:[savedResource],
    });
    const coldFreshPending=await call(coldFreshPath+'/permission');
    if(coldFreshAllowed.status!==200||coldFreshAllowed.data?.data?.effect!=='allow'||
       coldFreshPending.status!==200||coldFreshPending.data?.data?.length!==0)
      throw Error('TEST_cold_fresh_session_saved_grant_unavailable');
    if((await call(coldFreshPath,'DELETE')).status!==204)
      throw Error('TEST_cold_fresh_saved_session_cleanup_failed');
    // A saved "always" grant is PROJECT-scoped, never a process-wide
    // wildcard. Use a second, physically different TEST workspace after
    // restart and require the same resource to ASK again there. Only this
    // run owns either directory or session; no ambient config is read.
    const foreignWorkspace=join(root,'foreign-workspace');
    mkdirSync(foreignWorkspace);
    const foreignCreated=await call('/api/session','POST',{
      location:{directory:foreignWorkspace},agent:'build',permissions:savedRules,
    });
    const foreignId=foreignCreated.data?.data?.id;
    if(foreignCreated.status!==200||!/^ses_[A-Za-z0-9_-]+$/.test(foreignId||'')||
       foreignId===coldFreshId)
      throw Error('TEST_foreign_project_session_missing');
    const foreignPath='/api/session/'+encodeURIComponent(foreignId);
    const foreignReadback=await call(foreignPath);
    if(foreignReadback.status!==200||
       foreignReadback.data?.data?.id!==foreignId||
       foreignReadback.data?.data?.location?.directory!==foreignWorkspace||
       typeof foreignReadback.data?.data?.projectID!=='string'||
       typeof coldFreshReadback.data?.data?.projectID!=='string'||
       foreignReadback.data.data.projectID===coldFreshReadback.data.data.projectID||
       JSON.stringify(foreignReadback.data?.data?.permissions)!==JSON.stringify(savedRules))
      throw Error('TEST_foreign_project_identity_not_independent');
    const foreignAsk=await call(foreignPath+'/permission','POST',{
      action:'external_directory',resources:[savedResource],save:[savedResource],
    });
    const foreignRequestId=foreignAsk.data?.data?.id;
    const foreignPending=await call(foreignPath+'/permission');
    if(foreignAsk.status!==200||foreignAsk.data?.data?.effect!=='ask'||
       !/^per[A-Za-z0-9_-]+$/.test(foreignRequestId||'')||
       foreignPending.status!==200||!Array.isArray(foreignPending.data?.data)||
       foreignPending.data.data.length!==1||
       foreignPending.data.data[0]?.id!==foreignRequestId||
       foreignPending.data.data[0]?.sessionID!==foreignId)
      throw Error('TEST_saved_grant_leaked_across_projects');
    if((await call(foreignPath+'/permission/'+encodeURIComponent(foreignRequestId)+
       '/reply','POST',{decision:'reject'})).status!==204)
      throw Error('TEST_foreign_project_permission_reject_failed');
    const foreignCleared=await call(foreignPath+'/permission');
    if(foreignCleared.status!==200||foreignCleared.data?.data?.length!==0||
       (await call(foreignPath,'DELETE')).status!==204)
      throw Error('TEST_foreign_project_permission_cleanup_failed');
    receipt.nativeSavedGrantRemainsProjectScopedAfterRestartProven=true;
    receipt.nativeFreshSessionSavedGrantSurvivesColdRestartProven=true;
    receipt.nativeSavedGrantSurvivesColdRestartProven=true;
    for (const claim of stalePermissionClaims) {
      const staleAfter=await call(claim.path+'/permission');
      if(staleAfter.status!==200||!Array.isArray(staleAfter.data?.data)||
         staleAfter.data.data.length!==0)
        throw Error('TEST_cold_restart_resurrected_permission');
      const staleReply=await call(claim.path+'/permission/'+
        encodeURIComponent(claim.permissionId)+'/reply','POST',
        {decision:claim.decision});
      if(staleReply.status!==404)
        throw Error('TEST_cold_restart_accepted_stale_permission_reply');
      const stillEmpty=await call(claim.path+'/permission');
      if(stillEmpty.status!==200||!Array.isArray(stillEmpty.data?.data)||
         stillEmpty.data.data.length!==0)
        throw Error('TEST_cold_restart_stale_reply_created_permission');
      // A stale reply must not grant its ORIGINAL saved resource, even if
      // the response was 404 and a different external path still asks.
      const originalAsk=await call(claim.path+'/permission','POST',{
        action:'external_directory',resources:[claim.resource],
      });
      const originalId=originalAsk.data?.data?.id;
      if(originalAsk.status!==200||originalAsk.data?.data?.effect!=='ask'||
         !/^per[A-Za-z0-9_-]+$/.test(originalId||'')||
         originalId===claim.permissionId)
        throw Error('TEST_cold_restart_original_resource_granted');
      const originalPending=await call(claim.path+'/permission');
      if(originalPending.status!==200||!Array.isArray(originalPending.data?.data)||
         originalPending.data.data.length!==1||
         originalPending.data.data[0]?.id!==originalId||
         originalPending.data.data[0]?.sessionID!==claim.sessionId)
        throw Error('TEST_cold_restart_original_resource_pending_unqualified');
      if((await call(claim.path+'/permission/'+encodeURIComponent(originalId)+
         '/reply','POST',{decision:'reject'})).status!==204)
        throw Error('TEST_cold_restart_original_ask_reject_failed');
      const afterOriginalReject=await call(claim.path+'/permission');
      if(afterOriginalReject.status!==200||afterOriginalReject.data?.data?.length!==0)
        throw Error('TEST_cold_restart_original_ask_not_cleared');
      // Check a NEW external path too, so a wildcard grant is also caught.
      const freshAsk=await call(claim.path+'/permission','POST',{
        action:'external_directory',
        resources:[join(root,'temp','TEST-fresh-'+claim.decision)],
      });
      const freshId=freshAsk.data?.data?.id;
      if(freshAsk.status!==200||freshAsk.data?.data?.effect!=='ask'||
         !/^per[A-Za-z0-9_-]+$/.test(freshId||'')||
         freshId===claim.permissionId)
        throw Error('TEST_cold_restart_stale_grant_changed_effective_policy');
      const freshPending=await call(claim.path+'/permission');
      if(freshPending.status!==200||!Array.isArray(freshPending.data?.data)||
         freshPending.data.data.length!==1||
         freshPending.data.data[0]?.id!==freshId)
        throw Error('TEST_cold_restart_fresh_ask_identity_invalid');
      if((await call(claim.path+'/permission/'+encodeURIComponent(freshId)+
         '/reply','POST',{decision:'reject'})).status!==204)
        throw Error('TEST_cold_restart_fresh_ask_reject_failed');
      const finalPending=await call(claim.path+'/permission');
      if(finalPending.status!==200||!Array.isArray(finalPending.data?.data)||
         finalPending.data.data.length!==0)
        throw Error('TEST_cold_restart_fresh_ask_not_closed');
      if((await call(claim.path,'DELETE')).status!==204)
        throw Error('TEST_stale_permission_session_cleanup_failed');
    }
    receipt.nativeStalePermissionAfterRestartRejected=true;
    receipt.nativeStaleGrantAfterRestartRejected=true;
    receipt.steps.push('TEST_cold_native_permission_not_replayed_or_accepted');
    for (const testPath of [savedPath,savedFollowPath,savedDenyPath]) {
      if((await call(testPath,'DELETE')).status!==204)
        throw Error('TEST_saved_permission_session_cleanup_failed');
    }
    receipt.steps.push('TEST_native_persisted_always_vs_deny_survives_cold_restart');
    receipt.durableHTTPEvents=1;
    receipt.steps.push('TEST_durable_HTTP_session_identity_survives_cold_restart_no_prompt');

    // Next vertical slice: the real published durable HTTP server, through
    // the existing private Stage1 Session SPI. No model call, tool or V1 owner.
    // This Node worker is an isolated TEST harness, not a qualified production
    // OpenCode executable/process custodian.
    const { createOpenCodeV2MemberProvider } =
      await import('../dist/adapters/providers/OpenCodeV2MemberProvider.js');
    const { initialContextDigest } =
      await import('../dist/team-launch/context.js');
    const instructions = 'TEST Host-owned team, member and workspace instructions';
    const requiredRules = [
      { action:'external_directory', resource:'*', effect:'deny' },
    ];
    const sessionPath='/api/session/'+encodeURIComponent(sessionId);
    const entriesPath='/api/experimental/session/'+encodeURIComponent(sessionId)+
      '/instructions/entries';
    const executablePath=realpathSync(process.execPath);
    const executableSha256=hash(readFileSync(executablePath));
    const context={
      request:{tenantId:'TEST-tenant',projectId:'TEST-project',
        sessionId:'TEST-session',generation:1,configRevision:'TEST-config',
        requiredCapabilities:['text']},
      profile:{provider:'opencode',nativeGeneration:'v2',protocolRevision:'2.0.21',
        cwd:workspace,environment:env,
        executable:{path:executablePath,sha256:executableSha256},
        teamId:'TEST-team',memberId:'TEST-member',principalId:'TEST-principal',
        sessionId:'TEST-session',generation:1,configRevision:'TEST-config',
        model:'TEST-model',accountBinding:'TEST-account',
        endpoint:'http://127.0.0.1:'+port,nativeSessionId:sessionId,
        limits:{queuedInputs:2,inputBytes:8192,outputBytes:8192,
          outputEvents:100,pendingInteractions:2,timeoutMs:12000},
        nativeOptions:{providerId:'TEST-provider',agent:'build'}},
      endpoint:{binding:{backendId:'TEST-backend',teamId:'TEST-team',
        runId:'TEST-run',memberId:'TEST-member',generation:'TEST-generation'}},
      instructions,isCurrent:()=>true,canAllocate:()=>true,
      onProgress:()=>{},readCheckpoint:async()=>undefined,
    };
    let instructionWrites=0, instructionReads=0;
    const readCurrentInstructions=async (capture,signal)=>{
      if(signal.aborted||startIdentity(secondPid)!==startTicks||
         capture.nativeSessionId!==sessionId||
         capture.contextDigest!==initialContextDigest(capture.instructions)||
         capture.generation!=='TEST-generation'||capture.configRevision!=='TEST-config')
        return undefined;
      const get=await call(entriesPath);
      if(signal.aborted||startIdentity(secondPid)!==startTicks||
         get.status!==200||!Array.isArray(get.data?.data)||
         get.data.data.filter(e=>e?.key==='host-context').length!==1||
         JSON.stringify(get.data.data.find(e=>e?.key==='host-context')?.value)!==
           JSON.stringify({instructions:capture.instructions,digest:capture.contextDigest}))
        return undefined;
      instructionReads++;
      return {nativeSessionId:sessionId,contextDigest:capture.contextDigest,
        generation:capture.generation,configRevision:capture.configRevision};
    };
    const owner={
      requiredExternalDirectory:'deny',
      readPassword:()=>password,
      async probe(signal) {
        if(signal.aborted)return false;
        const response=await call('/api/info');
        return !signal.aborted&&response.status===200&&
          response.data?.pid===secondPid&&startIdentity(secondPid)===startTicks;
      },
      async readNativeCustody(signal) {
        if(signal.aborted||startIdentity(secondPid)!==startTicks)return undefined;
        const info=await call('/api/info');
        if(signal.aborted||info.status!==200||info.data?.pid!==secondPid||
           info.data?.version!=='2.0.21')return undefined;
        const observedPath=realpathSync('/proc/'+secondPid+'/exe');
        return {executablePath:observedPath,
          executableSha256:hash(readFileSync('/proc/'+secondPid+'/exe')),
          pid:secondPid,startIdentity:startTicks,version:info.data.version};
      },
      async readNativeEffectivePermissions(signal) {
        if(signal.aborted||startIdentity(secondPid)!==startTicks)
          throw Error('TEST_readback_process_identity_lost');
        const response=await call(sessionPath);
        if(signal.aborted||startIdentity(secondPid)!==startTicks||
           response.status!==200||
           response.data?.data?.id!==sessionId||
           response.data?.data?.location?.directory!==workspace)
          throw Error('TEST_native_session_identity_unconfirmed');
        return {nativeSessionId:sessionId,pid:secondPid,startIdentity:startTicks,
          rules:response.data.data.permissions};
      },
      async installAndAttestInitialContext(capture,signal) {
        if(signal.aborted||++instructionWrites!==1||
           capture.nativeSessionId!==sessionId||
           capture.contextDigest!==initialContextDigest(instructions)||
           capture.generation!=='TEST-generation'||
           capture.configRevision!=='TEST-config')return undefined;
        const put=await call(entriesPath+'/host-context','PUT',
          {value:{instructions:capture.instructions,digest:capture.contextDigest}});
        if(signal.aborted||put.status!==204)return undefined;
        return readCurrentInstructions(capture,signal);
      },
      async readAndAttestInitialContext(capture,signal) {
        // Read-only current native GET; never resend the initial PUT.
        return readCurrentInstructions(capture,signal);
      },
      stopOwned:stop,
      async confirmStopped() {
        // Read-only physical check. Never repeat the stop signal after an
        // uncertain ACK, and never touch an unowned process group.
        return !present(secondPid)&&!present(-secondPid);
      },
    };
    const provider=createOpenCodeV2MemberProvider(context,owner);
    const opened=await provider.factory.open(context.request);
    if(!provider.isReady()||
       provider.initialContextEvidence?.()?.contextDigest!==
         initialContextDigest(instructions)||instructionWrites!==1)
      throw Error('TEST_persisted_HTTP_Host_SPI_not_ready');
    const rechecked=await opened.driver.checkReadiness();
    if(rechecked.ok!==true||!provider.isReady()||instructionWrites!==1||
       instructionReads!==3)
      throw Error('TEST_Host_SPI_context_reattest_or_replay_failed');
    receipt.hostSpiReadinessProven=true;
    receipt.steps.push('TEST_real_published_HTTP_Stage1_SPI_ready_no_model_turn');
    const closed=await opened.driver.close();
    if(closed.cleanup!=='confirmed'||!await provider.cleanup()||
       present(secondPid)||present(-secondPid))
      throw Error('TEST_Host_SPI_own_process_cleanup_unconfirmed');
    receipt.steps.push('TEST_Stage1_SPI_readiness_recheck_and_owned_cleanup_no_replay');
  } catch (e) {
    if (interruptionTask) await interruptionTask;
    receipt.failure = /^TEST_[A-Za-z0-9_]+$/.test(e?.message || '')
      ? e.message : 'TEST_published_HTTP_persist_unqualified';
    throw Error(receipt.failure);
  } finally {
    if (interruptionTask) {
      await interruptionTask;
    } else {
      receipt.cleanup=await stop().catch(()=>false);
      // SIGINT/SIGTERM may arrive while stop() is awaiting worker exit.
      // Its owner must finish the shared interruption receipt and process exit
      // before normal cleanup can write a competing success/failure receipt.
      if (interruptionTask) await interruptionTask;
      if(receipt.cleanup)rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
      writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n');
    }
  }
  if(!receipt.cleanup)throw Error('TEST_worker_cleanup_unknown');
}
