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
  timeout: 180_000,
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
  const nativePlatform = process.platform + '-' + process.arch;
  assert.ok(nativePlatform === 'linux-x64' || nativePlatform === 'darwin-arm64',
    'original native proof supports only Linux x64 and macOS ARM64');
  const binaryModule = nativePlatform === 'darwin-arm64'
    ? '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
    : '@anthropic-ai/claude-agent-sdk-linux-x64/claude';
  const binary = await realpath(createRequire(sdk).resolve(binaryModule));
  const binarySha256 = await fileHash(binary);
  if (nativePlatform === 'darwin-arm64') assert.equal(binarySha256,
    'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f',
    'same pinned native Claude SDK executable as the original Electron proof');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-followup-host-')));
  const relative = ['workspace','store','home','config','tmp','xdg-config','xdg-data','xdg-cache'];
  for (const p of relative) await mkdir(join(root,p),{recursive:true,mode:0o700});
  const warmupPrompt = 'TEST_NATIVE_WARMUP_' + randomUUID();
  const prompt = 'TEST_NATIVE_HUMAN_DIRECT_' + randomUUID();
  const received: Record<string, unknown>[] = [];
  const bodies: { inputHasHuman: boolean; kind: string; tools: number }[] = [];
  const errors: string[] = [];
  let host: ReturnType<typeof startHost> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let receipt: Record<string, unknown> = { passed: false, nativeSdk: sdkPackage.version,
    nativeBinarySha256: binarySha256, node: process.version, vendorAuth: false,
    environment: nativePlatform };
  let phase = 'local-model-setup';
  let warmupTerminal = false;
  let terminal = false;
  let warmupReadIssued = false;
  let warmupReadReturned = false;
  const warmupToolId = 'TEST-native-warmup-team-read';
  type ModelBlock = { type: 'text'; text: string } |
    { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
  const frames = (response: import('node:http').ServerResponse, id: number, block: ModelBlock) => {
    const event = (type: string, body: object) => response.write(
      'event: '+type+'\ndata: '+JSON.stringify({type,...body})+'\n\n'
    );
    response.writeHead(200,{'content-type':'text/event-stream'});
    event('message_start',{message:{id:'msg_TEST_'+id,type:'message',role:'assistant',
      model:'claude-sonnet-4-6',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:20,output_tokens:0}}});
    if (block.type === 'tool_use') {
      event('content_block_start',{index:0,content_block:{...block,input:{}}});
      event('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}});
    } else {
      event('content_block_start',{index:0,content_block:{type:'text',text:''}});
      event('content_block_delta',{index:0,delta:{type:'text_delta',text:block.text}});
    }
    event('content_block_stop',{index:0});
    event('message_delta',{delta:{stop_reason:block.type==='tool_use'?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:9}});
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
        const hasHuman=source.includes(prompt)||source.includes(warmupPrompt);
        assert.equal(hasHuman,true,'native inference belongs to exact original human message');
        const secondHuman = source.includes(prompt);
        const suggestion = source.includes('[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]');
        let kind: string;
        let block: ModelBlock;
        if (suggestion) {
          assert.equal(warmupReadReturned, true, 'native sampling follows the genuine read-only warm-up');
          kind = secondHuman ? 'human-suggestion' : 'warmup-suggestion';
          block = { type: 'text', text: 'Review the completed TEST request.' };
        } else if (!secondHuman && !warmupReadIssued) {
          const tools = (Array.isArray(data.tools) ? data.tools : []).map(scalar);
          assert.ok(tools.some(tool => tool.name === 'mcp__team__team_get'),
            'the actual native request exposes the original read-only Team tool');
          warmupReadIssued = true;
          kind = 'warmup-tool';
          block = { type: 'tool_use', id: warmupToolId, name: 'mcp__team__team_get', input: {} };
        } else {
          if (!secondHuman) {
            assert.equal(warmupReadReturned, false, 'one original read-only warm-up tool round trip');
            const messages = (Array.isArray(data.messages) ? data.messages : []).map(scalar);
            const blocks = messages.flatMap(message =>
              Array.isArray(message.content) ? message.content.map(scalar) : []);
            const result = blocks.find(value => value.type === 'tool_result' && value.tool_use_id === warmupToolId);
            assert.ok(result, 'the original native tool result reaches the next inference');
            assert.notEqual(result.is_error, true);
            const returned = JSON.stringify(result.content);
            assert.ok(returned.includes(teamBinding.teamName) && returned.includes(warmupPrompt),
              'the real Team read returns this captured TEST team and original human message');
            warmupReadReturned = true;
          }
          kind = secondHuman ? 'human-result' : 'warmup-result';
          block = { type: 'text', text: 'Completed TEST user request.' };
        }
        bodies.push({inputHasHuman:hasHuman,kind,tools:Array.isArray(data.tools)?data.tools.length:0});
        assert.ok(bodies.length<=7,'do not amplify model calls without user request');
        frames(res,bodies.length,block);
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
        executable:{path:binary,sha256:binarySha256},
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
    phase = 'host-handshake';
    const initial=await host.rpc('host.handshake',{protocolVersion:1});
    assert.ok((initial.capabilities as string[]).includes('runtime.member-session'));
    const launchRead=await host.rpc('team.launch.read',envelope('TEST-launch-read',{}));
    assert.equal(launchRead.ok,true);
    const selection=scalar(launchRead.value);
    phase = 'native-launch';
    const started=await host.rpc('team.launch.start',envelope('TEST-launch',{
      launchId:selection.launchId,rosterRevision:selection.rosterRevision,
      configuration:{members:[{memberId:'alice-id',model:'claude-sonnet-4-6',
        effort:'low',fastMode:false,permissions:'bypass',context:'model-default'}]},
    }));
    assert.equal(started.ok,true,'original Host launches same selected native SDK');
    phase = 'native-readiness';
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
    // The pinned SDK suppresses suggestions with fewer than two assistant messages.
    // One genuine read-only MCP round trip qualifies this original human DM;
    // its native suggestion must settle before a successor can make ownership ambiguous.
    const warmupMessageId='TEST-warmup-message-'+namespace;
    phase = 'warmup-human-dm';
    const warmup=await host.rpc('team.execute',envelope(warmupMessageId,{
      operation:'message.send',payload:{
        to:'alice',text:warmupPrompt,summary:'TEST native warm-up',messageId:warmupMessageId,actionMode:'do',
      },
    }));
    assert.equal(warmup.ok,true,'original Host accepts native warm-up human DM');
    assert.equal(scalar(warmup.value).phase,'completed');
    const warmupDeliveryId=scalar(scalar(warmup.value).effects).deliveryId;
    assert.ok(typeof warmupDeliveryId==='string'&&warmupDeliveryId.length>0);
    const warmupDeadline=Date.now()+55_000;
    while(Date.now()<warmupDeadline){
      assert.deepEqual(errors,[]);
      const state=await host.rpc('runtime.read',envelope('TEST-warmup-read',{memberId:'alice-id'}));
      const inputs=(scalar(state.value).inputs as unknown[]|undefined)?.map(scalar)??[];
      if(inputs.some(row=>row.inputId===warmupDeliveryId&&row.phase==='terminal'&&row.terminal==='succeeded')){
        warmupTerminal=true;
      }
      if(warmupTerminal&&received.some(row=>row.messageId===warmupMessageId))break;
      await tick();
    }
    assert.equal(warmupTerminal,true,'first original human DM has a durable native terminal');
    assert.equal(warmupReadReturned,true,'warm-up completed one genuine read-only native MCP round trip');
    assert.equal(received.filter(row=>row.messageId===warmupMessageId).length,1,
      'the original warm-up suggestion settles before the qualified second human DM');

    const messageId='TEST-human-message-'+namespace;
    phase = 'second-human-dm';
    const sent=await host.rpc('team.execute',envelope(messageId,{
      operation:'message.send',payload:{
        to:'alice',text:prompt,summary:'TEST native human direct',messageId,actionMode:'do',
      },
    }));
    assert.equal(sent.ok,true,'canonical Team accepted the qualified second human DM');
    assert.equal(scalar(sent.value).phase,'completed');
    const deliveryId=scalar(scalar(sent.value).effects).deliveryId;
    assert.ok(typeof deliveryId==='string'&&deliveryId.length>0,
      'original saved human delivery has an input identity');
    const deadline=Date.now()+55_000;
    let latestGeneration: unknown;
    while(Date.now()<deadline){
      assert.deepEqual(errors,[]);
      const state=await host.rpc('runtime.read',envelope('TEST-read',{memberId:'alice-id'}));
      latestGeneration = scalar(state.value).generation;
      const rows=(scalar(state.value).inputs as unknown[]|undefined)?.map(scalar)??[];
      if(rows.some(x=>x.inputId===deliveryId&&x.phase==='terminal'&&x.terminal==='succeeded'))terminal=true;
      if(terminal&&received.some(row=>row.messageId===messageId))break;
      await tick();
    }
    assert.equal(terminal,true,'original Runtime persisted terminal success');
    const afterSend=await host.rpc('runtime.read',envelope('TEST-after-send',{memberId:'alice-id'}));
    assert.equal(afterSend.ok,true);
    const rows=(scalar(afterSend.value).inputs as unknown[]|undefined)?.map(scalar)??[];
    assert.ok(rows.every(row=>typeof row.inputId==='string'),'bounded durable Runtime input list');
    const newInputs=rows.filter(row=>!baselineIds.has(String(row.inputId)));
    assert.equal(newInputs.length,2,'two authored human inputs; sampling never starts a source turn');
    assert.equal(newInputs.filter(row=>row.phase==='terminal'&&row.terminal==='succeeded').length,2);
    assert.ok(newInputs.some(row=>row.inputId===warmupDeliveryId),'warm-up remains a separate original input');
    const completed=newInputs.find(row=>row.inputId===deliveryId);
    assert.equal(completed?.phase,'terminal');
    assert.equal(completed?.terminal,'succeeded');
    assert.ok(received.every(row=>[warmupMessageId,messageId].includes(String(row.messageId))),
      'no foreign message may produce a Host suggestion');
    const offers=received.filter(row=>row.messageId===messageId);
    phase = 'native-suggestion-proof';
    assert.equal(offers.length,1,'exactly one native suggestion for the qualified second human DM');
    assert.ok(received.filter(row=>row.messageId===warmupMessageId).length<=1,
      'the settled warm-up suggestion must not amplify');
    const event=offers[0]!;
    assert.equal(event.provider,'claude');
    assert.equal(event.teamId,scope.teamId);
    assert.equal(event.runId,scope.runId);
    assert.equal(event.memberId,'alice-id');
    assert.equal(event.memberName,'alice');
    assert.equal(event.messageId,messageId);
    assert.equal(event.inputId,deliveryId);
    assert.equal(event.completedTurnRef,event.operationRef);
    assert.ok(typeof event.text==='string'&&event.text.length>0);
    assert.ok(bodies.length>=3,'two original turns plus one native suggestion inference');
    assert.deepEqual(errors,[]);
    assert.equal(typeof latestGeneration,'string');
    const originalOperationRef = event.operationRef;
    assert.ok(typeof originalOperationRef === 'string' && originalOperationRef.length > 0,
      'Host notice carries a bounded original operation');
    phase = 'host-operation-proof';
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
    phase = 'native-stop';
    const stopped=await host.rpc('runtime.stop',envelope('TEST-stop',{memberId:'alice-id',expectedGeneration:latestGeneration}));
    assert.equal(stopped.ok,true);
    receipt={...receipt,passed:true,nativeSdk:'0.3.305',nativeBinarySha256:binarySha256,normalHumanMessages:2,originalHostNotifications:received.length,qualifiedHostNotifications:offers.length,
      localhostModelCalls:bodies.length,allModelCallsContainOriginalHuman:bodies.every(x=>x.inputHasHuman),
      vendorAuth:false,environment:process.platform+'-'+process.arch,nativeCustody:'released'};
    phase = 'completed';
  }finally{
    let closeError: unknown;
    try{await host?.close()}catch(error){closeError=error}
    // Never upload a PASS receipt if the original Host's native cleanup failed.
    if(closeError && receipt.passed===true)
      receipt={...receipt,passed:false,nativeCustody:'unverified',
        cleanupError:closeError instanceof Error?closeError.message:'Host cleanup failed'};
    const facts = host?.facts();
    receipt = { ...receipt, phase, warmupTerminal, originalHumanTerminal: terminal,
      localhostModelCalls: bodies.length, modelCallKinds: bodies.slice(0, 8).map(body => body.kind),
      originalHostNotifications: received.length, localModelErrors: errors.length,
      warmupReadIssued, warmupReadReturned,
      hostExitCode: facts?.exitCode ?? null, hostSignalCode: facts?.signalCode ?? null,
      hostStdoutValid: facts?.stdoutValid ?? null, hostDiagnosticBytes: facts?.diagnosticBytes ?? 0,
      cleanupCompleted: host !== undefined && closeError === undefined };
    try{server?.closeAllConnections();await new Promise<void>(resolve=>server?.close(()=>resolve())??resolve())}catch{
      /* Local server cleanup must not replace the original native failure. */
    }
    await writeFile(join(root,'receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600});
    if (process.env.NATIVE_SUGGESTIONS_HOST_RECEIPT)
      await writeFile(process.env.NATIVE_SUGGESTIONS_HOST_RECEIPT,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
    t.diagnostic(JSON.stringify(receipt));
    await rm(root,{recursive:true,force:true});
    if(closeError)throw closeError;
  }
});
