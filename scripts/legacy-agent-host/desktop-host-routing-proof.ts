import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import { desktopTaskCommentInputExpression } from './desktop-task-comment-input-target.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import { desktopJsLiteral } from './desktop-ui-controls.ts';

/** Explicit API boundary probe, separate from ordinary control signoff. */
export async function runDesktopHostRoutingProof(
  cdp: UiCdpPort,
  fixture: { handleId: string; root: string },
  evidence: Record<string, unknown>
): Promise<void> {
  // Main/preload readiness precedes the cold renderer module graph. Wait for the
  // actual UI before awaiting its API module, without repeating any API probe.
  await cdp.send('Page.bringToFront');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const startedAt = Date.now(),
    deadline = startedAt + 120_000;
  let uiReady = false;
  while (Date.now() < deadline) {
    uiReady = (await cdp.evaluate('window.__claudeTeamsUiDidInit===true')) === true;
    if (uiReady) break;
    await new Promise<void>((done) => setTimeout(done, 100));
  }
  evidence.routingRendererReadiness = {
    uiReady,
    elapsedMs: Date.now() - startedAt,
    budgetMs: 120_000,
  };
  assert.equal(uiReady, true, 'actual renderer initialized before the one negative routing probe');
  const teamName = 'host-team:' + encodeURIComponent(fixture.handleId);
  const request = {
    teamName,
    cwd: join(fixture.root, 'workspace'),
    members: [{ name: 'alice' }],
  };
  // Electron Vite serves src/renderer as its root (index.html imports ./main.tsx).
  // The frozen preload namespace does not contain the renderer owner decorator.
  const probes = await cdp.evaluate(`(async () => {
    const {api} = await import('/api/index.ts');
    const request = ${desktopJsLiteral(request)};
    const probes = [
      ['launchTeam', request],
      ['createTeam', request],
      ['createConfig', request],
      ['updateMemberSettings', {teamName: request.teamName, memberName: 'alice',
        commandId: 'TEST-not-dispatched', idempotencyKey: 'TEST-not-dispatched',
        expectedFingerprint: 'TEST-not-dispatched', targetKind: 'member', settings: {}}],
      ['showMessageNotification', {teamName: request.teamName, teamDisplayName: 'TEST',
        from: 'alice', body: 'TEST route probe', nativeSessionId: 'TEST-forbidden-selector'}],
      ['showMessageNotification', {teamDisplayName: 'TEST', from: 'alice',
        body: 'TEST route probe', target: {kind: 'task', teamName: request.teamName, taskId: ''}}],
    ];
    const outcomes = [];
    for (const [method, argument] of probes) {
      try {
        await api.teams[method](argument);
        outcomes.push({method, outcome: 'unexpected-success'});
      } catch (error) {
        outcomes.push({method, outcome: error instanceof Error ? error.message : String(error)});
      }
    }
    return outcomes;
  })()`);
  assert.ok(Array.isArray(probes));
  assert.equal(probes.length, 6);
  evidence.hostRequestRouting = { status: 'INCOMPLETE', probes };
  for (const probe of probes)
    assert.equal(
      (probe as Record<string, unknown>).outcome,
      (probe as Record<string, unknown>).method === 'launchTeam'
        ? 'Host team operation launch-source-required (not-dispatched)'
        : (probe as Record<string, unknown>).method === 'showMessageNotification'
          ? 'Invalid captured Host notification'
          : 'This operation is not supported for Host teams',
      'exact renderer routing refusal, not an arbitrary legacy validation or transport failure'
    );
  evidence.hostRequestRouting = {
    status: 'PASS',
    scope:
      'Actual renderer unified API rejects unsupported Host destinations, source-less Launch and malformed notification selectors before mutation dispatch. This negative API probe does not qualify ordinary Launch/config/member/notification functionality.',
    probes,
  };
}

