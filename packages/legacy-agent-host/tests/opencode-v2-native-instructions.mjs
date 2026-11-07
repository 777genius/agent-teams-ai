// TEST-only real OpenCode V2.0.21 native Host SPI/instruction-entry slice.
// Not a production process owner, packaged Electron, or full V01–V08 proof.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, realpathSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createOpenCodeV2MemberProvider } from '../dist/adapters/providers/OpenCodeV2MemberProvider.js';
import { initialContextDigest } from '../dist/team-launch/context.js';
import { preflightOpenCodeV2EffectiveExternalDirectory } from '../dist/composition/openCodeV2StaticPreflight.js';
import { parseOwnedDurableLog, retainsOwnedDurablePrefix } from './opencode-v2-native-log-parse.mjs';

const version = '2.0.21';
const pinnedLinuxX64Avx2Digest = 'f916986543348d7953d8d43aa048516cdbc3f84f4d0dc9c0c5b9d1da3030cea7';
const receiptPath = resolve(process.env.OPENCODE_V2_HOST_NATIVE_RECEIPT || 'opencode-v2-host-native-instructions.json');
const receipt = { kind: 'TEST_NATIVE_HOST_SPI_INSTRUCTIONS', version, qualified: false,
  productQualified: false, packagedElectronQualified: false, steps: [], cleanup: false };
