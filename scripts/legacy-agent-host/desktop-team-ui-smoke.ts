import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileDigest } from './desktop-backend-fixture.ts';
import { bounded } from './desktop-proof-bounds.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';

import { createDesktopUiControls } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
export type { UiCdpPort } from './desktop-ui-controls.ts';
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};

/** DOM reads select real controls; only CDP Input events perform UI actions. */
export async function runDesktopTeamUiSmoke(
  cdp: UiCdpPort,
  options: {
    root: string;
    repo: string;
    seed: { taskId: string; subject: string; commandId: string };
    assertOwnedRenderer: () => void;
    evidence: Record<string, unknown>;
    nativeStop?: { assertNativeAbsent(): void };
  }
): Promise<void> {
  const steps: unknown[] = [];
  const step = (value: Record<string, unknown>): void => {
    steps.push({ monotonicMs: Math.round(performance.now()), ...value });
  };
  const { observeInput, waitRead, click, clickSidebar } = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step,
  });
  await observeInput();
  options.evidence.userControlProof = {
    status: 'INCOMPLETE',
    steps,
    scope:
      'Ordinary sidebar, Open team, Task dialog and Create controls; canonical offline Host Task persistence across renderer reload; TEST renderer focus emulated for macOS occlusion',
    excluded: [
      'runtime readiness',
      'native Team launch',
      'provider sessions',
      'full P5',
      'fork-free qualification',
    ],
  };
  const cardRead = (id: string, subject: string): string => `(() => {
    const e=document.querySelector('.kanban-task-card[data-task-id='+CSS.escape(${JSON.stringify(id)})+']');
    if(!e||!e.textContent.includes(${JSON.stringify(subject)}))return false;
    const r=e.getBoundingClientRect(); return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;
  })()`;
  const tasksPath = join(options.root, 'hoststore/tasks/test-desktop-backend');
  const taskFiles = async (): Promise<Record<string, unknown>[]> => {
    const names = (await readdir(tasksPath)).filter(
      (name) => /^[A-Za-z0-9_-]+\.json$/.test(name) && !name.startsWith('.')
    );
    return Promise.all(
      names
        .sort()
        .map(async (name) =>
          record(JSON.parse(await readFile(join(tasksPath, name), 'utf8')) as unknown)
        )
    );
  };
  const before = await taskFiles();
  assert.equal(before.length, 1);
  assert.equal(before[0]!.id, options.seed.taskId);
  await clickSidebar(options.seed.subject);
  await waitRead(
    cardRead(options.seed.taskId, options.seed.subject),
    'seed rendered in ordinary board'
  );
  step({ assertion: 'canonical seed card visible', taskId: options.seed.taskId });
  await click('button', 'open Create Task dialog', 'Task');
  await waitRead(
    `Boolean([...document.querySelectorAll('[role="dialog"]')].some(e=>e.textContent.includes('Create Task')))`,
    'Create Task dialog'
  );
  await click('[role="dialog"] #task-subject', 'focus Subject input');
  const subject = 'TEST created by ordinary Desktop Task controls';
  await cdp.send('Input.insertText', { text: subject });
  await waitRead(
    `document.querySelector('[role="dialog"] #task-subject')?.value===${JSON.stringify(subject)}`,
    'Subject input contains typed text'
  );
  step({ action: 'Input.insertText', subject });
  await click('[role="dialog"] button', 'Create Task once', 'Create');
  await waitRead(
    `!document.querySelector('[role="dialog"] #task-subject')`,
    'Create dialog closed'
  );
  const after = await taskFiles();
  assert.equal(after.length, 2, 'exactly one Task created by UI');
  const created = after.filter((task) => task.subject === subject);
  assert.equal(created.length, 1);
  const task = created[0]!;
  assert.equal(typeof task.id, 'string');
  assert.notEqual(task.id, options.seed.taskId);
  assert.equal(task.status, 'pending');
  await waitRead(cardRead(String(task.id), subject), 'new canonical Task card');
  step({
    assertion: 'created Task canonical and rendered',
    taskId: task.id,
    subject,
    status: task.status,
  });
  const commandsDirectory = join(
    options.root,
    'hoststore/teams/test-desktop-backend/.host-owner/commands'
  );
  const commands = await Promise.all(
    (await readdir(commandsDirectory))
      .filter((name) => name.endsWith('.json'))
      .map(async (name) =>
        record(JSON.parse(await readFile(join(commandsDirectory, name), 'utf8')) as unknown)
      )
  );
  const createReceipts = commands.filter((receipt) => {
    const command = record(receipt.command);
    return command.operation === 'task.create' && record(command.payload).subject === subject;
  });
  assert.equal(createReceipts.length, 1, 'one durable business command from the actual dialog');
  assert.equal(createReceipts[0]!.phase, 'completed');
  assert.equal(createReceipts[0]!.principalId, 'TEST-human');
  assert.equal(record(createReceipts[0]!.effects).taskId, task.id);
  options.evidence.uiBusinessReceipt = createReceipts[0];
  await writeFile(
    join(options.root, 'ui-task-snapshots.json'),
    JSON.stringify({ before, after }, null, 2),
    { mode: 0o600 }
  );
  const screenshot = record(
    await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  );
  assert.equal(typeof screenshot.data, 'string');
  const screenshotPath = join(options.root, 'ui-task-created.png');
  await writeFile(screenshotPath, Buffer.from(String(screenshot.data), 'base64'), { mode: 0o600 });
  options.evidence.uiScreenshot = {
    path: screenshotPath,
    sha256: await fileDigest(screenshotPath),
  };
  // Real renderer reload, followed solely by read-only assertions/navigation.
  const beforeReloadTimeOrigin = await cdp.evaluate('performance.timeOrigin');
  step({ action: 'Page.reload', ignoreCache: false });
  await cdp.send('Page.reload', { ignoreCache: false });
  await waitRead(
    `performance.timeOrigin!==${JSON.stringify(beforeReloadTimeOrigin)}&&document.readyState === "complete" && Boolean(window.electronAPI)&&!document.getElementById('splash')`,
    'new renderer document is ready after reload'
  );
  await observeInput();
  if (!(await cdp.evaluate(cardRead(String(task.id), subject)))) await clickSidebar(subject);
  await waitRead(cardRead(String(task.id), subject), 'same canonical Task after renderer reload');
  const reloaded = await taskFiles();
  assert.deepEqual(reloaded, after, 'renderer reload did not duplicate or mutate canonical Tasks');
  step({
    assertion: 'same Task ID and product fields after reload',
    taskId: task.id,
    taskCount: reloaded.length,
  });
  if (options.nativeStop) {
    options.evidence.nativeStopProof = {
      status: 'INCOMPLETE',
      scope:
        'Ordinary Stop control after explicit sandbox setup launch; actual Claude SDK/CLI and Host custody',
    };
    await click('button[aria-label="Stop"]', 'ordinary Stop team control', 'Stop');
    await waitRead(
      `![...document.querySelectorAll('button')].some(e=>e.getAttribute('aria-label')==='Stop'||e.getAttribute('aria-label')?.startsWith('Stopping'))`,
      'ordinary Stop control settles'
    );
    const sessions = await readDesktopNativeStopSessions(options.root);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.phase, 'closed');
    assert.equal(sessions[0]!.custody, 'released');
    options.nativeStop.assertNativeAbsent();
    step({
      assertion: 'ordinary Stop physically retires exact native child with closed/released custody',
    });
    options.evidence.nativeStopProof = {
      status: 'PASS',
      memberId: 'alice-id',
      generation: '1',
      phase: 'closed',
      custody: 'released',
      nativeChildAbsent: true,
      scope:
        'Ordinary Stop control after explicit sandbox setup launch; no ordinary launch/inference qualification',
    };
  }
  // Capture current bytes only; this does not establish reproducible bundle provenance.
  const sourcePaths = [
    'src/features/agent-backend/renderer/createHostTeamsApi.ts',
    'src/features/agent-backend/renderer/createHostTeamMutations.ts',
    'src/renderer/api/index.ts',
    'src/renderer/components/team/dialogs/CreateTaskDialog.tsx',
    'src/renderer/components/sidebar/SidebarTaskItem.tsx',
  ];
  const hashes = await Promise.all(
    sourcePaths.map(async (path) => ({ path, sha256: await fileDigest(join(options.repo, path)) }))
  );
  options.evidence.userControlProof = {
    ...record(options.evidence.userControlProof),
    status: 'PASS',
    seed: options.seed,
    createdTask: { id: task.id, subject, status: task.status },
    sourceHashesCollectedAfterFlow: hashes,
    readOnlyDomAfterReload: await cdp.evaluate(
      `({dialogs:[...document.querySelectorAll('[role="dialog"]')].map(e=>e.textContent.slice(0,1000)),alerts:[...document.querySelectorAll('[role="alert"]')].map(e=>e.textContent.slice(0,1000))})`
    ),
    derivedRuntimeWidgets: options.nativeStop
      ? 'Current native presence and ordinary scoped Stop verified; other runtime widgets remain outside this proof'
      : 'No native Runtime configured; widget errors recorded separately from Task persistence/control assertions',
  };
}