/** Timing faults only: the shared original adapter still performs every physical read once. */
export function desktopF08ReadFaultExpression(handleId: string, selection: string): string {
  return `(async () => {
    const {api}=await import('/api/index.ts'), backend=api.agentBackend;
    if(window.__TEST_f08)throw Error('F08 already installed');
    const original=backend.invoke, previousStackLimit=Error.stackTraceLimit;
    Error.stackTraceLimit=50;
    const state=()=>window.__agentTeamsDevStore.getState();
    const selected=()=>{const s=state();return {team:s.selectedTeamName,dataTeam:s.selectedTeamData?.teamName??null,
      loading:s.selectedTeamLoading,nonce:s.selectedTeamLoadNonce,contextId:s.activeContextId};};
    const f={records:[],ignored:[],events:[],observerReads:[],observerErrors:[],transitions:[],pendingObserverReads:0,
      holdArmed:false,lossArmed:false,gapArmed:false,recoveryPending:false,releases:[],original,backend,selected,
      selection:${desktopJsLiteral(selection)},handleId:${desktopJsLiteral(handleId)},priorNonce:null,watchTarget:null,violations:[]};
    window.__TEST_f08=f;
    const stopStore=window.__agentTeamsDevStore.subscribe(()=>{
      const s=selected();if(f.transitions.length<128)f.transitions.push(s);
      if(f.watchTarget&&(s.team!==f.watchTarget||s.dataTeam!==null&&s.dataTeam!==f.watchTarget))f.violations.push(s);
    });
    backend.invoke=async function(request){
      const stack=String(new Error('F08 original read provenance').stack), before=selected();
      const same=request?.handle?.handleId===f.handleId, shared=stack.includes('createHostTeamChanges')||/poll/.test(stack);
      let kind=null;
      if(same&&request.operation==='team.snapshot'&&f.holdArmed){
        const provenance=/getData/.test(stack)&&before.team===f.selection&&before.loading===true&&before.nonce>f.priorNonce;
        if(provenance){kind='selected-snapshot-hold';f.holdArmed=false;}
        else if(f.ignored.length<8)f.ignored.push({request:structuredClone(request),stack,selected:before});
      }
      if(same&&request.operation==='team.changes.read'&&shared){
        if(f.lossArmed){kind='shared-feed-response-loss';f.lossArmed=false;}
        else if(f.gapArmed){kind='shared-feed-cursor-loss';f.gapArmed=false;}
        else if(f.recoveryPending){kind='shared-feed-after-loss';f.recoveryPending=false;}
      }
      if(!kind&&same&&request.operation==='team.roster.read'&&/getData/.test(stack)&&!f.tailTracked&&
        f.records.some(record=>record.kind==='selected-snapshot-hold'&&record.status==='released')){
        kind='selected-getData-tail';f.tailTracked=true;
      }
      let sent=request;
      if(kind==='shared-feed-cursor-loss'){
        if(typeof request.payload?.cursor!=='string')throw Error('F08 expected the actual retained cursor');
        sent={...request,payload:{...request.payload}};delete sent.payload.cursor;
      }
      const record=kind?{kind,request:structuredClone(request),sent:structuredClone(sent),stack,selected:before,priorNonce:f.priorNonce,physicalCalls:0,status:'dispatched'}:null;
      if(record)f.records.push(record);
      if(record)record.physicalCalls++;
      const result=await Reflect.apply(original,backend,[sent]);
      if(!record)return result;
      record.result=result;record.resultJson=JSON.stringify(result);record.status='received';
      if(kind==='selected-snapshot-hold'||kind==='shared-feed-response-loss'){
        record.status='held';await new Promise(resolve=>{record.release=resolve;f.releases.push(resolve);});
        if(record.result!==result||record.resultJson!==JSON.stringify(result))throw Error('F08 original read result changed');
        if(kind==='shared-feed-response-loss'){
          f.recoveryPending=true;record.status='lost';throw Error('TEST F08 discards one original read response');
        }
        record.status='released';
      }
      return result;
    };
    f.restore=()=>{
      for(const release of f.releases)release();
      if(f.stopObserver)f.stopObserver();stopStore();backend.invoke=original;Error.stackTraceLimit=previousStackLimit;
      f.restored=backend.invoke===original;
    };
    return {installed:true,selected:selected()};
  })()`;
}

