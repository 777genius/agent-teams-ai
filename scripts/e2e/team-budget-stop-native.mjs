// Native budget-stop E2E uses a real app-managed Windows teammate and
// verified PID/birth retirement; only usage telemetry is synthetic and local.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';

export async function proveNativeBudgetStop({client,api,wait,getProcess,ownedStillAlive,root,userDataRoot,request,foreignIdentity,expected,heldToolPidPath,waitForOwnedPowerShellDescendant}){
  const nativeTeamName = request.teamName + '-budget';
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
    assert(await ownedStillAlive(held),'Budget native tool exited before the budget update');
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
    assert(await ownedStillAlive(original) && await ownedStillAlive(held),
      'Native budget worker or held tool exited before over-budget evidence');
    const ledgerPath=path.join(userData,'data','token-usage','ledger.json');
    await mkdir(path.dirname(ledgerPath),{recursive:true});
    const previous=await readFile(ledgerPath,'utf8').then(JSON.parse).catch(e=>{
      if(e?.code==='ENOENT')return{schemaVersion:1,runs:{},events:{},sourceStates:{}};
      throw e;
    });
    assert.equal(previous.schemaVersion,1,'Unexpected existing usage ledger schema');
    const id='budget-stop-e2e-'+randomUUID();
    const at=new Date().toISOString();
    previous.runs[id]={
      appRunId:id,teamName:nativeTeamName,runtimeKind:'anthropic',
      startedAt:at,endedAt:at,status:'completed',source:'manual_import',sources:[]
    };
    previous.events[id+'-usage']={
      id:id+'-usage',appRunId:id,teamName:nativeTeamName,runtimeKind:'anthropic',
      tokens:{
        inputTokens:140,outputTokens:10,cacheCreationTokens:0,cacheReadTokens:0,
        reasoningTokens:0,audioTokens:0,imageTokens:0,totalTokens:150
      },
      cost:{estimatedUsd:0,billableUsd:0,apiEquivalentUsd:0,
        source:'unknown',billingMode:'unknown'},
      usageSourceKind:'log_parsed',occurredAt:at,createdAt:at
    };
    const temp=ledgerPath+'.'+randomUUID()+'.tmp';
    await writeFile(temp,JSON.stringify(previous,null,2)+'\n');
    await rename(temp,ledgerPath);
    await api('window.electronAPI.tokenUsage.refreshSnapshot()');
    const receipt=await wait('budget stop retires original native worker',async()=>{
      const status=await api('window.electronAPI.tokenUsage.getBudgetStatus()');
      const target=status.targets?.find(x=>x.scope==='team'&&x.id==='team:'+nativeTeamName);
      const metric=target?.metrics?.find(x=>x.metric==='tokens');
      if(target?.onExceeded!=='stop_team'||metric?.limit!==100||metric?.value!==150)return false;
      const nativeAlive=await ownedStillAlive(original);
      const toolAlive=await ownedStillAlive(held);
      const teamAlive=await api(`window.electronAPI.teams.processAlive(${JSON.stringify(nativeTeamName)})`);
      return !nativeAlive&&!toolAlive&&!teamAlive
        ? {memberPid:original.pid,memberBirth:original.creation,
           heldToolPid:held.pid,heldToolBirth:held.creation,heldToolRetired:true,
           used:metric.value,limit:metric.limit,
           settingsRevision:saved.updatedAt,ownedRuntimeStopped:true}
        : false;
    },180000);
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