/** Document identity uses parsed href because Electron file location.origin is implementation-defined. */
function rendererDocumentMatches(value: unknown, rendererUrl: string): boolean {
  try {
    const actual = new URL(String(value)), expected = new URL(rendererUrl);
    return actual.origin === expected.origin && actual.protocol === expected.protocol &&
      actual.host === expected.host && actual.pathname === expected.pathname &&
      (expected.protocol !== 'file:' || actual.search === expected.search);
  } catch { return false; }
}

/** Captures only finite module/load diagnostics, never request headers or bodies. */
export async function attachRendererDiagnostics(
  cdp: UiCdpPort & {
    on(method: string, listener: (value: unknown) => void): void;
  },
  rendererUrl: string,
  evidence: Record<string, unknown>,
  startup: { remainingMs: number; assertOwnedRenderer(): void }
): Promise<void> {
  assert.ok(startup.remainingMs > 0, 'original startup budget remains');
  const deadline = performance.now() + startup.remainingMs;
  const origin = new URL(rendererUrl).origin;
  const events: unknown[] = [];
  const startupEvidence: Record<string, unknown> = { status: 'WAITING', commands: [], contextEvents: [] };
  evidence.rendererDiagnostics = { scope: 'bounded read-only module/load evidence', events, startup: startupEvidence };
  const commands = startupEvidence.commands as Record<string, unknown>[];
  const contextEvents = startupEvidence.contextEvents as Record<string, unknown>[];
  const contexts = new Map<number, unknown>();
  let mainFrameId: unknown, revision = 0;
  const noteContext = (event: Record<string, unknown>): void => {
    if (contextEvents.length < 96) contextEvents.push({ monotonicMs: Math.round(performance.now()), ...event });
  };
  const sameDocument = (value: unknown): boolean => rendererDocumentMatches(value, rendererUrl);
  const send = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    startup.assertOwnedRenderer();
    const command = { method, sentMs: Math.round(performance.now()) } as Record<string, unknown>;
    if (commands.length < 96) commands.push(command);
    try {
      const remaining = deadline - performance.now(); assert.ok(remaining > 0, 'original startup budget remains');
      const result = await bounded(cdp.send(method, params), remaining, 'renderer startup ' + method);
      command.ackMs = Math.round(performance.now()); return result;
    } catch (error) { command.failed = /timed out/i.test(String(error)) ? 'timeout' : 'refused'; throw error; }
  };
  const path = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      return url.origin === origin ? url.pathname.slice(0, 1000) : null;
    } catch {
      return null;
    }
  };
  const add = (event: Record<string, unknown>): void => {
    if (events.length < 96) events.push({ monotonicMs: Math.round(performance.now()), ...event });
  };
  const moduleError = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const line = value.split('\n')[0] ?? '';
    // Persist module/syntax evidence only, not arbitrary console payloads.
    if (!/SyntaxError|ReferenceError|TypeError|module|import|export/i.test(line)) return null;
    return line
      .replace(/https?:\/\/[^\s'"<>]+/g, (url) => path(url) ?? '[external URL]')
      .slice(0, 600);
  };
  cdp.on('Runtime.exceptionThrown', (value) => {
    const details = record(record(value).exceptionDetails);
    const exception = details.exception ? record(details.exception) : {};
    add({
      event: 'Runtime.exceptionThrown',
      path: path(details.url),
      line: details.lineNumber,
      column: details.columnNumber,
      className: exception.className,
      moduleError: moduleError(exception.description),
    });
  });
  cdp.on('Log.entryAdded', (value) => {
    const entry = record(record(value).entry);
    if (entry.level === 'error' || entry.level === 'warning')
      add({
        event: 'Log.entryAdded',
        level: entry.level,
        source: entry.source,
        path: path(entry.url),
        moduleError: moduleError(entry.text),
      });
  });
  cdp.on('Network.loadingFailed', (value) => {
    const entry = record(value);
    add({
      event: 'Network.loadingFailed',
      type: entry.type,
      canceled: entry.canceled,
      blockedReason: entry.blockedReason,
      errorText:
        typeof entry.errorText === 'string' && /^net::ERR_[A-Z_]+$/.test(entry.errorText)
          ? entry.errorText
          : 'unclassified',
    });
  });
  cdp.on('Page.frameNavigated', (value) => {
    const frame = record(record(value).frame);
    if (!frame.parentId) { mainFrameId = sameDocument(frame.url) ? frame.id : undefined; revision++; }
    add({ event: 'Page.frameNavigated', mainFrame: !frame.parentId, path: path(frame.url) });
    noteContext({ event: 'frameNavigated', mainFrame: !frame.parentId, frameId: frame.id, loaderId: frame.loaderId });
  });
  cdp.on('Runtime.executionContextCreated', value => {
    const context = record(record(value).context), aux = context.auxData ? record(context.auxData) : {};
    if (aux.isDefault === true && typeof context.id === 'number' && contexts.size < 64) contexts.set(context.id, aux.frameId);
    noteContext({ event: 'contextCreated', id: context.id, frameId: aux.frameId, default: aux.isDefault === true });
  });
  cdp.on('Runtime.executionContextsCleared', () => { contexts.clear(); revision++; noteContext({ event: 'contextsCleared' }); });
  for (const event of ['Page.domContentEventFired', 'Page.loadEventFired'])
    cdp.on(event, () => noteContext({ event }));
  cdp.on('Runtime.executionContextDestroyed', value => {
    const id = record(value).executionContextId;
    if (typeof id === 'number') contexts.delete(id);
    revision++; noteContext({ event: 'contextDestroyed', id });
  });
  // Cold protocol subscriptions measured ~25s; every command still keeps CdpClient's original30s bound.
  await Promise.all([send('Page.enable'), send('Runtime.enable')]);
  const frame = record(record(record(await send('Page.getFrameTree')).frameTree).frame);
  mainFrameId = sameDocument(frame.url) ? frame.id : undefined;
  while (performance.now() < deadline) {
    startup.assertOwnedRenderer();
    const contextId = [...contexts].find(([, frameId]) => mainFrameId !== undefined && frameId === mainFrameId)?.[0];
    if (contextId !== undefined) {
      const observedRevision = revision;
      try {
        const response = record(await send('Runtime.evaluate', { contextId, awaitPromise: false, returnByValue: true,
          expression: '({url:location.href,readyState:document.readyState})' }));
        const value = response.exceptionDetails ? {} : record(record(response.result).value);
        if (revision === observedRevision && contexts.get(contextId) === mainFrameId && sameDocument(value.url) &&
            ['interactive', 'complete'].includes(String(value.readyState))) {
          startupEvidence.status = 'DOCUMENT_READY'; startupEvidence.contextId = contextId;
          startupEvidence.frameId = mainFrameId; startupEvidence.readyState = value.readyState; break;
        }
      } catch (error) {
        if (!/execution context was destroyed|cannot find (?:default )?execution context|cannot find context with specified id/i.test(String(error))) throw error;
      }
    }
    await new Promise<void>(done => setTimeout(done, 100));
  }
  assert.equal(startupEvidence.status, 'DOCUMENT_READY', 'current main default context/document within original startup budget');
  for (const domain of ['Log', 'Network']) await send(`${domain}.enable`);
  // Document readiness precedes Main's mandatory Host backup/reconciliation fence.
  // Keep early diagnostics active while waiting; discovery must not spend its 30s CDP bound on that fence.
  const appReadiness: Record<string, unknown> = { status: 'WAITING', observations: [] };
  startupEvidence.appReadiness = appReadiness;
  const observations = appReadiness.observations as unknown[];
  while (performance.now() < deadline) {
    startup.assertOwnedRenderer();
    const remaining = deadline - performance.now();
    assert.ok(remaining > 0, 'original startup budget remains before Main/UI readiness');
    let value: Record<string, unknown>;
    try {
      value = record(await bounded(cdp.evaluate(`(async () => {
        const status = window.electronAPI?.startup?.getStatus ? await window.electronAPI.startup.getStatus() : null;
        return {originMatches:(${rendererDocumentMatches.toString()})(location.href,${JSON.stringify(rendererUrl)}),mainReady:status?.ready===true,
          errorPresent:Boolean(status?.error),phase:typeof status?.phase==='string'?status.phase.slice(0,80):'bridge-pending',
          uiDidInit:window.__claudeTeamsUiDidInit===true,storePresent:Boolean(window.__agentTeamsDevStore),
          rootChildCount:document.getElementById('root')?.childElementCount??0};
      })()`), remaining, 'Main/UI startup readiness'));
    } catch (error) {
      if (!/execution context was destroyed|cannot find (?:default )?execution context|cannot find context with specified id/i.test(String(error))) throw error;
      await new Promise<void>(done => setTimeout(done, Math.min(100, Math.max(0, deadline - performance.now()))));
      continue;
    }
    startup.assertOwnedRenderer();
    if (observations.length < 24) observations.push({ monotonicMs: Math.round(performance.now()), ...value });
    assert.notEqual(value.errorPresent, true, 'Main startup refused before UI readiness');
    assert.ok(performance.now() < deadline, 'original startup budget remains after Main/UI observation');
    if (value.originMatches === true && value.mainReady === true && value.uiDidInit === true &&
        typeof value.rootChildCount === 'number' && value.rootChildCount > 0) {
      appReadiness.status = 'READY'; appReadiness.observation = value; return;
    }
    await new Promise<void>(done => setTimeout(done, Math.min(100, Math.max(0, deadline - performance.now()))));
  }
  assert.fail('original startup budget expired before Main/UI readiness');
}