/** Appends to the existing offline workflow after its original receipt censuses. No provider or new Task. */
export async function runDesktopF08ReadTimingProof(
  cdp: UiCdpPort,
  options: {
    root: string;
    handleId: string;
    seed: { taskId: string; subject: string };
    evidence: Record<string, unknown>;
    assertOwnedRenderer(): void;
  }
): Promise<void> {
  const row = (value: unknown): Record<string, unknown> => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    return value as Record<string, unknown>;
  };
  const json = async (path: string) => row(JSON.parse(await readFile(path, 'utf8')));
  const selection = 'host-team:' + encodeURIComponent(options.handleId);
  const descriptor = await json(join(options.root, 'desktop-descriptor.json'));
  const profile = await json(join(options.root, 'host-profile.json'));
  assert.equal(profile.runtime, undefined, 'F08 stays on the existing offline Host');
  const definitions = (profile.teams as unknown[]).map(row);
  const targetDefinition = definitions.find(
    (entry) => row(entry.binding).teamName === 'test-cross-alpha'
  );
  assert.ok(targetDefinition, 'reuse the existing cross-Team peer');
  const targetScope = row(targetDefinition.scope);
  const target = (descriptor.handles as unknown[])
    .map(row)
    .find((entry) => row(entry.scope).teamId === targetScope.teamId);
  assert.ok(target);
  const targetSelection = 'host-team:' + encodeURIComponent(String(target.handleId));
  const targetTasksDirectory = join(options.root, 'hoststore/tasks/test-cross-alpha');
  const targetTaskFiles = (await readdir(targetTasksDirectory)).filter((name) =>
    /^[A-Za-z0-9_-]+\.json$/.test(name)
  );
  assert.equal(targetTaskFiles.length, 1);
  const targetTask = await json(join(targetTasksDirectory, targetTaskFiles[0]!));
  const taskPath = join(
    options.root,
    'hoststore/tasks/test-desktop-backend',
    options.seed.taskId + '.json'
  );
  const commandsDirectory = join(
    options.root,
    'hoststore/teams/test-desktop-backend/.host-owner/commands'
  );
  const commands = async () => {
    const names = (await readdir(commandsDirectory))
      .filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name))
      .sort();
    assert.ok(names.length <= 128);
    return Promise.all(names.map((name) => json(join(commandsDirectory, name))));
  };
  const originalTask = await json(taskPath),
    originalCommands = await commands();
  const originalIds = new Set(originalCommands.map((receipt) => receipt.commandId));
  const text = 'TEST F08 original Task comment and shared read recovery';
  const comments = (task: Record<string, unknown>) =>
    ((task.comments as unknown[] | undefined) ?? []).map(row);
  assert.equal(comments(originalTask).filter((comment) => comment.text === text).length, 0);
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE',
    scope:
      'Same actual Electron shared adapter: one original Task comment with real read response loss, actual Host cursor gap and late public observer resync; separate original selected-Team read held across original target navigation',
    excluded: [
      'first global snapshot-subscription race',
      'same-Team revision rollback across an in-flight mutation',
      'transport reconnect or Host restart',
      'live default-owner switch',
      'unavailable A physical fault',
      'cross-owner routing',
      'full F08/M18/Stage1',
    ],
    sourceHandleId: options.handleId,
    targetHandleId: target.handleId,
    taskId: options.seed.taskId,
    originalTask,
    originalCommandIds: [...originalIds],
    steps: [],
  };
  options.evidence.f08ReadTimingProof = proof;
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: (step) => (proof.steps as unknown[]).push(step),
  });
  const state = (key: string) =>
    `(() => {const s=window.__agentTeamsDevStore?.getState();return s?.selectedTeamName===${desktopJsLiteral(key)}&&s.selectedTeamData?.teamName===${desktopJsLiteral(key)}&&!s.selectedTeamLoading;})()`;
  const fault = (kind: string, status: string) =>
    `window.__TEST_f08.records.find(r=>r.kind===${desktopJsLiteral(kind)}&&r.status===${desktopJsLiteral(status)})`;
  let installed = false,
    completed = false;
  try {
    await ui.observeInput();
    await ui.clickSidebar(options.seed.subject);
    await ui.waitRead(state(selection), 'original source fully loaded before the one Task comment');
    proof.install = await cdp.evaluate(desktopF08ReadFaultExpression(options.handleId, selection));
    installed = true;
    proof.beforeMutationSnapshot = await cdp.evaluate(
      `(async()=>{const {api}=await import('/api/index.ts');return api.teams.getData(${desktopJsLiteral(selection)});})()`
    );
    await cdp.evaluate('window.__TEST_f08.lossArmed=true;true');
    await ui.waitRead(
      fault('shared-feed-response-loss', 'held'),
      'one original shared feed response held before loss'
    );

    // The sidebar opens the existing Task detail without its separate Open team action.
    const sidebarText = await ui.waitRead(
      `(() => {const rows=[...document.querySelectorAll('#sidebar-tasks-panel .sidebar-task-item')].filter(e=>[...e.querySelectorAll('span')].some(s=>s.textContent.trim()===${desktopJsLiteral(options.seed.subject)}));return rows.length===1?rows[0].textContent.trim():null;})()`,
      'original source Task sidebar row'
    );
    await ui.click(
      '#sidebar-tasks-panel .sidebar-task-item',
      'open original source Task detail only',
      String(sidebarText)
    );
    const input = row(
      await ui.waitRead(
        desktopTaskCommentInputExpression(options.handleId, options.seed.taskId),
        'actual original Task comment owner/surface'
      )
    );
    await ui.scrollTo(String(input.selector), 'original source Task comment');
    await ui.click(String(input.selector), 'focus original source Task comment');
    await cdp.send('Input.insertText', { text });
    await ui.click(
      '[role="dialog"] button.message-composer-send-button',
      'one original F08 Task Comment',
      'Comment'
    );
    const deadline = Date.now() + 20_000;
    let changedTask: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      options.assertOwnedRenderer();
      const current = await json(taskPath);
      const matches = comments(current).filter((comment) => comment.text === text);
      assert.ok(matches.length <= 1, 'no second original comment effect');
      if (matches.length === 1) {
        changedTask = current;
        break;
      }
      await new Promise<void>((done) => setTimeout(done, 100));
    }
    assert.ok(changedTask, 'original comment committed without retry');
    assert.equal(comments(changedTask).length, comments(originalTask).length + 1);
    proof.commentOwner = input;
    proof.changedTask = changedTask;
    await ui.click('[role="dialog"] button', 'close original source Task detail', 'Close');
    await ui.waitRead(state(selection), 'original source remains selected after its Task comment');
    await cdp.evaluate(`(async () => {
      const {api}=await import('/api/index.ts'),f=window.__TEST_f08;
      f.observerInstalledAfterMutation=true;
      f.stopObserver=api.teams.onTeamChange((_event,event)=>{
        if(event.teamName!==f.selection)return;
        if(f.events.length<32)f.events.push(structuredClone(event));
        f.pendingObserverReads++;
        api.teams.getData(f.selection).then(value=>{if(f.observerReads.length<8)f.observerReads.push(value);},error=>{
          if(f.observerErrors.length<8)f.observerErrors.push(String(error));
        }).finally(()=>{f.pendingObserverReads--;});
      });
      f.records.find(r=>r.kind==='shared-feed-response-loss').release();return true;
    })()`);
    await ui.waitRead(
      fault('shared-feed-response-loss', 'lost'),
      'one original read response discarded'
    );
    const recovery = row(
      await ui.waitRead(
        fault('shared-feed-after-loss', 'received'),
        'actual same-Host shared read resumes after response loss'
      )
    );
    assert.equal(row(recovery.result).ok, true);
    assert.equal(row(recovery.request).operation, 'team.changes.read');
    await ui.waitRead(
      `window.__TEST_f08.observerReads.some(value=>value.tasks.some(task=>task.id===${desktopJsLiteral(options.seed.taskId)}&&task.comments?.filter(c=>c.text===${desktopJsLiteral(text)}).length===1))`,
      'late public observer rehydrates the original comment'
    );
    await cdp.evaluate(
      `(() => {const f=window.__TEST_f08;f.gapEventStart=f.events.length;f.gapArmed=true;return true;})()`
    );
    const gap = row(
      await ui.waitRead(
        fault('shared-feed-cursor-loss', 'received'),
        'actual Host answers one omitted cursor with a gap'
      )
    );
    assert.equal(gap.physicalCalls, 1);
    assert.equal(row(gap.result).ok, true);
    assert.equal(row(row(row(gap.result).value).gap).reason, 'initial');
    assert.equal(Object.hasOwn(row(row(gap.sent).payload), 'cursor'), false);
    assert.equal(typeof row(row(gap.request).payload).cursor, 'string');
    await ui.waitRead(
      `window.__TEST_f08.events.slice(window.__TEST_f08.gapEventStart).some(event=>event.detail==='host-product-gap')`,
      'actual shared consumer delivers Host gap invalidation'
    );
    await ui.waitRead(
      `window.__TEST_f08.pendingObserverReads===0`,
      'original late observer reads settled'
    );
    // Stop the diagnostic late observer before starting the independent selected-load fault.
    await cdp.evaluate('window.__TEST_f08.stopObserver();window.__TEST_f08.stopObserver=null;true');
    await ui.waitRead(
      'window.__TEST_f08.pendingObserverReads===0',
      'late observer detached with its original reads settled'
    );
    await ui.clickSidebar(String(targetTask.subject));
    await ui.waitRead(state(targetSelection), 'original peer selected before source load');
    const sourceIdle = await ui.waitRead(
      `(async()=>{const {isTeamDataRefreshPending}=await import('/store/slices/teamSlice.ts');
      return !isTeamDataRefreshPending(${desktopJsLiteral(selection)},window.__agentTeamsDevStore.getState);})()`,
      'source has no earlier physical Team refresh before original selection'
    );
    proof.sourceIdleBeforeSelection = sourceIdle;

    await cdp.evaluate(
      `(() => {const f=window.__TEST_f08;f.priorNonce=f.selected().nonce;f.holdArmed=true;return true;})()`
    );
    await ui.clickSidebar(options.seed.subject);
    const held = row(
      await ui.waitRead(
        fault('selected-snapshot-hold', 'held'),
        'actual selected-Team getData snapshot held'
      )
    );
    assert.equal(held.physicalCalls, 1);
    assert.match(String(held.stack), /getData/);
    assert.equal(row(held.selected).team, selection);
    assert.equal(row(held.selected).loading, true);
    assert.ok(
      Number(row(held.selected).nonce) > Number(held.priorNonce),
      'actual selected load nonce advanced after original navigation'
    );
    const heldResult = row(held.result);
    assert.equal(heldResult.ok, true);
    assert.equal(row(heldResult.value).teamName, 'test-desktop-backend');
    const heldTask = (row(heldResult.value).tasks as unknown[])
      .map(row)
      .find((task) => task.id === options.seed.taskId);
    assert.ok(heldTask);
    assert.deepEqual(
      comments(heldTask),
      comments(changedTask),
      'the separate selected response includes the already committed comment'
    );
    proof.selectedReadProvenance = {
      request: held.request,
      stack: held.stack,
      selected: held.selected,
      priorNonce: held.priorNonce,
    };
    await ui.clickSidebar(String(targetTask.subject));
    await ui.waitRead(
      state(targetSelection),
      'original peer load completes while source read remains held'
    );
    await cdp.evaluate(`window.__TEST_f08.watchTarget=${desktopJsLiteral(targetSelection)};true`);
    const beforeRelease = await cdp.evaluate(
      `(() => {const s=window.__agentTeamsDevStore.getState();return {selected:s.selectedTeamName,data:s.selectedTeamData,cache:s.teamDataCacheByName[${desktopJsLiteral(targetSelection)}]};})()`
    );
    proof.targetBeforeRelease = beforeRelease;
    await cdp.evaluate(
      `(() => {window.__TEST_f08.records.find(r=>r.kind==='selected-snapshot-hold').release();return true;})()`
    );
    await ui.waitRead(
      fault('selected-snapshot-hold', 'released'),
      'original unchanged source response released after selecting the peer'
    );
    const tail = row(
      await ui.waitRead(
        fault('selected-getData-tail', 'received'),
        'original held getData reaches its terminal roster read'
      )
    );
    assert.equal(row(tail.result).ok, true);
    assert.match(String(tail.stack), /getData/);
    // Two visible frames let the original selected-load promise propagate through its actual store guard.
    await cdp.evaluate(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'
    );
    await ui.waitRead(
      state(targetSelection),
      'late original source response cannot select or replace peer'
    );
    const afterRelease = await cdp.evaluate(
      `(() => {const s=window.__agentTeamsDevStore.getState();return {selected:s.selectedTeamName,data:s.selectedTeamData,cache:s.teamDataCacheByName[${desktopJsLiteral(targetSelection)}]};})()`
    );
    assert.deepEqual(
      afterRelease,
      beforeRelease,
      'late source read leaves selected peer and its cache exact'
    );
    proof.targetAfterRelease = afterRelease;
    assert.deepEqual(
      await cdp.evaluate('window.__TEST_f08.violations'),
      [],
      'no intervening selected peer rollback'
    );
    await cdp.evaluate('window.__TEST_f08.watchTarget=null;true');
    await ui.clickSidebar(options.seed.subject);
    await ui.waitRead(state(selection), 'source remains readable through original Team controls');
    await ui.waitRead(
      `(() => {const s=window.__agentTeamsDevStore.getState();return s.selectedTeamData?.tasks.find(t=>t.id===${desktopJsLiteral(options.seed.taskId)})?.comments?.filter(c=>c.text===${desktopJsLiteral(text)}).length===1;})()`,
      'already committed source comment survives late former-target response'
    );
    const finalCommands = await commands();
    const added = finalCommands.filter((receipt) => !originalIds.has(receipt.commandId));
    assert.equal(
      added.length,
      1,
      'read faults and navigation add only the one original UI comment command'
    );
    assert.equal(row(added[0]!.command).operation, 'task.comment');
    assert.equal(row(row(added[0]!.command).payload).text, text);
    assert.equal(added[0]!.phase, 'completed');
    assert.equal(added[0]!.principalId, 'TEST-human');
    assert.deepEqual(comments(await json(taskPath)), comments(changedTask));
    assert.deepEqual(
      finalCommands.filter((receipt) => originalIds.has(receipt.commandId)),
      originalCommands,
      'existing receipts remain exact'
    );
    assert.deepEqual(
      await json(join(targetTasksDirectory, targetTaskFiles[0]!)),
      targetTask,
      'peer Task bytes are not mutated'
    );
    proof.commentReceipt = added[0];
    completed = true;
  } finally {
    if (installed) {
      const retained = row(
        await cdp.evaluate(`(() => {const f=window.__TEST_f08;f.restore();return {restored:f.restored,
        records:f.records.map(({release,...record})=>record),ignored:f.ignored,events:f.events,observerReads:f.observerReads,
        observerErrors:f.observerErrors,transitions:f.transitions,violations:f.violations,pendingObserverReads:f.pendingObserverReads};})()`)
      );
      proof.actualReadFaults = retained;
      assert.equal(retained.restored, true, 'shared original invoke restored in finally');
      for (const record of (retained.records as unknown[]).map(row)) {
        assert.equal(record.physicalCalls, 1);
        if (record.resultJson !== undefined) {
          assert.equal(
            JSON.stringify(record.result),
            record.resultJson,
            'original real read result retained unchanged'
          );
          record.resultSha256 = createHash('sha256')
            .update(String(record.resultJson))
            .digest('hex');
        }
      }
      if (completed) proof.status = 'PASS';
      await writeFile(
        join(options.root, 'f08-read-timing-proof.json'),
        JSON.stringify(proof, null, 2),
        { mode: 0o600, flag: 'wx' }
      );
    }
  }
}
