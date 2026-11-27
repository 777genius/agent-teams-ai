// Native budget-stop E2E uses a real app-managed Windows teammate and
// verified PID/birth retirement; only usage telemetry is synthetic and local.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';

export async function seedNativeBudgetStopLedger({root,userDataRoot,teamName}){
  const userData=path.resolve(userDataRoot),fixtureRoot=path.resolve(root);
  assert(userData.startsWith(fixtureRoot+path.sep),
    'Budget fixture must remain under the disposable Electron profile');
  const ledgerPath=path.join(userData,'data','token-usage','ledger.json');
  // Seed before the app starts. No competing analytics writer can clobber this
  // fixture, unlike a live read/rename performed during import refresh.
  await mkdir(path.dirname(ledgerPath),{recursive:true});
  const existing=await readFile(ledgerPath,'utf8').catch(e=>{
    if(e?.code==='ENOENT')return null;
    throw e;
  });
  assert.equal(existing,null,'Budget fixture may seed only a fresh, never-opened profile');
  const runId='budget-stop-e2e-'+randomUUID(),eventId=runId+'-usage';
  const at=new Date().toISOString();
  const ledger={schemaVersion:1,
    runs:{[runId]:{
      appRunId:runId,teamName,runtimeKind:'anthropic',startedAt:at,endedAt:at,
      status:'completed',source:'manual_import',sources:[]
    }},
    events:{[eventId]:{
      id:eventId,appRunId:runId,teamName,runtimeKind:'anthropic',
      tokens:{inputTokens:140,outputTokens:10,cacheCreationTokens:0,cacheReadTokens:0,
        reasoningTokens:0,audioTokens:0,imageTokens:0,totalTokens:150},
      cost:{estimatedUsd:0,billableUsd:0,apiEquivalentUsd:0,
        source:'unknown',billingMode:'unknown'},
      usageSourceKind:'log_parsed',occurredAt:at,createdAt:at
    }},
    sourceStates:{}
  };
  const temp=ledgerPath+'.'+randomUUID()+'.tmp';
  await writeFile(temp,JSON.stringify(ledger,null,2)+'\n');
  await rename(temp,ledgerPath);
  return{teamName,runId,eventId,ledgerPath,amount:150};
}

