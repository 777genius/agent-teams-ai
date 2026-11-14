import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { startHost, tick, fileHash } from './fixtures/native-host.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';

const scalar = (value: unknown): Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test('original captured Host forwards native Claude follow-up for the exact human DM, never a new user turn', {
  timeout: 125_000,
}, async t => {
  assert.equal(process.env.NATIVE_SUGGESTIONS_HOST_GO, '1', 'explicit finite TEST gate');
  const repo = resolve(import.meta.dirname, '../../..');
  const node = await realpath(process.execPath);
  assert.match(process.version, /^v24\.21\.0$/u);
  const entry = await realpath(join(repo, 'packages/legacy-agent-host/dist/cli.js'));
  const providerEntry = await realpath(join(repo, 'packages/legacy-agent-host/node_modules/@agent-teams/provider-implementations/dist/claude.js'));
  const sdk = createRequire(providerEntry).resolve('@anthropic-ai/claude-agent-sdk');
  const sdkPackage = JSON.parse(await readFile(join(dirname(sdk), 'package.json'), 'utf8'));
  assert.equal(sdkPackage.version, '0.3.305');
  const binary = await realpath(createRequire(sdk).resolve('@anthropic-ai/claude-agent-sdk-linux-x64/claude'));
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-followup-host-')));
  const relative = ['workspace','store','home','config','tmp','xdg-config','xdg-data','xdg-cache'];
  for (const p of relative) await mkdir(join(root,p),{recursive:true,mode:0o700});
  const prompt = 'TEST_NATIVE_HUMAN_DIRECT_' + randomUUID();
  const received: Record<string, unknown>[] = [];
  const bodies: { inputHasHuman: boolean; kind: string; tools: number }[] = [];
  const errors: string[] = [];
  let host: ReturnType<typeof startHost> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let receipt: Record<string, unknown> = { passed: false, note: 'not executed' };
  const frames = (response: import('node:http').ServerResponse, id: number) => {
    const event = (type: string, body: object) => response.write(
      'event: '+type+'\ndata: '+JSON.stringify({type,...body})+'\n\n'
    );
    response.writeHead(200,{'content-type':'text/event-stream'});
    event('message_start',{message:{id:'msg_TEST_'+id,type:'message',role:'assistant',
      model:'claude-sonnet-4-6',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:20,output_tokens:0}}});
    event('content_block_start',{index:0,content_block:{type:'text',text:''}});
    event('content_block_delta',{index:0,delta:{type:'text_delta',text:id===1?'Completed TEST user request.':'Review the completed TEST request.'}});
    event('content_block_stop',{index:0});
    event('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:9}});
    event('message_stop',{});
    response.end();
  };
  try {
    server=createServer((req,res)=>{
      void (async()=>{
        assert.equal(req.method,'POST');
        if(req.url?.includes('/count_tokens')) {res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":20}');return}
        assert.ok(req.url?.startsWith('/v1/messages'),'only local Anthropic Messages calls allowed');
        let buffer=Buffer.alloc(0);
        for await(const chunk of req){buffer=Buffer.concat([buffer,Buffer.from(chunk)]);
          if(buffer.byteLength>1024*1024)throw new Error('TEST input budget exceeded')}
        const data=scalar(JSON.parse(buffer.toString('utf8')));
        const source=JSON.stringify(data.messages??[]);
        const hasHuman=source.includes(prompt);
        bodies.push({inputHasHuman:hasHuman,kind:hasHuman?'human-context':'unknown',tools:Array.isArray(data.tools)?data.tools.length:0});
        assert.equal(hasHuman,true,'native inference belongs to exact original human message');
        assert.ok(bodies.length<=5,'do not amplify model calls without user request');
        frames(res,bodies.length);
      })().catch((err:unknown)=>{
        errors.push(String(err instanceof Error?err.message:'unknown'));
        if(!res.headersSent)res.writeHead(400);
        res.end('TEST local Anthropic model refused');
      });
    });
    server.requestTimeout=20_000;
    await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',()=>resolve()));
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const namespace='TEST-'+randomUUID();
    const owner={
      ownerId:'TEST-owner-'+namespace,revision:'TEST-revision',
      storageRoot:join(root,'store'),profileId:'TEST-profile-'+namespace,
      protocolVersion:1 as const,buildId:'TEST-native-host-suggestions',
      nodeSha256:await fileHash(node),hostEntrySha256:await fileHash(entry),
    };
    const scope={
      projectId:'TEST-project-'+namespace,workspaceId:'TEST-workspace-'+namespace,
      teamId:'TEST-team-'+namespace,runId:'TEST-run-'+namespace,memberId:'human',generation:'1',
    };
    const teamBinding={backendId:owner.ownerId,teamId:scope.teamId,teamName:'TEST-followups'};
    const delivery={...teamBinding,runId:scope.runId,memberId:'alice-id',generation:'1'};
    const sessionId='TEST-session-'+namespace;
    const profile:TeamHostProfile={
      schemaVersion:1,owner,principalId:'human',
      promptSuggestions:{enabled:true},
      teams:[{scope,binding:teamBinding,
        members:[{memberId:'alice-id',name:'alice',role:'member',delivery}],
        grants:[
          {principalId:'human',memberName:'user',permissions:['read','message.write','task.write','admin']},
          {principalId:'alice-session',memberName:'alice',permissions:['read','message.write','task.write']},
        ],
      }],
      runtime:{members:[{
        teamId:scope.teamId,memberId:'alice-id',principalId:'alice-session',provider:'claude',
        sessionId,generation:1,configRevision:'TEST-native-suggestions',
        cwd:join(root,'workspace'),model:'claude-sonnet-4-6',accountBinding:'TEST-no-real-auth',
        executable:{path:binary,sha256:await fileHash(binary)},
        environment:{
          HOME:join(root,'home'),CLAUDE_CONFIG_DIR:join(root,'config'),
          TMPDIR:join(root,'tmp'),XDG_CONFIG_HOME:join(root,'xdg-config'),
          XDG_DATA_HOME:join(root,'xdg-data'),XDG_CACHE_HOME:join(root,'xdg-cache'),
          PATH:dirname(node)+':/usr/bin:/bin',
          ANTHROPIC_API_KEY:'TEST-LOCALHOST-ONLY',
          ANTHROPIC_BASE_URL:'http://127.0.0.1:'+address.port,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',DISABLE_AUTOUPDATER:'1',
          DISABLE_ERROR_REPORTING:'1',DISABLE_TELEMETRY:'1',
          NO_COLOR:'1',TERM:'dumb',
        },
        nativeTools:[],autoAllowedTools:[],
        nativeOptions:{projectInstructions:{append:'TEST native authorized member alice.'}},
        limits:{queuedInputs:2,inputBytes:8192,outputBytes:1_000_000,outputEvents:1500,
          pendingInteractions:2,timeoutMs:40_000},
      }]},
    };
    const serialized=JSON.stringify(profile),profilePath=join(root,'profile.json');
    await writeFile(profilePath,serialized,{mode:0o600,flag:'wx'});
    const envelope=(commandId:string,payload:unknown)=>({
      commandId,binding:{schemaVersion:1,handleId:'TEST-handle-'+namespace,owner,scope},payload,
    });
    host=startHost({node,entry,root,profile:profilePath,profileHash:sha(serialized),
      onNotification:(method,value)=>{
        if(method==='runtime.prompt-suggestion.updated')received.push(scalar(value));
      }});
    const initial=await host.rpc('host.handshake',{protocolVersion:1});
    assert.ok((initial.capabilities as string[]).includes('runtime.member-session'));
    const launchRead=await host.rpc('team.launch.read',envelope('TEST-launch-read',{}));
    assert.equal(launchRead.ok,true);
    const selection=scalar(launchRead.value);
    const started=await host.rpc('team.launch.start',envelope('TEST-launch',{
      launchId:selection.launchId,rosterRevision:selection.rosterRevision,
      configuration:{members:[{memberId:'alice-id',model:'claude-sonnet-4-6',
        effort:'low',fastMode:false,permissions:'bypass',context:'model-default'}]},
    }));
    assert.equal(started.ok,true,'original Host launches same selected native SDK');
    const readyUntil=Date.now()+35_000;let ready=false;
    while(Date.now()<readyUntil){
      const state=await host.rpc('runtime.read',envelope('TEST-ready',{memberId:'alice-id'}));
      if(state.ok&&scalar(state.value).nativeReady===true){ready=true;break}
      await tick();
    }
    assert.equal(ready,true,'native original Claude readiness');
    const beforeSend=await host.rpc('runtime.read',envelope('TEST-before-send',{memberId:'alice-id'}));
    assert.equal(beforeSend.ok,true);
    const baseline=(scalar(beforeSend.value).inputs as unknown[]|undefined)?.map(scalar)??[];
    assert.ok(baseline.every(row=>typeof row.inputId==='string'),'native Runtime input IDs are projected');
    const baselineIds=new Set(baseline.map(row=>String(row.inputId)));
    assert.equal(baselineIds.size,baseline.length,'original Runtime inputs are unique');
    const messageId='TEST-human-message-'+namespace;
    const sent=await host.rpc('team.execute',envelope(messageId,{
      operation:'message.send',payload:{
        to:'alice',text:prompt,summary:'TEST native human direct',messageId,actionMode:'do',
      },
    }));
    assert.equal(sent.ok,true,'canonical Team accepted the single human direct user input');
    assert.equal(scalar(sent.value).phase,'completed');
    const deliveryId=scalar(scalar(sent.value).effects).deliveryId;
    assert.ok(typeof deliveryId==='string'&&deliveryId.length>0,
      'original saved human delivery has an input identity');
    const deadline=Date.now()+55_000;
    let terminal=false;
    let latestGeneration: unknown;
    while(Date.now()<deadline){
      assert.deepEqual(errors,[]);
      const state=await host.rpc('runtime.read',envelope('TEST-read',{memberId:'alice-id'}));
      latestGeneration = scalar(state.value).generation;
      const rows=(scalar(state.value).inputs as unknown[]|undefined)?.map(scalar)??[];
      if(rows.some(x=>x.phase==='terminal'&&x.terminal==='succeeded'))terminal=true;
      if(terminal&&received.length>0)break;
      await tick();
    }
    assert.equal(terminal,true,'original Runtime persisted terminal success');
    const afterSend=await host.rpc('runtime.read',envelope('TEST-after-send',{memberId:'alice-id'}));
    assert.equal(afterSend.ok,true);
    const rows=(scalar(afterSend.value).inputs as unknown[]|undefined)?.map(scalar)??[];
    assert.ok(rows.every(row=>typeof row.inputId==='string'),'bounded durable Runtime input list');
    const newInputs=rows.filter(row=>!baselineIds.has(String(row.inputId)));
    assert.equal(newInputs.length,1,'one new durable input; auxiliary sampling never starts another source turn');
    assert.equal(newInputs[0]?.inputId,deliveryId,'completed original human input');
    assert.equal(newInputs[0]?.phase,'terminal');
    assert.equal(newInputs[0]?.terminal,'succeeded');
    assert.equal(received.length,1,'one provider candidate reaches original captured Host notification');
    const event=received[0]!;
    assert.equal(event.provider,'claude');
    assert.equal(event.teamId,scope.teamId);
    assert.equal(event.runId,scope.runId);
    assert.equal(event.memberId,'alice-id');
    assert.equal(event.memberName,'alice');
    assert.equal(event.messageId,messageId);
    assert.equal(event.inputId,deliveryId);
    assert.equal(event.completedTurnRef,event.operationRef);
    assert.ok(typeof event.text==='string'&&event.text.length>0);
    assert.ok(bodies.length>=2,'SDK generated an additional native suggestion inference');
    assert.deepEqual(errors,[]);
    assert.equal(typeof latestGeneration,'string');
    const originalOperationRef = event.operationRef;
    assert.ok(typeof originalOperationRef === 'string' && originalOperationRef.length > 0,
      'Host notice carries a bounded original operation');
    const proofPayload={memberId:'alice-id',expectedGeneration:latestGeneration,
      nativePromptProof:{inputId:deliveryId,operationRef:originalOperationRef}};
    const verified=await host.rpc('runtime.read',envelope('TEST-prove-original-operation',proofPayload));
    assert.equal(verified.ok,true,'same original Runtime read accepts optional proof without mutation');
    assert.equal(scalar(verified.value).nativePromptCurrent,true,
      'captured Host independently checks terminal original human DM and exact operation');
    assert.equal(JSON.stringify(verified.value).includes(originalOperationRef),false,
      'private operation token never leaves captured Host in Runtime read projection');
    const rejected=await host.rpc('runtime.read',envelope('TEST-reject-foreign-operation',{
      ...proofPayload,nativePromptProof:{inputId:deliveryId,operationRef:'TEST-foreign-operation'},
    }));
    assert.equal(rejected.ok,true);
    assert.equal(scalar(rejected.value).nativePromptCurrent,false,
      'wrong operation is rejected rather than self-matching browser candidate fields');
    const stopped=await host.rpc('runtime.stop',envelope('TEST-stop',{memberId:'alice-id',expectedGeneration:latestGeneration}));
    assert.equal(stopped.ok,true);
    receipt={passed:true,nativeSdk:'0.3.305',normalHumanMessages:1,originalHostNotifications:1,
      localhostModelCalls:bodies.length,allModelCallsContainOriginalHuman:bodies.every(x=>x.inputHasHuman),
      vendorAuth:false,environment:process.platform+'-'+process.arch,nativeCustody:'released'};
  }finally{
    try{await host?.close()}catch{}
    try{server?.closeAllConnections();await new Promise<void>(resolve=>server?.close(()=>resolve())??resolve())}catch{}
    await writeFile(join(root,'receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600});
    if (process.env.NATIVE_SUGGESTIONS_HOST_RECEIPT)
      await writeFile(process.env.NATIVE_SUGGESTIONS_HOST_RECEIPT,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
    t.diagnostic(JSON.stringify(receipt));
    await rm(root,{recursive:true,force:true});
  }
});
