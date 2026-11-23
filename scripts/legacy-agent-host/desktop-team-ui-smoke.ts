import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileDigest } from './desktop-backend-fixture.ts';
import { bounded } from './desktop-proof-bounds.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';

import { createDesktopUiControls } from './desktop-ui-controls.ts';
import { desktopNetworkFailure, observeDesktopModuleLoads } from './desktop-module-load-observation.ts';
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

/** Configure the captured Ozone window once, spending only its original startup budget. */
export async function prepareDesktopHeadlessViewport(
  cdp: UiCdpPort,
  options: { deadline: number; assertOwnedRenderer(): void }
): Promise<{ width: number; height: number; deviceScaleFactor: number; mobile: false }> {
  const remaining = (): number => {
    assert.ok(Number.isFinite(options.deadline) && performance.now() < options.deadline,
      'original headless viewport startup deadline');
    options.assertOwnedRenderer();
    const budget = options.deadline - performance.now();
    assert.ok(budget > 0, 'original headless viewport startup deadline');
    return budget;
  };
  const viewport = { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false as const };
  for (const [method, params] of [
    ['Page.enable', {}], ['Page.bringToFront', {}],
    ['Emulation.setFocusEmulationEnabled', { enabled: true }],
    ['Emulation.setDeviceMetricsOverride', viewport],
  ] as const) {
    const budget = remaining();
    await bounded(cdp.send(method, params), budget, 'original headless viewport command');
    remaining();
  }
  for (;;) {
    const budget = remaining();
    const ready = await bounded(cdp.evaluate('innerWidth === 1440 && innerHeight === 1000'),
      budget, 'original headless viewport observation');
    remaining();
    if (ready === true) return viewport;
    await new Promise<void>(done => setTimeout(done, Math.min(100, remaining())));
  }
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
  const viewLoads: { events: unknown[]; overflow: boolean } = { events: [], overflow: false };
  const startupEvidence: Record<string, unknown> = { status: 'WAITING', commands: [], contextEvents: [] };
  evidence.rendererDiagnostics = { scope: 'bounded read-only module/load evidence', events, startup: startupEvidence, viewLoads };
  const commands = startupEvidence.commands as Record<string, unknown>[];
  const contextEvents = startupEvidence.contextEvents as Record<string, unknown>[];
  const contexts = new Map<number, unknown>();
  let mainFrameId: unknown, revision = 0;
  const moduleLoads = observeDesktopModuleLoads(cdp, rendererUrl, () => mainFrameId);
  (evidence.rendererDiagnostics as Record<string, unknown>).moduleLoads =
    moduleLoads.evidence;
  let viewLoadDocumentRevision: number | undefined;
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
    } catch (error) {
      command.failedMs = Math.round(performance.now()); command.failedEpochMs = Date.now();
      command.failed = /timed out/i.test(String(error)) ? 'timeout' : 'refused'; throw error;
    }
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
    moduleLoads.loadingFailed(value);
    const entry = record(value);
    add({
      event: 'Network.loadingFailed',
      type: entry.type,
      canceled: entry.canceled,
      blockedReason: entry.blockedReason,
      errorText: desktopNetworkFailure(entry.errorText),
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
  cdp.on('Runtime.consoleAPICalled', (value) => {
    try {
      const entry = record(value), contextId = entry.executionContextId;
      if (entry.type !== 'debug' || typeof contextId !== 'number' ||
          viewLoadDocumentRevision === undefined || revision !== viewLoadDocumentRevision ||
          contextId !== startupEvidence.contextId || mainFrameId !== startupEvidence.frameId ||
          contexts.get(contextId) !== mainFrameId || !Array.isArray(entry.args) || entry.args.length !== 1)
        return;
      const argument = record(entry.args[0]);
      if (argument.type !== 'string' || typeof argument.value !== 'string') return;
      const raw = argument.value;
      if (raw.length > 1024 || !raw.startsWith('{"kind":"runtime-provider-view-load-v1",') ||
          Buffer.byteLength(raw, 'utf8') > 1024) return;
      const row = record(JSON.parse(raw) as unknown);
      const keys = ['kind', 'owner', 'request', 'phase', 'silent', 'sequenceCurrent',
        'contextCurrent', 'viewPresent', 'inheritanceFields', 'loadingFalseSet'];
      if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)) ||
          row.kind !== 'runtime-provider-view-load-v1' ||
          typeof row.owner !== 'number' || !Number.isSafeInteger(row.owner) || row.owner <= 0 ||
          typeof row.request !== 'number' || !Number.isSafeInteger(row.request) || row.request <= 0 ||
          typeof row.phase !== 'string' || !['start', 'response-checked', 'response-error',
            'view-set', 'error-checked', 'finished'].includes(row.phase) ||
          typeof row.silent !== 'boolean' ||
          ['sequenceCurrent', 'contextCurrent', 'viewPresent', 'loadingFalseSet'].some(
            key => row[key] !== null && typeof row[key] !== 'boolean') ||
          (row.inheritanceFields !== null && (typeof row.inheritanceFields !== 'number' ||
            !Number.isInteger(row.inheritanceFields) || row.inheritanceFields < 0 || row.inheritanceFields > 31)))
        return;
      if (viewLoads.events.length >= 96) { viewLoads.overflow = true; return; }
      const observation = {
        monotonicMs: Math.round(performance.now()), executionContextId: contextId,
        documentRevision: viewLoadDocumentRevision, kind: row.kind, owner: row.owner,
        request: row.request, phase: row.phase, silent: row.silent,
        sequenceCurrent: row.sequenceCurrent, contextCurrent: row.contextCurrent,
        viewPresent: row.viewPresent, inheritanceFields: row.inheritanceFields,
        loadingFalseSet: row.loadingFalseSet,
      };
      viewLoads.events.push(observation);
      console.log(JSON.stringify({ kind: 'TEST_RENDERER_VIEW_LOAD', observation }));
    } catch {
      // Passive diagnostics cannot replace the original startup or UI failure.
    }
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
          startupEvidence.frameId = mainFrameId; startupEvidence.readyState = value.readyState;
          viewLoadDocumentRevision = observedRevision; break;
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
  // Keep the original first 24 observations plus one fixed last record; no extra read or retained protocol value.
  const stamp = () => ({ monotonicMs: Math.round(performance.now()), epochMs: Date.now() });
  const last: Record<string, unknown> = { attempt: 0, phase: 'waiting', failure: null, observation: null };
  const appReadiness: Record<string, unknown> = { status: 'WAITING', observations: [],
    deadlineMs: Math.round(deadline), clock: stamp(), last, contextRetries: 0 };
  startupEvidence.appReadiness = appReadiness;
  const observations = appReadiness.observations as unknown[];
  let attempts = 0, contextRetries = 0;
  try {
    while (performance.now() < deadline) {
      Object.assign(last, { attempt: ++attempts, phase: 'owner-before', enteredAt: stamp(),
        callAt: null, completedAt: null, failedAt: null, failure: null, documentRevision: revision });
      startup.assertOwnedRenderer();
      last.phase = 'budget-before';
      const remaining = deadline - performance.now();
      last.remainingMs = remaining;
      assert.ok(remaining > 0, 'original startup budget remains before Main/UI readiness');
      let value: Record<string, unknown>;
      try {
        last.phase = 'evaluate'; last.callAt = stamp();
        const response = await bounded(cdp.evaluate(`(async () => {
        const status = window.electronAPI?.startup?.getStatus ? await window.electronAPI.startup.getStatus() : null;
        return {originMatches:(${rendererDocumentMatches.toString()})(location.href,${JSON.stringify(rendererUrl)}),mainReady:status?.ready===true,
          errorPresent:Boolean(status?.error),phase:typeof status?.phase==='string'?status.phase.slice(0,80):'bridge-pending',
          uiDidInit:window.__claudeTeamsUiDidInit===true,storePresent:Boolean(window.__agentTeamsDevStore),
          rootChildCount:document.getElementById('root')?.childElementCount??0};
      })()`), remaining, 'Main/UI startup readiness');
        last.completedAt = stamp(); last.phase = 'decode'; value = record(response);
      } catch (error) {
        const description = String(error);
        const transient = /execution context was destroyed|cannot find (?:default )?execution context|cannot find context with specified id/i.test(description);
        last.failedAt = stamp();
        last.failure = transient ? 'context-changed' : description === 'Error: CDP command timed out: Runtime.evaluate'
          ? 'cdp-timeout' : description === 'Error: Main/UI startup readiness timed out; no mutation retry'
            ? 'startup-budget' : description === 'Error: CDP connection closed' ? 'cdp-closed' : 'refused';
        if (!transient) throw error;
        appReadiness.contextRetries = ++contextRetries;
        await new Promise<void>(done => setTimeout(done, Math.min(100, Math.max(0, deadline - performance.now()))));
        continue;
      }
      last.phase = 'owner-after'; startup.assertOwnedRenderer();
      if (observations.length < 24) observations.push({ monotonicMs: Math.round(performance.now()), ...value });
      last.observation = { attempt: attempts, observedAt: stamp(),
        mainPhase: value.phase === 'ready' ? 'ready' : value.phase === 'bridge-pending' ? 'bridge-pending' : 'other',
        ...Object.fromEntries(['originMatches', 'mainReady', 'errorPresent', 'uiDidInit', 'storePresent']
          .map(key => [key, typeof value[key] === 'boolean' ? value[key] : null])),
        rootChildCount: Number.isSafeInteger(value.rootChildCount) && Number(value.rootChildCount) >= 0 ? value.rootChildCount : null };
      last.phase = 'main-admission';
      assert.notEqual(value.errorPresent, true, 'Main startup refused before UI readiness');
      last.phase = 'budget-after';
      assert.ok(performance.now() < deadline, 'original startup budget remains after Main/UI observation');
      last.phase = 'check-ready';
      if (value.originMatches === true && value.mainReady === true && value.uiDidInit === true &&
          typeof value.rootChildCount === 'number' && value.rootChildCount > 0) {
        appReadiness.status = 'READY'; appReadiness.observation = value; last.phase = 'ready'; return;
      }
      last.phase = 'delay';
      await new Promise<void>(done => setTimeout(done, Math.min(100, Math.max(0, deadline - performance.now()))));
    }
    last.phase = 'budget-expired';
    assert.fail('original startup budget expired before Main/UI readiness');
  } catch (error) {
    last.rejectedAt = stamp();
    if (String(last.phase).startsWith('budget-')) { last.failedAt = last.rejectedAt; last.failure = 'startup-budget'; }
    else { last.failedAt ??= last.rejectedAt; last.failure ??= 'refused'; }
    throw error;
  }
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
        selectedRawMemberCapabilities:(()=>{
          const source=s.selectedTeamData?'selected':s.selectedTeamName&&s.teamDataCacheByName?.[s.selectedTeamName]?'cache':'unavailable';
          const data=source==='selected'?s.selectedTeamData:source==='cache'?s.teamDataCacheByName[s.selectedTeamName]:null;
          if(!data)return {source,state:'unavailable'};
          if(!Array.isArray(data.members))return {source,state:'invalid'};
          return {source,state:'available',count:Math.min(data.members.length,33),overflow:data.members.length>32,
            members:data.members.slice(0,32).map(member=>{
              if(!member||typeof member!=='object'||Array.isArray(member))return {valid:false};
              const commands=member.sessionCommands;
              const catalog=commands===undefined?{state:'absent',count:null,overflow:false,hasCost:null}:
                !Array.isArray(commands)?{state:'invalid',count:null,overflow:false,hasCost:null}:
                commands.length>64?{state:'oversized',count:65,overflow:true,hasCost:null}:
                !commands.every(command=>command&&typeof command==='object'&&!Array.isArray(command)&&typeof command.name==='string'&&typeof command.description==='string')?
                  {state:'invalid',count:commands.length,overflow:false,hasCost:null}:
                  {state:'available',count:commands.length,overflow:false,hasCost:commands.some(command=>command.name==='cost')};
              return {valid:true,provider:['claude','codex','opencode'].includes(member.providerId)?member.providerId:'unknown',
                capturedOwner:member.runtimeOwner==='captured-host',
                attachments:typeof member.nativeInboxAttachmentsSupported==='boolean'?member.nativeInboxAttachmentsSupported:null,
                textAttachments:typeof member.nativeInboxTextAttachmentsSupported==='boolean'?member.nativeInboxTextAttachmentsSupported:null,catalog};
            })};
        })(),
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
      commandComposer:(()=>{
        const areas=document.querySelectorAll('.message-composer-flat-layout textarea');
        const listboxes=document.querySelectorAll('[role="listbox"]');
        const options=document.querySelectorAll('[role="listbox"] [role="option"]');
        const labels=document.querySelectorAll('[role="listbox"] [role="option"] .font-medium');
        const area=areas.length===1?areas[0]:null;
        return {observedAfterFailure:true,atomicWithInput:false,
          textareaCount:Math.min(areas.length,5),textareaOverflow:areas.length>4,
          single:area?{focused:document.activeElement===area,connected:area.isConnected,disabled:area.disabled,readOnly:area.readOnly,
            bareSlash:area.value==='/',length:Math.min(area.value.length,4097),lengthOverflow:area.value.length>4096,
            cursorStart:area.selectionStart===null?null:Math.min(area.selectionStart,4097),
            cursorEnd:area.selectionEnd===null?null:Math.min(area.selectionEnd,4097)}:null,
          listboxCount:Math.min(listboxes.length,9),listboxOverflow:listboxes.length>8,
          optionCount:Math.min(options.length,65),optionOverflow:options.length>64,
          hasCostOption:options.length>64||labels.length>64?null:[...labels].some(label=>{const text=label.textContent;return typeof text==='string'&&text.length<=128&&text.trim()==='/cost';})};
      })(),
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
