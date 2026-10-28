import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileDigest } from './desktop-backend-fixture.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { command, processTable } from './desktop-backend-observations.ts';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import { runDesktopRelaunchUiSmoke } from './desktop-relaunch-ui-smoke.ts';
import { runDesktopResumeUiSmoke } from './desktop-resume-ui-smoke.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';

const record = (raw: unknown): Record<string, unknown> => {
  assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
  return raw as Record<string, unknown>;
};
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as unknown;

/** All launch effects originate from the original dialog's CDP Input controls. */
export async function runDesktopLaunchUiSmoke(cdp: UiCdpPort, options: {
  fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
  seed: { taskId: string; subject: string; commandId: string };
  evidence: Record<string, unknown>;
  model: Awaited<ReturnType<typeof startNativeTeamModel>>;
  assertOwnedRenderer(): void;
  restartAfterStop?(): Promise<UiCdpPort>;
}): Promise<void> {
  const { fixture, evidence, model } = options;
  const steps: Record<string, unknown>[] = [];
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE', steps,
    scope: `Original LaunchTeamDialog controls, fresh saved capture, actual SDK/MCP task/message/native effect, Stop and original-dialog settings after ${evidence.mode === 'native-resume-ui' ? 'same-profile cold startup' : 'reload'}`,
    excluded: [evidence.mode === 'native-resume-ui' ? 'Create controls' : 'Create/Resume controls', 'real vendor authentication/inference', 'all advanced settings', 'full Stage1'],
  };
  evidence.launchDialogProof = proof;
  // Private React-layout-dependent TEST diagnosis only; never a workflow qualification.
  const captureReadiness = async (phase: 'before-original-submit' | 'original-submit-failed') => {
    const diagnostics = (proof.readinessDiagnostics ??= []) as unknown[];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      options.assertOwnedRenderer();
      const snapshot = await Promise.race([
        cdp.evaluate(`(() => {
          const teamName=${JSON.stringify('host-team:' + encodeURIComponent(fixture.handleId))};
          const prompt=document.querySelector('[role="dialog"] #dialog-prompt'),dialog=prompt?.closest('[role="dialog"]');
          if(!prompt||!dialog)return {unavailable:'original-launch-dialog-unavailable',now:Date.now()};
          const field=(value,key)=>value&&(typeof value==='object'||typeof value==='function')
            ?Object.getOwnPropertyDescriptor(value,key)?.value:undefined;
          const submit=[...dialog.querySelectorAll('button')].filter(button=>button.textContent.trim()==='Launch team');
          const result={now:Date.now(),teamName,form:{prompt:prompt.value,
            model:dialog.querySelector('button[aria-label*=" provider,"]')?.getAttribute('aria-label')??null,
            effort:dialog.querySelector('#lead-effort')?.textContent.trim()??null,
            submit:submit.map(button=>({disabled:button.disabled,text:button.textContent.trim()}))},checks:[],currentDraftSignatures:[]};
          const key=Object.keys(prompt).find(key=>key.startsWith('__reactFiber$'));
          const named=node=>{const type=field(node,'type');return typeof type==='function'&&field(type,'name')==='LaunchTeamDialog';};
          const matches=node=>{const props=field(node,'memoizedProps');
            return named(node)&&field(props,'open')===true&&field(props,'teamName')===teamName;};
          const storedName=value=>{const name=typeof value==='string'?value:field(value,'name');return typeof name==='string'?name.slice(0,100):null;};
          const ancestorTrace=[];
          let fiber=key?field(prompt,key):null,root=null,originalComponent=false;
          if(!fiber)return {...result,unavailable:'original-prompt-fiber-missing'};
          for(let depth=0;fiber&&depth<256;depth++,fiber=field(fiber,'return')){
            const props=field(fiber,'memoizedProps'),open=field(props,'open'),tag=field(fiber,'tag');
            ancestorTrace.push({depth,tag:typeof tag==='number'?tag:null,
              typeName:storedName(field(fiber,'type')),elementTypeName:storedName(field(fiber,'elementType')),
              open:typeof open==='boolean'?open:null,originalTeam:field(props,'teamName')===teamName});
            if(named(fiber))originalComponent=true;root=fiber;
          }
          const rootTag=field(root,'tag');
          Object.assign(result,{ancestorTrace,ancestorCount:ancestorTrace.length,
            ancestorLimitHit:Boolean(fiber),namedAncestorFound:originalComponent,rootTag:typeof rootTag==='number'?rootTag:null});
          if(fiber)return {...result,unavailable:'ancestor-traversal-limit'};
          if(!originalComponent)return {...result,unavailable:'launch-component-name-not-found'};
          if(rootTag!==3)return {...result,unavailable:'host-root-tag-mismatch'};
          const currentRoot=field(field(root,'stateNode'),'current');
          if(!currentRoot)return {...result,unavailable:'current-root-missing'};
          const pending=[currentRoot],components=[],seen=new Set();
          let visited=0;
          for(;pending.length&&visited<4096;visited++){
            const node=pending.pop();if(seen.has(node))continue;seen.add(node);
            if(matches(node))components.push(node);
            const sibling=field(node,'sibling'),child=field(node,'child');
            if(sibling)pending.push(sibling);if(child)pending.push(child);
          }
          if(pending.length)return {...result,currentTreeNodesVisited:visited,unavailable:'current-tree-traversal-limit'};
          if(components.length!==1)return {...result,currentTreeNodesVisited:visited,currentComponentMatches:components.length,
            unavailable:components.length===0?'current-launch-component-missing':'current-launch-component-ambiguous'};
          const component=components[0];result.currentTreeNodesVisited=visited;
          const projectChecks=(value,index,origin)=>{
            if(!Array.isArray(value)||!value.length||value.length>8||!value.every(check=>
              ['anthropic','codex','opencode','gemini'].includes(field(check,'providerId'))&&
              ['pending','checking','ready','notes','failed'].includes(field(check,'status'))&&Array.isArray(field(check,'details'))))return;
            result.checks.push({hookIndex:index,origin,checks:value.map(check=>{
              const proof=field(check,'capturedTeamReadiness');
              return {providerId:field(check,'providerId'),status:field(check,'status'),
                details:field(check,'details').slice(0,16).filter(value=>typeof value==='string').map(value=>value.slice(0,2000)),
                capturedTeamDraftSignature:typeof field(check,'capturedTeamDraftSignature')==='string'?field(check,'capturedTeamDraftSignature').slice(0,65536):null,
                capturedTeamReadiness:proof?Object.fromEntries(['handleId','preparationId','launchId','rosterRevision','selectionSignature','expiresAt'].map(key=>[key,field(proof,key)])):null};
            })});
          };
          let hook=field(component,'memoizedState'),count=0;
          for(;hook&&count<1024;hook=field(hook,'next'),count++){
            const value=field(hook,'memoizedState'),current=field(value,'current');
            projectChecks(value,count,'state');projectChecks(current,count,'ref');
            if(typeof current!=='string'||current.length>65536)continue;
            try{const scope=JSON.parse(current);
              if(Array.isArray(scope)&&scope.length===7&&scope[0]===true&&scope[1]===teamName&&
                typeof scope[2]==='string'&&typeof scope[3]==='string'&&typeof scope[5]==='string'&&Array.isArray(scope[6])&&scope[6].length===12)
                result.currentDraftSignatures.push({hookIndex:count,signature:current});
            }catch{}
          }
          return {...result,hookCount:count,...(hook?{unavailable:'hook-traversal-truncated'}:{})};
        })()`),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Readiness diagnostic timed out')), 3000);
        }),
      ]);
      diagnostics.push({ phase, snapshot });
    } catch {
      diagnostics.push({ phase, unavailable: 'readiness-diagnostic-read-failed' });
    } finally {
      clearTimeout(timer);
    }
  };
  const step = (value: Record<string, unknown>) => steps.push({ monotonicMs: Math.round(performance.now()), ...value });
  let ui = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer, step });
  const teamRoot = join(fixture.root, 'hoststore/teams/test-desktop-backend');
  const ownerState = async () => record(await json(join(teamRoot, '.host-owner/state.json')));
  const poll = async <T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, ms = 60000) => {
    const until = Date.now() + ms;
    let value = await read();
    while (!accept(value) && Date.now() < until) {
      assert.deepEqual(model.failures, [], 'native oracle must not hide tool failures');
      await new Promise<void>(resolve => setTimeout(resolve, 100));
      value = await read();
    }
    assert.ok(accept(value), label);
    return value;
  };
  const expandSettings = async () => {
    const controls = await ui.waitRead(`(() => {
      const rows=[...document.querySelectorAll('[role="dialog"] button[aria-controls]')]
        .filter(e=>e.textContent.includes('Optional launch settings'));
      return rows.length===1 ? {id:rows[0].getAttribute('aria-controls'), expanded:rows[0].getAttribute('aria-expanded')} : null;
    })()`, 'original Optional launch settings');
    const value = record(controls);
    if (value.expanded !== 'true')
      await ui.click(`[role="dialog"] button[aria-controls=${JSON.stringify(value.id)}]`, 'expand original launch settings');
    await ui.waitRead(`Boolean(document.querySelector('[role="dialog"] #dialog-prompt'))`, 'original prompt field');
  };
  await ui.observeInput();
  await ui.clickSidebar(options.seed.subject);
  await ui.click('button', 'open original Launch dialog', 'Launch');
  await ui.waitRead(`Boolean(document.querySelector('[role="dialog"]'))`, 'original Launch dialog');
  // The Host seed hydrates asynchronously; its initial default summary is not ready for input.
  const hydratedSummary = await ui.waitRead(`(() => {
    const rows=[...document.querySelectorAll('[role="dialog"] button[aria-controls]')]
      .filter(e=>e.textContent.includes('Optional launch settings'));
    if(rows.length!==1||rows[0].getAttribute('aria-expanded')!=='false')return null;
    const chips=[...rows[0].querySelectorAll('span')].map(e=>e.textContent.trim());
    return chips.includes('Sonnet 4.6')&&chips.includes('low')
      ? {id:rows[0].getAttribute('aria-controls'),model:'Sonnet 4.6',effort:'low'} : null;
  })()`, 'original saved launch summary hydrates before expansion');
  step({ observation: 'original saved launch summary before expansion', value: hydratedSummary });
  await expandSettings();
  await ui.waitRead(`(() => {
    const row=document.querySelector('[role="dialog"] button[aria-label*=" provider,"]');
    return row?.textContent.trim()==='Sonnet 4.6';
  })()`, 'original saved lead settings hydrate before editing');
  // Opening the real lead model row is a normal user action, not form setup.
  if (!(await cdp.evaluate(`Boolean(document.querySelector('[role="dialog"] [data-testid="team-model-selector-model-option"]'))`))) {
    await ui.scrollTo('[role="dialog"] button[aria-label*=" provider,"]', 'visible original lead row');
    await ui.click('[role="dialog"] button[aria-label*=" provider,"]', 'expand original lead model row');
  }
  await ui.scrollTo('[role="dialog"] [data-testid="team-model-selector-model-option"][aria-label^="Opus 4.6"]', 'visible Opus 4.6 option');
  await ui.click('[role="dialog"] [data-testid="team-model-selector-model-option"][aria-label^="Opus 4.6"]', 'select Opus 4.6 in original model selector');
  await ui.scrollTo('[role="dialog"] button', 'visible original Medium effort', 'Medium');
  await ui.click('[role="dialog"] button', 'choose original Medium effort', 'Medium');
  await ui.waitRead(`document.querySelector('[role="dialog"] #lead-effort')?.textContent.trim()==='Medium'`, 'selected medium effort');
  await ui.scrollTo('[role="dialog"] #dialog-prompt', 'visible original launch prompt');
  await ui.click('[role="dialog"] #dialog-prompt', 'focus original launch prompt');
  await cdp.send('Input.insertText', { text: 'NATIVE_TEAM_ONE' });
  await ui.waitRead(`document.querySelector('[role="dialog"] #dialog-prompt')?.value==='NATIVE_TEAM_ONE'`, 'typed original prompt');
  assert.equal(await cdp.evaluate(`document.querySelector('[role="dialog"] #dialog-skip-permissions')?.getAttribute('data-state')`), 'checked');
  // Do not click the optional preflight bypass: readiness must settle first.
  await ui.scrollTo('[role="dialog"] button', 'visible original Launch team control', 'Launch team');
  await captureReadiness('before-original-submit');
  try {
    await ui.click('[role="dialog"] button', 'submit original Launch team once', 'Launch team');
  } catch (error) {
    await captureReadiness('original-submit-failed');
    throw error;
  }
  await ui.waitRead(`!document.querySelector('[role="dialog"] #dialog-prompt')`, 'original launch dialog closes', 60000);
  const state = await poll(ownerState, value => Array.isArray(value.runtimeCaptures) && value.runtimeCaptures.length === 1, 'one fresh Team capture');
  const captures = state.runtimeCaptures as unknown[];
  const capture = record(captures[0]);
  const capturedMembers = capture.members as unknown[];
  assert.equal(capturedMembers.length, 1);
  const capturedMember = record(capturedMembers[0]);
  assert.equal(capturedMember.memberId, 'alice-id');
  assert.notEqual(capturedMember.principalId, 'alice-session');
  const saved = record(state.savedSettings);
  assert.equal(saved.prompt, 'NATIVE_TEAM_ONE');
  assert.equal(saved.cwd, join(fixture.root, 'workspace'));
  assert.equal(saved.model, 'claude-opus-4-6');
  assert.equal(saved.effort, 'medium');
  assert.equal(saved.fastMode, 'off');
  assert.equal(saved.skipPermissions, true);
  assert.equal(saved.limitContext, true);
  proof.savedSettings = saved;
  proof.capture = capture;
  const capturedSessions = async () => (await readDesktopNativeStopSessions(fixture.root))
    .filter(session => record(session.binding).runId === capture.launchId);
  const sessions = await poll(
    capturedSessions,
    rows => rows.length === 1 && Array.isArray(rows[0]!.inputs) &&
      (rows[0]!.inputs as unknown[]).length === 1 &&
      (rows[0]!.inputs as unknown[]).map(record).every(input => input.phase === 'terminal' && input.terminal === 'succeeded'),
    'one prompt reaches actual native terminal without duplicate input'
  );
  proof.nativeSessionBeforeStop = sessions[0];
  assert.equal(model.observations.length, 8);
  assert.ok(model.probes.length >= 1 && model.probes.length <= 8);
  assert.ok(model.observations.every(row => row.requestedModel === 'claude-opus-4-6' && row.requestedEffort === 'medium' && row.contextEffective));
  assert.ok(model.observations.some(row => row.toolResultError), 'actual Bash exit7 observed');
  assert.equal(await readFile(join(fixture.root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\n');
  const tasksDirectory = join(fixture.root, 'hoststore/tasks/test-desktop-backend');
  const tasks = await Promise.all((await readdir(tasksDirectory)).filter(name => /^[A-Za-z0-9_-]+\.json$/.test(name))
    .map(async name => record(await json(join(tasksDirectory, name)))));
  assert.equal(tasks.length, 2);
  const nativeTask = tasks.find(task => task.createdBy === 'alice');
  assert.ok(nativeTask);
  assert.equal(nativeTask.status, 'completed');
  assert.equal(nativeTask.owner, 'alice');
  proof.nativeTask = nativeTask;
  await ui.click('button[aria-label^="alice,"]', 'open original alice chat');
  await ui.waitRead(`document.body.innerText.includes('REPLY_NATIVE_ONE')`, 'native reply visible in original thread');
  const screenshot = record(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
  assert.ok(typeof screenshot.data === 'string');
  const screenshotPath = join(fixture.root, 'ui-original-launch-native.png');
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
  proof.screenshot = { path: screenshotPath, sha256: await fileDigest(screenshotPath) };
  const hostRows = processTable().filter(row => command(row.pid) === `${fixture.node} ${fixture.hostEntry}`);
  assert.equal(hostRows.length, 1, 'only this TEST Host executable may be selected');
  const hostPid = hostRows[0]!.pid;
  const children = processTable().filter(row => row.ppid === hostPid);
  assert.ok(children.length >= 1, 'actual native child present before Stop');
  await ui.scrollTo('button[aria-label="Stop"]', 'visible original Stop control');
  await ui.click('button[aria-label="Stop"]', 'original Stop once', 'Stop');
  await poll(capturedSessions, rows => rows.length === 1 && rows[0]!.phase === 'closed' && rows[0]!.custody === 'released', 'native cleanup released');
  await poll(async () => processTable(), rows => children.every(child => !rows.some(row => row.pid === child.pid)), 'captured native children physically absent');
  proof.stop = { nativeChildren: children, releasedBeforeQuit: true };
  if (options.restartAfterStop) {
    assert.equal(evidence.mode, 'native-resume-ui', 'cold boundary belongs only to explicit Resume proof');
    cdp = await options.restartAfterStop();
    ui = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer, step });
    await ui.waitRead(`Boolean(window.electronAPI)&&!document.getElementById('splash')`, 'cold same-profile real renderer');
  } else {
    const beforeReload = await cdp.evaluate('performance.timeOrigin');
    await cdp.send('Page.reload', { ignoreCache: false });
    await ui.waitRead(`performance.timeOrigin!==${JSON.stringify(beforeReload)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`, 'reloaded real renderer');
  }
  await ui.observeInput();
  if (!(await cdp.evaluate(`Boolean(document.querySelector('.kanban-task-card'))`)))
    await ui.clickSidebar(options.seed.subject);
  await ui.scrollTo('button', 'visible original Launch after reload', 'Launch');
  await ui.click('button', 'reopen original Launch after reload', 'Launch');
  await expandSettings();
  await ui.waitRead(`document.querySelector('[role="dialog"] #dialog-prompt')?.value==='NATIVE_TEAM_ONE'`, 'same saved prompt after reload');
  assert.equal(await cdp.evaluate(`document.querySelector('[role="dialog"] #dialog-skip-permissions')?.getAttribute('data-state')`), 'checked');
  assert.deepEqual(record((await ownerState()).savedSettings), saved, 'opening/reloading does not rewrite saved settings');
  assert.equal(model.observations.length, 8, 'opening the original dialog cannot dispatch another agent input');
  assert.deepEqual(model.failures, []);
  proof.status = 'PASS';
  proof.probes = model.probes;
  if (options.restartAfterStop) proof.settingsRetainedAfterColdStartup = true;
  else proof.settingsRetainedAfterReload = true;
  if (evidence.mode === 'native-resume-ui')
    await runDesktopResumeUiSmoke(cdp, { ...options, firstCapture: capture, savedSettings: saved, nativeTask: nativeTask!, firstSession: sessions[0]! });
  if (evidence.mode === 'native-relaunch-ui')
    await runDesktopRelaunchUiSmoke(cdp, { ...options, firstCapture: capture, savedSettings: saved, nativeTask: nativeTask!, firstSession: sessions[0]! });
}
