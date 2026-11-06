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
  const text=await response.text();
  if(Buffer.byteLength(text)>1024*1024)throw Error('unbounded_native_response');
  return { status:response.status, data:text?JSON.parse(text):undefined };
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
  const owner={
    requiredExternalDirectory:'deny',
    readPassword:()=>password,
    async probe(signal) {
      const result=await native('/api/info','GET',undefined,signal);
      return result.status===200&&result.data?.pid===child.pid&&
        startIdentity(child.pid)===startTicks;
    },
    async readNativeEffectivePermissions(signal) {
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
  receipt.steps.push('Host_native_readiness_recheck_no_instruction_replay');
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
  if(!await stopOwned())throw Error('restarted_native_process_tree_cleanup_unconfirmed');
  receipt.steps.push('same_TEST_native_owner_restart_cleanup_confirmed');
} catch(error) {
  receipt.error=String(error?.stack||error);
  process.exitCode=1;
} finally {
  try {
    if(!receipt.cleanup && child?.pid) {
      const ok=await stopOwned();
      if(!ok)throw Error('native_TEST_process_cleanup_unconfirmed');
    }
  } catch(error) {
    receipt.error=(receipt.error||'')+' cleanup:'+String(error);
    process.exitCode=1;
  }
  try { writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n'); } catch {}
  if(receipt.cleanup)rmSync(root,{recursive:true,force:true});
}
if(process.exitCode)throw Error('native Host V2.0.21 TEST proof failed; inspect receipt');