const root = mkdtempSync(join(tmpdir(), 'TEST-stage1-v2-host-'));
const workspace = join(root, 'workspace');
for (const part of ['workspace','home','config','cache','data','state','temp']) mkdirSync(join(root,part));
const password = randomBytes(24).toString('hex');
const env = {
  PATH: process.env.PATH || '/usr/bin:/bin',
  HOME: join(root,'home'), XDG_CONFIG_HOME: join(root,'config'),
  XDG_CACHE_HOME: join(root,'cache'), XDG_DATA_HOME: join(root,'data'),
  XDG_STATE_HOME: join(root,'state'), TMPDIR: join(root,'temp'),
  OPENCODE_SERVER_PASSWORD: password, CI: 'true', NO_COLOR: '1',
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
let child, startTicks, stopRequested = false, nativeSessionId, endpoint;
const binaryRoot = process.env.OPENCODE_V2_TEST_NPM_ROOT;
function startIdentity(pid) {
  try {
    const raw = readFileSync('/proc/' + pid + '/stat', 'utf8');
    const end = raw.lastIndexOf(') ');
    if (end < 0) throw Error('invalid_proc_stat');
    const fields = raw.slice(end+2).trim().split(/\s+/);
    if (!/^\d+$/.test(fields[19] || '') || Number(fields[2]) !== pid || Number(fields[3]) !== pid)
      throw Error('native_process_group_not_isolated');
    return fields[19];
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}
function present(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error?.code === 'ESRCH') return false; throw error; }
}
async function stopOwned() {
  if (!child?.pid) { receipt.cleanup = true; return true; }
  const pid = child.pid;
  if (!stopRequested) {
    if (startIdentity(pid) !== startTicks) return false;
    stopRequested = true;
    try { process.kill(-pid, 'SIGTERM'); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  return confirmStopped();
}
async function confirmStopped() {
  if (!child?.pid) return true;
  for (let i=0;i<35;i++) {
    if (!present(child.pid) && !present(-child.pid)) {
      receipt.cleanup = true; return true;
    }
    await delay(100);
  }
  return false;
}
async function port() {
  const s = createServer();
  await new Promise((ok,reject)=>s.once('error',reject).listen(0,'127.0.0.1',ok));
  const address=s.address(); if (!address || typeof address==='string') throw Error('invalid_loopback_port');
  await new Promise((ok,reject)=>s.close(error=>error?reject(error):ok()));
  return address.port;
}
async function readBoundedNativeBody(response, errorCode) {
  // Bound the actual network read, not only the decoded body after buffering.
  // A native 204 response legitimately has no body.
  if (!response.body) return '';
  const chunks=[];
  let bytes=0;
  for await (const chunk of response.body) {
    bytes+=chunk.byteLength;
    if(bytes>1024*1024)throw Error(errorCode);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function native(path, method='GET', body, signal=AbortSignal.timeout(12000)) {
  if (!endpoint || !path.startsWith('/api/') && !path.startsWith('/api/experimental/'))
    throw Error('non_owned_native_route');
  const response=await fetch(endpoint+path, {
    method, redirect: 'error',
    headers: {
      authorization: 'Basic '+Buffer.from('opencode:'+password).toString('base64'),
      ...(body===undefined?{}:{'content-type':'application/json'}),
    },
    body: body===undefined?undefined:JSON.stringify(body), signal,
  });
  const text=await readBoundedNativeBody(response,'unbounded_native_response');
  return { status:response.status, data:text?JSON.parse(text):undefined };
}
// Read-only durable cursor proof, reusable across the original native process
// and an independently attested cold restart. Never submit a model turn.
async function readOwnedDurableLog(sessionId) {
  const path='/api/experimental/session/'+encodeURIComponent(sessionId)+'/log?follow=false';
  const response=await fetch(endpoint+path, {
    redirect:'error',signal:AbortSignal.timeout(12000),
    headers:{authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64')},
  });
  if(response.status!==200)throw Error('native_durable_log_read_unconfirmed');
  const body=await readBoundedNativeBody(response,'native_durable_log_read_unconfirmed');
  const fingerprints=[];
  const cursor=parseOwnedDurableLog(body,sessionId,workspace,
    event=>fingerprints.push(digest(JSON.stringify(event))));
  return {...cursor,fingerprints};
}
try {
  if (process.platform !== 'linux' || process.arch !== 'x64' ||
      !binaryRoot?.startsWith('/')) throw Error('unsupported_TEST_host');
  if (!/avx2/i.test(readFileSync('/proc/cpuinfo','utf8'))) throw Error('avx2_TEST_pin_unavailable');
  const packageRoot=realpathSync(binaryRoot);
  const dir=realpathSync(join(packageRoot,'cli-linux-x64'));
  if(!dir.startsWith(packageRoot+'/'))throw Error('native_package_not_owned');
  const pkg=JSON.parse(readFileSync(join(dir,'package.json'),'utf8'));
  if(pkg.name!=='@opencode/cli-linux-x64'||pkg.version!==version)
    throw Error('native_package_mismatch');
  const binary=realpathSync(join(dir,'bin','opencode'));
  if(!binary.startsWith(dir+'/'))throw Error('native_binary_escape');
  const bytes=readFileSync(binary);
  if(bytes.subarray(0,4).toString('hex')!=='7f454c46')throw Error('not_native_elf');
  const hash=digest(bytes);
  if(hash!==pinnedLinuxX64Avx2Digest)throw Error('native_binary_sha256_mismatch');
  // Bind this publicly downloadable TEST proof to the exact PR source HEAD,
  // not the synthetic pull_request merge checkout or a stale workflow run.
  const sourceHead=process.env.OPENCODE_V2_TEST_SOURCE_HEAD;
  if(!/^[a-f0-9]{40}$/.test(sourceHead||'')||
     execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',timeout:5000}).trim()!==sourceHead)
    throw Error('native_source_head_mismatch');
  receipt.sourceHead=sourceHead;
  receipt.binarySha256=hash;
  receipt.steps.push('pinned_actual_ELF_measured');
  if(execFileSync(binary,['--version'],{cwd:workspace,env,encoding:'utf8',timeout:12000}).trim()
      !== 'opencode v'+version)throw Error('binary_version_mismatch');
  const p=await port();
  child=spawn(binary,['serve','--hostname','127.0.0.1','--port',String(p)],
    {cwd:workspace,env,detached:true,stdio:'ignore'});
  await once(child,'spawn');
  if(!child.pid)throw Error('owned_native_pid_missing');
  startTicks=startIdentity(child.pid);
  if(!startTicks || digest(readFileSync('/proc/'+child.pid+'/exe'))!==hash)
    throw Error('actual_engine_identity_mismatch');
  receipt.pid=child.pid;receipt.processStartTicks=startTicks;
  receipt.steps.push('actual_native_PID_start_and_digest');
  endpoint='http://127.0.0.1:'+p;
  let info;
  for(let i=0;i<70;i++) {
    try { const value=await native('/api/info'); if(value.status===200){info=value.data;break;} }
    catch { /* TEST server startup only; never retry a mutating request */ }
    await delay(150);
  }
  if(info?.pid!==child.pid||info.version!==version)throw Error('native_server_pid_or_version');
  receipt.steps.push('native_loopback_authenticated_identity');
  // A TEST-native server must not accidentally expose its management API
  // without authentication, including after the same isolated HOME restarts.
  const unauthenticated=await fetch(endpoint+'/api/info',{redirect:'error',signal:AbortSignal.timeout(4000)});
  if(unauthenticated.status!==401)throw Error('native_loopback_auth_not_enforced');
  receipt.steps.push('native_loopback_unauthenticated_request_rejected');
  const permissionRules=[{action:'external_directory',resource:'*',effect:'deny'}];
  const created=await native('/api/session','POST',{
    location:{directory:workspace},
    agent:'build',model:{providerID:'TEST-provider',id:'TEST-model'},
    permissions:permissionRules,
  });
  nativeSessionId=created.data?.data?.id;
  if(created.status!==200||!/^ses_[A-Za-z0-9_-]+$/.test(nativeSessionId||''))
    throw Error('native_session_create_unconfirmed');
  receipt.steps.push('native_TEST_session_created_no_model_call');
  // Real native ordering negative: a later allow must defeat an earlier deny
  // for this disposable second TEST session, and the Host must refuse it.
  // Never execute a model turn or create out-of-workspace files.
  const unsafeRules=[
    {action:'external_directory',resource:'*',effect:'deny'},
    {action:'external_directory',resource:'*',effect:'allow'},
  ];
  const unsafe=await native('/api/session','POST',{
    location:{directory:workspace}, permissions:unsafeRules,
  });
  const unsafeId=unsafe.data?.data?.id;
  if(unsafe.status!==200||!/^ses_[A-Za-z0-9_-]+$/.test(unsafeId||'')||
     unsafeId===nativeSessionId)throw Error('native_second_TEST_session_missing');
  const unsafePath='/api/session/'+encodeURIComponent(unsafeId);
  const unsafeRead=await native(unsafePath);
  if(unsafeRead.status!==200||unsafeRead.data?.data?.id!==unsafeId||
     JSON.stringify(unsafeRead.data.data.permissions)!==JSON.stringify(unsafeRules))
    throw Error('native_ordered_permissions_readback_mismatch');
  const unsafePolicy=preflightOpenCodeV2EffectiveExternalDirectory(
    unsafeRead.data.data.permissions,'deny');
  if(unsafePolicy.kind!=='hold'||unsafePolicy.reason!=='external-directory')
    throw Error('Host_accepted_native_later_allow_override');
  const unsafeDelete=await native(unsafePath,'DELETE');
  if(unsafeDelete.status!==204)throw Error('native_second_TEST_session_delete_failed');
  receipt.steps.push('real_native_later_allow_override_refused_by_Host');
  // Native positive readback for V2's ordered ASK shape, isolated from the
  // captured DENY session. This proves only config/order preservation, NOT
  // actual model/tool permission enforcement (which remains a HOLD).
  const askRules=[
    {action:'external_directory',resource:'*',effect:'deny'},
    {action:'external_directory',resource:'*',effect:'ask'},
  ];
  const askSession=await native('/api/session','POST',{
    location:{directory:workspace},permissions:askRules,
  });
  const askId=askSession.data?.data?.id;
  if(askSession.status!==200||!/^ses_[A-Za-z0-9_-]+$/.test(askId||'')||
     askId===nativeSessionId||askId===unsafeId)
    throw Error('native_ask_TEST_session_missing');
  const askPath='/api/session/'+encodeURIComponent(askId);
  const askRead=await native(askPath);
  if(askRead.status!==200||askRead.data?.data?.id!==askId||
     JSON.stringify(askRead.data.data.permissions)!==JSON.stringify(askRules))
    throw Error('native_ask_permission_order_readback_mismatch');
  if(preflightOpenCodeV2EffectiveExternalDirectory(
    askRead.data.data.permissions,'ask').kind!=='policy-candidate')
    throw Error('Host_refused_native_effective_ask');
  const denyGuard=preflightOpenCodeV2EffectiveExternalDirectory(
    askRead.data.data.permissions,'deny');
  if(denyGuard.kind!=='hold'||denyGuard.reason!=='external-directory')
    throw Error('Host_weakened_captured_deny_to_ask');
  if((await native(askPath,'DELETE')).status!==204)
    throw Error('native_ask_TEST_session_delete_failed');
  receipt.steps.push('real_native_ordered_ask_readback_without_tool_execution');
  const sessionPath='/api/session/'+encodeURIComponent(nativeSessionId);
  const instructions='TEST-only Host role, team and workspace. Do not execute real tools.';
  const context={request:{
    tenantId:'TEST-tenant',projectId:'TEST-project',sessionId:'TEST-session',
    generation:1,configRevision:'TEST-config',requiredCapabilities:['text'],
  },profile:{
    provider:'opencode',nativeGeneration:'v2',protocolRevision:version,
    cwd:workspace,environment:env,executable:{path:binary,sha256:hash},
    teamId:'TEST-team',memberId:'TEST-member',principalId:'TEST-principal',
    sessionId:'TEST-session',generation:1,configRevision:'TEST-config',
    model:'TEST-model',accountBinding:'TEST-account',endpoint,
    nativeSessionId,limits:{queuedInputs:2,inputBytes:8192,outputBytes:8192,
      outputEvents:100,pendingInteractions:2,timeoutMs:12000},
    nativeOptions:{providerId:'TEST-provider',agent:'build'},
  },endpoint:{binding:{backendId:'TEST-backend',teamId:'TEST-team',
    runId:'TEST-run',memberId:'TEST-member',generation:'TEST-generation'}},
  instructions,isCurrent:()=>true,canAllocate:()=>true,
  onProgress:()=>{},readCheckpoint:async()=>undefined};
  let initialPutCount=0;
  let nativeCustodyReads=0;
  let nativePermissionReads=0;
  const owner={
    requiredExternalDirectory:'deny',
    readPassword:()=>password,
    async probe(signal) {
      const result=await native('/api/info','GET',undefined,signal);
      return result.status===200&&result.data?.pid===child.pid&&
        startIdentity(child.pid)===startTicks;
    },
    async readNativeCustody(signal) {
      // The CLI wrapper's PID or npm/release archive digest is insufficient:
      // every Host readiness check must measure the actual running ELF and
      // bind the same TEST-owned PID and /proc start-ticks identity.
      const observed=await native('/api/info','GET',undefined,signal);
      if(observed.status!==200||observed.data?.pid!==child.pid||
         observed.data?.version!==version||startIdentity(child.pid)!==startTicks)
        return undefined;
      const measuredPath=realpathSync('/proc/'+child.pid+'/exe');
      const measuredSha256=digest(readFileSync('/proc/'+child.pid+'/exe'));
      nativeCustodyReads++;
      return {executablePath:measuredPath,executableSha256:measuredSha256,
        pid:child.pid,startIdentity:startTicks,version:observed.data.version};
    },
    async readNativeEffectivePermissions(signal) {
      nativePermissionReads++;
      const result=await native(sessionPath,'GET',undefined,signal);
      if(result.status!==200||result.data?.data?.id!==nativeSessionId)
        throw Error('native_session_readback_mismatch');
      return result.data.data.permissions;
    },
    async installAndAttestInitialContext(capture,signal) {
      if(capture.nativeSessionId!==nativeSessionId ||
         capture.contextDigest!==initialContextDigest(capture.instructions) ||
         capture.generation!=='TEST-generation'||capture.configRevision!=='TEST-config')
        return undefined;
      if(++initialPutCount!==1)throw Error('instruction_mutation_replayed');
      const key='host-context';
      const path='/api/experimental/session/'+encodeURIComponent(nativeSessionId)+
        '/instructions/entries';
      const put=await native(path+'/'+key,'PUT',
        {value:{instructions:capture.instructions,digest:capture.contextDigest}},signal);
      if(put.status!==204)throw Error('native_instruction_put_unconfirmed');
      const get=await native(path,'GET',undefined,signal);
      const entries=get.data?.data;
      if(get.status!==200||!Array.isArray(entries)||
         entries.filter(x=>x?.key===key).length!==1 ||
         JSON.stringify(entries.find(x=>x?.key===key)?.value)!==
           JSON.stringify({instructions:capture.instructions,digest:capture.contextDigest}))
        throw Error('native_instruction_readback_mismatch');
      receipt.steps.push('actual_native_instruction_put_and_readback');
      return {nativeSessionId,contextDigest:capture.contextDigest,
        generation:capture.generation,configRevision:capture.configRevision};
    },
    stopOwned,confirmStopped,
  };
  const provider=createOpenCodeV2MemberProvider(context,owner);
  const opened=await provider.factory.open(context.request);
  if(!provider.isReady() ||
     provider.initialContextEvidence?.()?.contextDigest!==initialContextDigest(instructions)||
     initialPutCount!==1)throw Error('host_spi_context_evidence_missing');
  receipt.steps.push('Host_existing_Session_SPI_ready_with_real_native_attestation');
  // Re-enter the REAL Host SPI after the native instructions PUT. The same
  // owned session may be probed again, but the mutation must never be sent
  // again (especially after an uncertain first ACK).
  const rechecked=await opened.driver.checkReadiness();
  if(rechecked.ok!==true || !provider.isReady() || initialPutCount!==1)
    throw Error('native_host_recheck_replayed_initial_context');
  if(nativeCustodyReads!==4||nativePermissionReads!==4)
    throw Error('Host_failed_to_remeasure_actual_native_binary_and_PID');
  receipt.nativeCustodyReadbacks=nativeCustodyReads;
  receipt.nativePermissionReadbacks=nativePermissionReads;
  receipt.steps.push('Host_remeasured_real_ELF_digest_PID_and_start_identity_on_recheck');
  receipt.steps.push('Host_native_readiness_recheck_no_instruction_replay');
  // Stock V2 can ACK a prompt without retaining durable session events.
  // Read the real pinned native session log BEFORE any model/tool execution:
  // this is a cursor observation, never an authorization to submit a turn.
  const freshLog=await readOwnedDurableLog(nativeSessionId);
  // Only schema, count and watermark may enter a publicly downloadable receipt.
  receipt.nativeLogReadback={readOnly:true,synced:true,watermark:freshLog.watermark,
    eventCount:freshLog.eventCount,modelTurnProven:false};
  receipt.steps.push('real_native_fresh_session_durable_log_cursor_read_only');
  // Seal is synchronous revocation. The exact owner must initiate the real
  // native process-group stop before driver.close()/cleanup() are requested.
  // No shared/user process is touched and no native mutation is replayed.
  provider.seal();
  for(let i=0;i<25&&!stopRequested;i++)await delay(20);
  if(!stopRequested||provider.isReady()||
     provider.initialContextEvidence?.()!==undefined)
    throw Error('Host_seal_failed_to_initiate_owned_native_stop');
  receipt.steps.push('Host_seal_started_real_native_owned_stop_before_close');
  // With an actual native engine behind the compiled Host SPI, a retained
  // driver handle cannot bypass the sealed owner's permission/interrupt/submit
  // controls or recover a checkpoint. No model/provider credentials are used.
  const refusedSubmit=await opened.driver.submit({
    inputId:'TEST-sealed-no-post',operationRef:'TEST-sealed-op',
    content:'TEST only; MUST NOT send to native engine',
  });
  if(refusedSubmit.ok!==false||refusedSubmit.code!=='unavailable'||
     refusedSubmit.delivery!=='known-not-sent')
    throw Error('sealed_Host_reused_native_submit');
  const refusedGrant=await opened.driver.respondToInteraction('perTEST-foreign',
    {kind:'permission',decision:'allow'});
  const refusedInterrupt=await opened.driver.interrupt('TEST-foreign-operation');
  const refusedReadiness=await opened.driver.checkReadiness();
  const refusedCheckpoint=opened.driver.checkpoint();
  if([refusedGrant,refusedInterrupt,refusedReadiness,refusedCheckpoint]
      .some(reply=>reply.ok!==false||reply.code!=='unavailable')||
     initialPutCount!==1||nativeCustodyReads!==4||nativePermissionReads!==4)
    throw Error('sealed_Host_reused_native_control_or_readiness');
  receipt.steps.push('real_native_seal_refused_retained_SPI_mutations_and_checkpoint');

  const closed=await opened.driver.close();
  if(closed.cleanup!=='confirmed'||provider.isReady()||
     !await provider.cleanup())throw Error('host_native_stop_not_confirmed');
  receipt.steps.push('same_TEST_native_owner_closed_without_replay');
  // Cold restart is a new TEST-owned process, never a silent reuse of the
  // previous PID/start identity. Verify read-only native session/instructions
  // recovery without resubmitting any mutation or launching a model turn.
  const priorPid=child.pid, priorStartTicks=startTicks;
  if(present(priorPid)||present(-priorPid))
    throw Error('prior_native_process_tree_still_alive');
  child=undefined;
  startTicks=undefined;
  stopRequested=false;
  receipt.cleanup=false;
  const resumedPort=await port();
  child=spawn(binary,['serve','--hostname','127.0.0.1','--port',String(resumedPort)],
    {cwd:workspace,env,detached:true,stdio:'ignore'});
  await once(child,'spawn');
  if(!child.pid)throw Error('restarted_native_pid_missing');
  startTicks=startIdentity(child.pid);
  if(!startTicks ||
     (child.pid===priorPid&&startTicks===priorStartTicks) ||
     digest(readFileSync('/proc/'+child.pid+'/exe'))!==hash)
    throw Error('restarted_actual_engine_identity_mismatch');
  endpoint='http://127.0.0.1:'+resumedPort;
  let resumedInfo;
  for(let i=0;i<70;i++) {
    try {
      const result=await native('/api/info');
      if(result.status===200){resumedInfo=result.data;break;}
    } catch { /* Read-only restart readiness, never retry a mutation. */ }
    await delay(150);
  }
  if(resumedInfo?.pid!==child.pid||resumedInfo.version!==version)
    throw Error('restarted_native_server_identity_unconfirmed');
  const resumedUnauthenticated=await fetch(endpoint+'/api/info',
    {redirect:'error',signal:AbortSignal.timeout(4000)});
  if(resumedUnauthenticated.status!==401)
    throw Error('restarted_native_loopback_auth_not_enforced');
  const resumed=await native(sessionPath);
  if(resumed.status!==200||resumed.data?.data?.id!==nativeSessionId||
     JSON.stringify(resumed.data.data.permissions)!==JSON.stringify(permissionRules))
    throw Error('native_cold_restart_session_permission_mismatch');
  const restoredInstructions=await native('/api/experimental/session/'+
    encodeURIComponent(nativeSessionId)+'/instructions/entries');
  if(restoredInstructions.status!==200||
     !Array.isArray(restoredInstructions.data?.data)||
     restoredInstructions.data.data.filter(x=>x?.key==='host-context').length!==1||
     JSON.stringify(restoredInstructions.data.data.find(x=>x?.key==='host-context')?.value)!==
       JSON.stringify({instructions,digest:initialContextDigest(instructions)})||
     initialPutCount!==1)
    throw Error('native_cold_restart_instructions_missing_or_replayed');
  receipt.restart={priorPid,priorStartTicks,pid:child.pid,
    startTicks,actualBinarySha256:hash,readOnly:true};
  receipt.steps.push('native_cold_restart_session_permissions_and_context_read_only');
  // Reopen the EXACT same durable log against a different, freshly attested
  // TEST-owned PID. No prompt, permissions reply or instruction mutation occurs.
  const recoveredLog=await readOwnedDurableLog(nativeSessionId);
  if(!retainsOwnedDurablePrefix(freshLog,recoveredLog))
    throw Error('native_cold_restart_durable_log_prefix_mismatch');
  receipt.restartLogReadback={readOnly:true,synced:true,watermark:recoveredLog.watermark,
    eventCount:recoveredLog.eventCount,modelTurnProven:false};
  receipt.steps.push('native_cold_restart_durable_log_cursor_read_only');
  if(!await stopOwned())throw Error('restarted_native_process_tree_cleanup_unconfirmed');
  receipt.steps.push('same_TEST_native_owner_restart_cleanup_confirmed');
} catch {
  // This TEST artifact is publicly downloadable. Native/Node exceptions may
  // contain runner paths, credentials or raw HTTP payloads; never serialize
  // their message, cause or stack. The completed step list locates the phase.
  receipt.error='native_host_test_failed';
  process.exitCode=1;
} finally {
  try {
    if(!receipt.cleanup && child?.pid) {
      const ok=await stopOwned();
      if(!ok)throw Error('native_TEST_process_cleanup_unconfirmed');
    }
  } catch {
    // Cleanup uncertainty stays visible without leaking arbitrary exception text.
    receipt.cleanupError='native_process_cleanup_unconfirmed';
    process.exitCode=1;
  }
  // No process allocation means there is no child tree to clean up.
  // This makes pre-allocation failures clean without inventing PID custody.
  if (!child?.pid) receipt.cleanup=true;
  try { writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n'); }
  catch { process.exitCode=1; } // A missing proof receipt must fail the job.
  if(receipt.cleanup)rmSync(root,{recursive:true,force:true});
}
if(process.exitCode)process.stderr.write('native_host_test_failed; inspect sanitized receipt\n');