export async function proveNativeBudgetStop({client,api,wait,getProcess,ownedStillAlive,root,userDataRoot,request,foreignIdentity,expected,heldToolPidPath,waitForOwnedPowerShellDescendant,seed,budgetOwnedProcesses,findOriginalTeammateJobLauncher,mainBirth}){
  const nativeTeamName = request.teamName + '-budget';
  assert(seed?.teamName===nativeTeamName && seed?.amount===150,
    'Budget test must use the pre-start, owned 150-token fixture');
  const userData = path.resolve(userDataRoot);
  const fixtureRoot = path.resolve(root);
  assert(userData.startsWith(fixtureRoot + path.sep),
    'Budget E2E must never write outside the disposable profile');
  let created = false, qualified = false;
  try {
    const createRequest = {...request,teamName:nativeTeamName};
    await client.evaluate(`(() => {
      window.__nativeBudgetTeam={done:false};
      window.electronAPI.teams.createTeam(${JSON.stringify(createRequest)}).then(
        value => window.__nativeBudgetTeam={done:true,value},
        error => window.__nativeBudgetTeam={done:true,error:String(error)}
      );return true;
    })()`);
    const launch = await wait('genuine budget team creation',
      () => client.evaluate('window.__nativeBudgetTeam?.done ? window.__nativeBudgetTeam : null'),
      180000);
    if (launch.error) throw Error('Budget team native create failed: ' + launch.error);
    assert.equal(typeof launch.value?.runId,'string','Budget team lacked real product runId');
    created=true;
    const original = await wait('genuine budget team direct-process native worker',async()=>{
      const snapshot=await api(`window.electronAPI.teams.getTeamAgentRuntime(${JSON.stringify(nativeTeamName)})`);
      const worker=snapshot?.members?.alice,pid=worker?.runtimePid;
      if(snapshot?.runId!==launch.value.runId || !worker?.alive ||
         !worker.historicalBootstrapConfirmed || worker.backendType!=='process' ||
         !Number.isSafeInteger(pid) || pid<=0)return false;
      const identity=await getProcess(pid);
      return identity?.creation&&identity.command.includes(nativeTeamName)?identity:false;
    },180000);
    budgetOwnedProcesses.push({identity:original,marker:nativeTeamName});
    const launcher=await findOriginalTeammateJobLauncher(original,mainBirth);
    budgetOwnedProcesses.push({identity:launcher,marker:'teammate.exe'});
    assert(await ownedStillAlive(original),'Budget native worker exited before policy was configured');
    assert(await ownedStillAlive(foreignIdentity),'Unrelated baseline worker unavailable before budget stop');
    // Prove budget Stop retires a live descendant tool, not an idle worker
    // which might independently exit before the budget publication arrives.
    await rm(heldToolPidPath,{force:true});
    const holdToken=randomUUID(),holdKey='hold:'+holdToken;
    expected.set(holdKey,'WIN_BUDGET_HOLD_'+holdToken);
    await api(`window.electronAPI.teams.sendMessage(${JSON.stringify(nativeTeamName)},
      ${JSON.stringify({member:'alice',from:'user',text:'WIN_NATIVE_TOOL:'+holdKey})})`);
    const held=await waitForOwnedPowerShellDescendant(original.pid,
      'real held PowerShell descendant of budget-owned teammate',90000);
    budgetOwnedProcesses.push({identity:held,marker:'powershell.exe'});
    assert(await ownedStillAlive(original) && await ownedStillAlive(held),
      'Original budget worker or held tool exited before policy Save');
    const settings=await api('window.electronAPI.tokenUsage.getBudgetSettings()');
    const {updatedAt,...existing}=settings;
    const saved=await api(`window.electronAPI.tokenUsage.updateBudgetSettings(${JSON.stringify({
      teamIdentityVersion:1,
      expectedUpdatedAt:updatedAt??null,
      settings:{...existing,teams:{...existing.teams,
        ['team:'+nativeTeamName]:{
          monthlyTokenLimit:100,thresholds:[80,100],
          notificationsEnabled:false,onExceeded:'stop_team'
        }
      }}
    })})`);
    assert(typeof saved.updatedAt==='string','Native budget settings CAS revision missing');
    // Save itself publishes the over-budget status and may legitimately start
    // async stop before the IPC returns. Only pre-Save liveness is required.
    // Reuse the already-serialized application ledger; never write to it
    // while the genuine Electron importers and budget observer are running.
    await api('window.electronAPI.tokenUsage.refreshSnapshot()');
    const receipt=await wait('budget stop retires original native worker',async()=>{
      const status=await api('window.electronAPI.tokenUsage.getBudgetStatus()');
      const target=status.targets?.find(x=>x.scope==='team'&&x.id==='team:'+nativeTeamName);
      const metric=target?.metrics?.find(x=>x.metric==='tokens');
      if(target?.onExceeded!=='stop_team'||metric?.limit!==100||
         !Number.isFinite(metric?.value)||metric.value<150)return false;
      const nativeAlive=await ownedStillAlive(original);
      const toolAlive=await ownedStillAlive(held);
      const teamAlive=await api(`window.electronAPI.teams.processAlive(${JSON.stringify(nativeTeamName)})`);
      const aliveTeams=await api('window.electronAPI.teams.aliveList()');
      return !nativeAlive&&!toolAlive&&teamAlive===false&&
        Array.isArray(aliveTeams)&&!aliveTeams.includes(nativeTeamName)
        ? {memberPid:original.pid,memberBirth:original.creation,
           heldToolPid:held.pid,heldToolBirth:held.creation,heldToolRetired:true,
           used:metric.value,limit:metric.limit,
           settingsRevision:saved.updatedAt,ownedRuntimeStopped:true}
        : false;
    },180000);
    // Verify this exact synthetic event survived through native app imports.
    // Aggregate spend alone could otherwise give a false-positive stop proof.
    const ledger=JSON.parse(await readFile(seed.ledgerPath,'utf8'));
    assert.equal(ledger.runs?.[seed.runId]?.teamName,nativeTeamName,
      'Fixture run was overwritten by a concurrent writer');
    assert.equal(ledger.events?.[seed.eventId]?.appRunId,seed.runId,
      'Unique budget fixture usage event was lost');
    assert.equal(ledger.events[seed.eventId].tokens?.totalTokens,seed.amount,
      'Fixture attribution amount was unexpectedly changed');
    assert(await ownedStillAlive(foreignIdentity),
      'Budget stop crossed team ownership and retired unrelated native teammate');
    qualified=true;
    return{...receipt,teamName:nativeTeamName,unrelatedTeamStillAlive:true,
      modelBoundary:'synthetic local ledger, genuine native team lifecycle'};
  }finally{
    if(created&&!qualified){
      await api(`window.electronAPI.teams.stop(${JSON.stringify(nativeTeamName)})`)
        .catch(()=>undefined);
    }
  }
}