export async function readRendererFailureSnapshot(cdp: UiCdpPort): Promise<unknown> {
  return cdp.evaluate(`(async () => {
    const safePath = value => { try { const u=new URL(value,location.href); return u.origin===location.origin?u.pathname.slice(0,1000):null; } catch { return null; } };
    let startup={state:'unavailable'};
    if(window.electronAPI?.startup?.getStatus){
      startup=await Promise.race([
        window.electronAPI.startup.getStatus().then(s=>({state:'returned',ready:s.ready,phase:s.phase,errorPresent:Boolean(s.error),steps:(s.steps??[]).slice(-16).map(x=>({phase:x.phase,startedAt:x.startedAt,finishedAt:x.finishedAt}))})).catch(()=>({state:'rejected'})),
        new Promise(resolve=>setTimeout(()=>resolve({state:'timed-out'}),1500))
      ]);
    }
    return {readyState:document.readyState,uiDidInit:window.__claudeTeamsUiDidInit===true,
      documentFocused:document.hasFocus(),visibility:document.visibilityState,inputEvents:window.__TEST_desktopInputEvents??[],
      mixedProgress:Array.isArray(window.__TEST_mixedProgress)?window.__TEST_mixedProgress.slice(-80).map(row=>({monotonicMs:row.monotonicMs,text:String(row.text??'').slice(0,6000)})):[],
      store:(()=>{const s=window.__agentTeamsDevStore?.getState();return s?{
        teamsLoading:s.teamsLoading,teamsError:s.teamsError?.slice(0,300),
        globalTasksLoading:s.globalTasksLoading,globalTasksInitialized:s.globalTasksInitialized,
        globalTasksError:s.globalTasksError?.slice(0,300),globalTaskCount:s.globalTasks.length,
        selectedTeamName:s.selectedTeamName,selectedTeamError:s.selectedTeamError?.slice(0,300),
        provisioning:[...new Set([s.selectedTeamName,...s.paneLayout.panes.flatMap(p=>p.tabs.filter(t=>t.type==='team').map(t=>t.teamName))].filter(team=>typeof team==='string'))].slice(0,8).map(team=>{
          const runId=s.currentProvisioningRunIdByTeam?.[team],progress=runId?s.provisioningRuns?.[runId]:null;
          return {teamName:team,currentProvisioningRunId:runId??null,currentRuntimeRunId:s.currentRuntimeRunIdByTeam?.[team]??null,
            startedAtFloor:s.provisioningStartedAtFloorByTeam?.[team]??null,error:s.provisioningErrorByTeam?.[team]?.slice(0,500)??null,
            ignoredProvisioning:runId?s.ignoredProvisioningRunIds?.[runId]===team:false,ignoredRuntime:runId?s.ignoredRuntimeRunIds?.[runId]===team:false,
            progress:progress?{runId:progress.runId,teamName:progress.teamName,state:progress.state,message:progress.message?.slice(0,1000),
              messageSeverity:progress.messageSeverity,error:progress.error?.slice(0,500),startedAt:progress.startedAt,updatedAt:progress.updatedAt,configReady:progress.configReady,
              launchDiagnostics:(progress.launchDiagnostics??[]).slice(0,32).map(row=>({id:row.id?.slice(0,256),memberName:row.memberName?.slice(0,128),code:row.code,label:row.label?.slice(0,500),severity:row.severity,observedAt:row.observedAt}))}:null};
        }),
        globalTaskDetail:s.globalTaskDetail?{teamName:s.globalTaskDetail.teamName,taskId:s.globalTaskDetail.taskId}:null,
        paneTabs:s.paneLayout.panes.flatMap(p=>p.tabs.map(t=>({type:t.type,teamName:t.teamName}))).slice(0,24)
      }:null})(),
      rootChildCount:document.getElementById('root')?.childElementCount??null,
      dialogs:[...document.querySelectorAll('[role="dialog"]')].slice(0,3).map(e=>({text:e.innerText.slice(-8000),buttons:[...e.querySelectorAll('button')].slice(-24).map(b=>{const r=b.getBoundingClientRect();return{text:b.textContent.trim().slice(0,160),disabled:b.disabled,x:r.x,y:r.y,width:r.width,height:r.height};})})),
      tabs:[...document.querySelectorAll('[role=tab]')].slice(0,24).map(e=>({text:e.textContent.trim().slice(0,150),selected:e.getAttribute('aria-selected')})),
      visibleTaskCardIds:[...document.querySelectorAll('.kanban-task-card[data-task-id]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0}).slice(0,24).map(e=>e.getAttribute('data-task-id')),
      splashPresent:Boolean(document.getElementById('splash')),
      splashStatus:document.getElementById('splash-status')?.textContent?.slice(0,200),startup,
      moduleScripts:[...document.querySelectorAll('script[type="module"]')].slice(0,24).map(e=>({path:e.src?safePath(e.src):null,inline:!e.src,importsMain:!e.src&&e.textContent.includes("import('./main.tsx')")})),
      resources:performance.getEntriesByType('resource').map(e=>({path:safePath(e.name),type:e.initiatorType,startTime:Math.round(e.startTime),duration:Math.round(e.duration),responseStatus:e.responseStatus??null})).filter(e=>e.path!==null).slice(-160)};
  })()`);
}
