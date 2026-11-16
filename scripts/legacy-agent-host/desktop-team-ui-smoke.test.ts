import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';

import { desktopShellEnvironmentProbeSource } from './desktop-backend-fixture.ts';
import { readRendererBackendConnections } from './desktop-backend-observations.ts';
import { attachRendererDiagnostics } from './desktop-team-ui-smoke.ts';
import { assertDesktopOwnerRoutingAvailability } from './desktop-owner-routing-availability-ui.ts';
import { hostTeamSelectionKey } from '../../src/features/agent-backend/contracts/teamSelection.ts';
import { desktopTaskBoardAssignmentReadyExpression } from './desktop-task-comment-input-target.ts';
import { runDesktopTaskBoardAttachmentsUi } from './desktop-task-board-attachments-ui.ts';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import { projectDesktopCodexLoginFailure } from './desktop-codex-login-ui-proof.ts';
import { projectDesktopCodexInstallerFailure, projectDesktopSelectionTargetFailure } from './desktop-backend-failures.ts';
import { projectDesktopEmulatedReadinessFailure, projectDesktopProofReceiptSummary, projectDesktopTaskBoardFailure } from './desktop-proof-evidence.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const ready = { originMatches: true, mainReady: true, errorPresent: false, phase: 'ready',
  uiDidInit: true, storePresent: true, rootChildCount: 1 };
function fixture(reads: ReturnType<typeof deferred<Record<string, unknown>>>[]) {
  const listeners = new Map<string, (value: unknown) => void>();
  const acknowledgments = reads.map(() => deferred<void>());
  let observations = 0, discovery = 0;
  const commands: string[] = [];
  const cdp = {
    on(method: string, listener: (value: unknown) => void) { listeners.set(method, listener); },
    async send(method: string) {
      commands.push(method);
      if (method === 'Runtime.enable') listeners.get('Runtime.executionContextCreated')?.({
        context: { id: 7, auxData: { isDefault: true, frameId: 'TEST-frame' } },
      });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'TEST-frame', url: 'http://localhost:5173/' } } };
      if (method === 'Runtime.evaluate') return { result: { value: { url: 'http://localhost:5173/', readyState: 'complete' } } };
      return {};
    },
    async evaluate(expression: string) {
      if (expression.startsWith('Boolean(')) return true;
      if (expression === 'window.electronAPI.agentBackend.getConnections()') {
        discovery++; return { state: 'ready', bindings: [] };
      }
      assert.ok(expression.includes('window.electronAPI.startup.getStatus()'), 'only public startup snapshot before discovery');
      const index = observations++;
      assert.ok(reads[index], 'no extra startup read after its original deadline');
      acknowledgments[index]!.resolve();
      return reads[index]!.promise;
    },
  };
  const evidence: Record<string, unknown> = {};
  const start = (remainingMs: number) => attachRendererDiagnostics(cdp, 'http://localhost:5173/', evidence,
    { remainingMs, assertOwnedRenderer() {} }).then(() => readRendererBackendConnections(cdp));
  return { start, acknowledgments, evidence, listeners, commands,
    observations: () => observations, discovery: () => discovery };
}

test('captured UI discovery waits for Main admission and actual mount while early diagnostics remain active', { timeout: 5000 }, async () => {
  const reads = [deferred<Record<string, unknown>>(), deferred<Record<string, unknown>>(), deferred<Record<string, unknown>>()];
  const f = fixture(reads), pending = f.start(3000);
  await Promise.race([f.acknowledgments[0]!.promise, pending.then(() => { assert.fail('discovery completed before Main/UI readiness was observed'); })]);
  assert.equal(f.discovery(), 0);
  const diagnostics = f.evidence.rendererDiagnostics as { startup: { status: string }; };
  assert.equal(diagnostics.startup.status, 'DOCUMENT_READY', 'document diagnostics do not wait for full app admission');
  reads[0]!.resolve({ ...ready, mainReady: false, phase: 'team-backups' });
  await f.acknowledgments[1]!.promise; assert.equal(f.discovery(), 0);
  reads[1]!.resolve({ ...ready, uiDidInit: false, rootChildCount: 0 });
  await f.acknowledgments[2]!.promise; assert.equal(f.discovery(), 0);
  reads[2]!.resolve({ ...ready, storePresent: false }); // Packed builds expose no DEV store.
  assert.deepEqual(await pending, { kind: 'read', value: { state: 'ready', bindings: [] } });
  assert.equal(f.discovery(), 1);
});

test('the original remaining startup deadline rejects a pending snapshot without late discovery or a reset', { timeout: 5000 }, async () => {
  const held = deferred<Record<string, unknown>>(), f = fixture([held]);
  const pending = f.start(500);
  const rejected = assert.rejects(pending, /Main\/UI startup readiness timed out; no mutation retry/);
  await f.acknowledgments[0]!.promise; assert.equal(f.discovery(), 0);
  await rejected; assert.equal(f.discovery(), 0);
  held.resolve(ready); await setImmediate(); assert.equal(f.discovery(), 0);
});


const viewLoadSample = {
  kind: 'runtime-provider-view-load-v1', owner: 1, request: 1, phase: 'view-set', silent: false,
  sequenceCurrent: true, contextCurrent: true, viewPresent: true,
  inheritanceFields: 31, loadingFalseSet: null,
};
const viewLoadEvent = (value: unknown, contextId = 7) => ({
  type: 'debug', executionContextId: contextId,
  args: [{ type: 'string', value: typeof value === 'string' ? value : JSON.stringify(value) }],
});

test('view-load diagnostics retain and echo the same bounded current-document projection without new reads', { timeout: 5000 }, async t => {
  const output: string[] = [];
  t.mock.method(console, 'log', (value: unknown) => { output.push(String(value)); });
  const readyRead = deferred<Record<string, unknown>>(), f = fixture([readyRead]);
  const running = f.start(3000);
  const emit = f.listeners.get('Runtime.consoleAPICalled');
  assert.ok(emit, 'the passive listener precedes the original Runtime.enable');
  emit(viewLoadEvent(viewLoadSample));
  readyRead.resolve(ready);
  await running;
  const diagnostic = f.evidence.rendererDiagnostics as {
    events: unknown[];
    viewLoads: { events: Record<string, unknown>[]; overflow: boolean };
  };
  assert.deepEqual<typeof diagnostic.viewLoads>(diagnostic.viewLoads, { events: [], overflow: false },
    'an event before the original document fence is not attributed to the current view');
  emit(viewLoadEvent(viewLoadSample));
  assert.equal(diagnostic.viewLoads.events.length, 1);
  const retained = diagnostic.viewLoads.events[0]!;
  const { monotonicMs, executionContextId, documentRevision, ...fields } = retained;
  assert.equal(typeof monotonicMs, 'number'); assert.equal(executionContextId, 7);
  assert.equal(typeof documentRevision, 'number');
  assert.deepEqual(fields, viewLoadSample);
  const canary = 'TEST-private-renderer-value';
  const incomplete: Record<string, unknown> = { ...viewLoadSample };
  delete incomplete.contextCurrent;
  for (const invalid of [
    { ...viewLoadSample, private: canary }, incomplete,
    { ...viewLoadSample, owner: 0 }, { ...viewLoadSample, request: Number.MAX_SAFE_INTEGER + 1 },
    { ...viewLoadSample, phase: canary }, { ...viewLoadSample, silent: null },
    { ...viewLoadSample, contextCurrent: canary }, { ...viewLoadSample, viewPresent: 1 },
    { ...viewLoadSample, inheritanceFields: 32 }, { ...viewLoadSample, inheritanceFields: 0.5 },
    { ...viewLoadSample, loadingFalseSet: canary },
    '{"kind":"runtime-provider-view-load-v1",',
    JSON.stringify(viewLoadSample).padEnd(1025, ' '),
  ]) assert.doesNotThrow(() => emit(viewLoadEvent(invalid)));
  emit(viewLoadEvent(viewLoadSample, 999));
  emit({ ...viewLoadEvent(viewLoadSample), type: 'log' });
  emit({ ...viewLoadEvent(viewLoadSample), args: [{ type: 'object', value: canary }] });
  emit({ ...viewLoadEvent(viewLoadSample), args: [
    { type: 'string', value: JSON.stringify(viewLoadSample) }, { type: 'string', value: canary },
  ] });
  assert.doesNotThrow(() => emit(Object.defineProperty({}, 'type', {
    get() { throw new Error(canary); },
  })));
  assert.equal(diagnostic.viewLoads.events.length, 1);
  assert.equal(output.length, 1);
  f.listeners.get('Log.entryAdded')!({
    entry: { level: 'error', source: 'javascript', text: 'SyntaxError: TEST retained module error' },
  });
  const originalEvents = [...diagnostic.events];
  for (let request = 2; request <= 97; request++) emit(viewLoadEvent({ ...viewLoadSample, request }));
  assert.equal(diagnostic.viewLoads.events.length, 96);
  assert.equal(diagnostic.viewLoads.overflow, true);
  assert.deepEqual(diagnostic.events, originalEvents, 'view diagnostics do not consume the original module budget');
  assert.equal(output.length, 96, 'the receipt and stdout share the same finite admission');
  const echoes = output.map(line => JSON.parse(line) as { kind: string; observation: unknown });
  assert.ok(echoes.every(row => row.kind === 'TEST_RENDERER_VIEW_LOAD'));
  assert.deepEqual(echoes.map(row => row.observation), diagnostic.viewLoads.events);
  assert.ok(echoes.every(row => !('receipt' in row) && !('status' in row)),
    'the unchanged original final-receipt selector cannot treat a diagnostic as success');
  const saved = JSON.parse(JSON.stringify(f.evidence)) as typeof f.evidence;
  assert.deepEqual(saved.rendererDiagnostics, f.evidence.rendererDiagnostics);
  assert.equal(JSON.stringify(saved).includes(canary), false);
  assert.equal(output.join('\n').includes(canary), false);
  assert.deepEqual(f.commands, ['Page.enable', 'Runtime.enable', 'Page.getFrameTree',
    'Runtime.evaluate', 'Log.enable', 'Network.enable']);
  assert.equal(f.observations(), 1); assert.equal(f.discovery(), 1);
});

for (const invalidation of ['navigation', 'cleared', 'destroyed'] as const) test(
  `view-load diagnostics do not reuse the initial document fence after ${invalidation}`,
  { timeout: 5000 }, async t => {
    const output: string[] = [];
    t.mock.method(console, 'log', (value: unknown) => { output.push(String(value)); });
    const readyRead = deferred<Record<string, unknown>>(), f = fixture([readyRead]);
    readyRead.resolve(ready);
    await f.start(3000);
    const emit = f.listeners.get('Runtime.consoleAPICalled')!;
    emit(viewLoadEvent(viewLoadSample));
    if (invalidation === 'navigation') f.listeners.get('Page.frameNavigated')!({
      frame: { id: 'TEST-frame', url: 'http://localhost:5173/' },
    });
    else if (invalidation === 'cleared') f.listeners.get('Runtime.executionContextsCleared')!({});
    else f.listeners.get('Runtime.executionContextDestroyed')!({ executionContextId: 7 });
    // Even a reused default context ID in the same frame does not reopen the initial-document grant.
    f.listeners.get('Runtime.executionContextCreated')!({
      context: { id: 7, auxData: { isDefault: true, frameId: 'TEST-frame' } },
    });
    emit(viewLoadEvent({ ...viewLoadSample, request: 2 }));
    const diagnostic = f.evidence.rendererDiagnostics as { viewLoads: { events: unknown[] } };
    assert.equal(diagnostic.viewLoads.events.length, 1);
    assert.equal(output.length, 1);
    assert.equal(f.commands.length, 6); assert.equal(f.observations(), 1); assert.equal(f.discovery(), 1);
  }
);

test('throwing diagnostic stdout preserves the retained row and the original startup refusal', { timeout: 5000 }, async t => {
  let echoes = 0;
  t.mock.method(console, 'log', () => { echoes++; throw new Error('TEST-diagnostic-stdout-failure'); });
  const held = deferred<Record<string, unknown>>(), f = fixture([held]);
  const pending = f.start(3000);
  const refused = assert.rejects(pending, /Main startup refused before UI readiness/);
  await f.acknowledgments[0]!.promise;
  assert.doesNotThrow(() => f.listeners.get('Runtime.consoleAPICalled')!(viewLoadEvent(viewLoadSample)));
  const diagnostic = f.evidence.rendererDiagnostics as { viewLoads: { events: unknown[] } };
  assert.equal(diagnostic.viewLoads.events.length, 1);
  assert.equal(echoes, 1);
  held.resolve({ ...ready, errorPresent: true });
  await refused;
  assert.equal(f.discovery(), 0);
  assert.equal(diagnostic.viewLoads.events.length, 1);
});

function readinessRuntime(expression: string, href: string, origin: string): Promise<Record<string, unknown>> {
  return Promise.resolve(runInNewContext(expression, {
    URL,
    location: { href, origin },
    window: { __claudeTeamsUiDidInit: true,
      electronAPI: { startup: { getStatus: async () => ({ ready: true, phase: 'ready' }) } } },
    document: { getElementById: () => ({ childElementCount: 1 }) },
  }) as Promise<Record<string, unknown>>);
}
async function observedReadinessExpression(rendererUrl: string, runtimeOrigin: string): Promise<string> {
  const listeners = new Map<string, (value: unknown) => void>();
  let evaluated = '';
  const cdp = {
    on(method: string, listener: (value: unknown) => void) { listeners.set(method, listener); },
    async send(method: string) {
      if (method === 'Runtime.enable') listeners.get('Runtime.executionContextCreated')?.({
        context: { id: 7, auxData: { isDefault: true, frameId: 'TEST-packed-frame' } },
      });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'TEST-packed-frame', url: rendererUrl } } };
      if (method === 'Runtime.evaluate') return { result: { value: { url: rendererUrl, readyState: 'complete' } } };
      return {};
    },
    async evaluate(expression: string) {
      evaluated = expression;
      return readinessRuntime(expression, rendererUrl, runtimeOrigin);
    },
  };
  const evidence: Record<string, unknown> = {};
  await attachRendererDiagnostics(cdp, rendererUrl, evidence, { remainingMs: 1000, assertOwnedRenderer() {} });
  const diagnostics = evidence.rendererDiagnostics as { startup: { appReadiness: { status: string } } };
  assert.equal(diagnostics.startup.appReadiness.status, 'READY');
  assert.ok(evaluated);
  return evaluated;
}

test('packed file readiness executes the actual diagnostic expression using exact href instead of Electron opaque origin', { timeout: 5000 }, async () => {
  const expected = 'file:///Volumes/TEST%20candidate/Agent.app/Contents/Resources/app.asar/out/renderer/index.html';
  assert.equal(new URL(expected).origin, 'null');
  const expression = await observedReadinessExpression(expected, 'file://');
  for (const href of [expected, expected + '#same-document-route'])
    assert.equal((await readinessRuntime(expression, href, 'file://')).originMatches, true, href);
  for (const href of [
    expected.replace('index.html', 'other.html'),
    expected.replace('/TEST%20candidate/', '/OTHER/'),
    expected.replace('file:///', 'file://foreign/'),
    expected + '?different-document-input',
    'https://foreign.example/index.html', 'not a URL',
  ]) assert.equal((await readinessRuntime(expression, href, 'file://')).originMatches, false, href);
});

test('HTTP readiness keeps exact origin and document path guards when the runtime location origin is untrusted', { timeout: 5000 }, async () => {
  const expected = 'http://localhost:5173/index.html';
  const expression = await observedReadinessExpression(expected, 'http://localhost:5173');
  assert.equal((await readinessRuntime(expression, expected + '#same-document-route', 'http://localhost:5173')).originMatches, true);
  for (const href of ['http://localhost:5173/other.html', 'http://localhost:5174/index.html',
    'https://localhost:5173/index.html', 'http://foreign.example:5173/index.html'])
    assert.equal((await readinessRuntime(expression, href, 'http://localhost:5173')).originMatches, false, href);
});


test('isolated shell fixture emits the actual framed environment and refuses shell effects', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-desktop-shell-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'shell-probe.mjs'), log = join(root, 'sentinel.ndjson');
  await writeFile(script, desktopShellEnvironmentProbeSource(process.execPath, log));
  const nonce = 'AGENT_TEAMS_SHELL_ENV_12345678-1234-1234-1234-123456789abc';
  const command = `command printf '\\0%s\\0' '${nonce}_START' && env -0 && command printf '\\0%s\\0' '${nonce}_END'`;
  const env = { TEST_ONLY_VALUE: 'exact fixture value' };
  const assertDump = (dump: string) => {
    assert.ok(dump.endsWith('\0'), 'the actual environment dump remains NUL terminated');
    const entries = dump.split('\0').filter(Boolean).map(entry => {
      const separator = entry.indexOf('=');
      assert.ok(separator > 0);
      return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
    });
    assert.equal(new Set(entries.map(([key]) => key)).size, entries.length);
    const observed = Object.fromEntries(entries);
    assert.equal(observed.TEST_ONLY_VALUE, env.TEST_ONLY_VALUE);
    const extra = entries.filter(([key]) => key !== 'TEST_ONLY_VALUE');
    // macOS may insert this Core Foundation value before the Node script starts.
    if (process.platform === 'darwin' && extra.length === 1) {
      assert.equal(extra[0]![0], '__CF_USER_TEXT_ENCODING');
      assert.match(extra[0]![1], /^0x[0-9a-f]+:0x[0-9a-f]+:0x[0-9a-f]+$/iu);
    } else assert.deepEqual(extra, []);
  };
  for (const mode of ['-lic', '-ic']) {
    const actual = execFileSync(process.execPath, [script, mode, command], { env }).toString();
    const start = `\0${nonce}_START\0`, end = `\0${nonce}_END\0`;
    assert.ok(actual.startsWith(start), 'exact original start marker');
    assert.ok(actual.endsWith(end), 'exact original end marker');
    assertDump(actual.slice(start.length, -end.length));
  }
  assertDump(execFileSync(process.execPath, [script, '-ic', 'env -0'], { env }).toString());
  for (const refused of [command + '; touch arbitrary', command.replace('_END', '_OTHER'), 'env -0 && arbitrary']) {
    assert.throws(() => execFileSync(process.execPath, [script, '-lic', refused], { env, stdio: 'pipe' }),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'status' in error && error.status === 78));
  }
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { allowed: boolean });
  assert.deepEqual(calls.map(call => call.allowed), [true, true, true, false, false, false]);
});

function assignmentRuntime(stage?: 'in-progress-comment' | 'clarification') {
  const identity = {
    contextId: 'TEST-context',
    teamName: 'host-team:TEST-owner',
    taskId: 'TEST-task',
  };
  const captured = { contextId: identity.contextId, surfaceId: 'TEST-original-surface' };
  const key = JSON.stringify([identity.contextId, identity.teamName, identity.taskId]);
  const scope = { contextId: identity.contextId, teamName: identity.teamName, contextEpoch: 1, teamStateEpoch: 1 };
  const controller = {
    identity,
    surfaceId: captured.surfaceId,
    isOwner: true,
    canSubmit: true,
    canEditNow: () => true,
    canResolveClarification: true,
    attachmentError: null,
    session: {
      ownerSurfaceId: captured.surfaceId,
      ownerRevision: 1,
      commentText: '',
      partRevisions: { commentText: 0, pendingAttachments: 0 },
      submitPending: false,
      submitError: null,
      pendingAttachments: [],
      pendingAttachmentPreparationIds: [],
    },
  };
  const root = { return: null, stateNode: {} as { current: unknown } };
  root.stateNode.current = root;
  const dialogFiber = {
    return: root,
    memoizedProps: {
      open: true,
      teamName: identity.teamName,
      task: { id: identity.taskId },
      sessionController: controller,
    },
  };
  const trigger = {
    disabled: false,
    expanded: 'false',
    textContent: 'alice',
    getAttribute() {
      return this.expanded;
    },
  };
  const triggers = [trigger];
  const dialog = {
    __reactFiber$TEST: dialogFiber,
    getClientRects: () => [1],
    querySelectorAll(selector: string): unknown[] {
      return selector === 'textarea'
        ? [input]
        : selector === 'button[role="combobox"]'
          ? triggers
          : [];
    },
  };
  const input = {
    id: 'TEST-original-comment',
    disabled: false,
    getClientRects: () => [1],
    closest: () => dialog,
    __reactFiber$TEST: {
      return: dialogFiber,
      memoizedProps: {
        controller,
        contextId: identity.contextId,
        teamName: identity.teamName,
        taskId: identity.taskId,
        surfaceId: captured.surfaceId,
      },
    },
  };
  const detail = {
    identity: { ...identity },
    phase: 'ready',
    loading: false,
    refreshPending: false,
    error: null,
    deletionIntent: null,
    full: { id: identity.taskId, owner: 'alice', status: 'pending', needsClarification: 'user' },
    fullToken: { resource: 'full', key: 'full:' + key, serial: 1, sourceEpoch: 1,
      physicalStartOrder: 1, scope: { ...scope } },
  };
  const storedSession = { ...controller.session };
  const state = {
    taskDetailSessionById: { [key]: storedSession },
    activeContextId: identity.contextId,
    selectedTeamName: identity.teamName,
    isContextSwitching: false,
    taskDetailById: { [JSON.stringify(Object.values(identity))]: detail },
  };
  const work = { refreshPending: false, teamUnavailable: false };
  const imports: string[] = [];
  const expression = desktopTaskBoardAssignmentReadyExpression(
    'TEST-owner',
    identity.taskId,
    captured,
    stage
  );
  assert.equal(
    expression.match(/await import\(/g)?.length,
    2,
    'only the two existing read-only observer modules'
  );
  const evaluate = () =>
    Promise.resolve(
      runInNewContext(expression.replaceAll('await import(', 'await __testImport('), {
        window: { __agentTeamsDevStore: { getState: () => state } },
        document: {
          getElementById: () => input,
          querySelectorAll: (selector: string) =>
            selector === '[role="dialog"]' ? [dialog] : selector === 'textarea' ? [input] : [],
        },
        async __testImport(path: string) {
          imports.push(path);
          if (path === '/store/slices/teamSlice.ts')
            return {
              isTeamDataRefreshPending(team: string) {
                assert.equal(team, identity.teamName);
                return work.refreshPending;
              },
            };
          assert.equal(path, '/store/team/taskDetailReadAuthority.ts');
          return {
            captureTaskDetailReadScope(teamName: string, contextId: string) {
              assert.deepEqual(
                { teamName, contextId },
                { teamName: identity.teamName, contextId: captured.contextId }
              );
              return { ...scope };
            },
            isTaskDetailTeamUnavailable(observed: unknown, team: string, observedScope: unknown) {
              assert.equal(observed, state);
              assert.equal(team, identity.teamName);
              assert.deepEqual(observedScope, scope);
              return work.teamUnavailable;
            },
          };
        },
      }) as Promise<Record<string, unknown> | null>
    );
  return { evaluate, imports, state, detail, controller, storedSession, trigger, triggers, work };
}

test('original in-progress Task comment prerequisite requires its exact stage without an assignment control', async () => {
  const commentRuntime = () => {
    const f = assignmentRuntime('in-progress-comment');
    f.detail.full.status = 'in_progress';
    f.triggers.length = 0; // The real in-progress header renders an owner badge.
    return f;
  };
  const ready = await commentRuntime().evaluate();
  assert.equal(ready?.surfaceId, 'TEST-original-surface');
  for (const change of [
    (f: ReturnType<typeof commentRuntime>) => { f.detail.full.status = 'pending'; },
    (f: ReturnType<typeof commentRuntime>) => { f.detail.full.status = 'completed'; },
    (f: ReturnType<typeof commentRuntime>) => { f.detail.full.owner = 'bob'; },
    (f: ReturnType<typeof commentRuntime>) => { f.triggers.push(f.trigger); },
    (f: ReturnType<typeof commentRuntime>) => { f.work.refreshPending = true; },
    (f: ReturnType<typeof commentRuntime>) => { f.detail.refreshPending = true; },
    (f: ReturnType<typeof commentRuntime>) => { f.detail.loading = true; },
    (f: ReturnType<typeof commentRuntime>) => { f.detail.phase = 'unavailable'; },
    (f: ReturnType<typeof commentRuntime>) => { f.work.teamUnavailable = true; },
    (f: ReturnType<typeof commentRuntime>) => { f.state.activeContextId = 'foreign-context'; },
    (f: ReturnType<typeof commentRuntime>) => { f.state.selectedTeamName = 'host-team:foreign'; },
    (f: ReturnType<typeof commentRuntime>) => { f.detail.identity.taskId = 'foreign-task'; },
    (f: ReturnType<typeof commentRuntime>) => { f.controller.surfaceId = 'foreign-surface'; },
    (f: ReturnType<typeof commentRuntime>) => { f.controller.isOwner = false; },
    (f: ReturnType<typeof commentRuntime>) => { f.controller.canEditNow = () => false; },
  ]) {
    const f = commentRuntime();
    change(f);
    assert.equal(await f.evaluate(), null);
  }
  const assignment = assignmentRuntime();
  assignment.triggers.length = 0;
  assert.equal(await assignment.evaluate(), null, 'default assignment still requires its control');
});

test('Task attachment comment waits for its original focused owner after one click before inserting text', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-attachment-comment-focus-')));
  try {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=',
      'base64'
    );
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(png).digest('hex');
    const selector = '[role="dialog"] textarea[id="TEST-original-comment"]';
    const owner = {
      selector,
      identity: { contextId: 'TEST-context' },
      surfaceId: 'TEST-original-surface',
      inputId: 'TEST-original-comment',
      ownerRevision: 3,
      commentText: '',
      submitPending: false,
      submitError: null,
      pendingAttachmentCount: 0,
      pendingPreparationCount: 0,
      canSubmit: true,
      attachmentError: null,
    };
    const ready = {
      owner,
      inputProbe: {
        present: true,
        connected: true,
        disabled: false,
        focused: true,
        ownerSurfaceId: owner.surfaceId,
        ownerRevision: owner.ownerRevision,
        expectedSurfaceId: owner.surfaceId,
        detailPhase: 'ready',
        refreshPending: false,
        taskStatus: 'in_progress',
        taskId: 'TEST-task',
        activeContextId: owner.identity.contextId,
        contextSwitching: false,
      },
      settled: true,
      domValue: '',
      inputEnabled: true,
      visibility: 'visible',
      focused: true,
      documentFocused: true,
    };
    const afterFocus = [
      {
        ...ready,
        owner: null,
        inputProbe: {
          ...ready.inputProbe,
          present: false,
          connected: false,
          ownerRevision: null,
          focused: false,
        },
        settled: false,
        domValue: null,
        inputEnabled: false,
      },
      {
        ...ready,
        owner: { ...owner, selector: '[role="dialog"] textarea[id="TEST-rebound-comment"]' },
      },
      { ...ready, focused: false, inputProbe: { ...ready.inputProbe, focused: false } },
      ready,
    ];
    let focused = false,
      focusClicks = 0,
      postFocusReads = 0,
      insertions = 0,
      fileInputs = 0;
    const inserted = new Error('TEST original insertion reached after readiness');
    const cdp = {
      async evaluate(expression: string) {
        if (expression.includes('const settled=await')) {
          if (!focused) return { ...ready, focused: false };
          assert.ok(
            postFocusReads < afterFocus.length,
            'no read beyond the original settled focus'
          );
          return afterFocus[postFocusReads++]!;
        }
        if (expression.startsWith('Boolean(')) return true;
        if (expression.includes('const currentFiber=')) return owner;
        if (expression.includes('naturalWidth===2'))
          return { src: `data:image/png;base64,${png.toString('base64')}`, width: 2, height: 1 };
        if (expression.includes('let parent=e.parentElement')) return { visible: true };
        if (expression.includes('const elements =')) return { x: 10, y: 20 };
        throw new Error('unexpected TEST observer expression');
      },
      async send(method: string, params?: Record<string, unknown>) {
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelectorAll') return { nodeIds: [2] };
        if (method === 'DOM.setFileInputFiles') {
          fileInputs++;
          return {};
        }
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
          focusClicks++;
          focused = true;
        }
        if (method === 'Input.insertText') {
          insertions++;
          assert.equal(params?.text, 'TEST attachment comment original');
          assert.equal(
            postFocusReads,
            afterFocus.length,
            'missing, rebound and unfocused owners were refused'
          );
          throw inserted;
        }
        return {};
      },
    };
    const image = { filename: 'TEST-task-owned.png', artifactId: digest, mimeType: 'image/png' };
    await assert.rejects(
      runDesktopTaskBoardAttachmentsUi(cdp, {
        root,
        taskId: 'TEST-task',
        subject: 'TEST task',
        handleId: 'TEST-owner',
        proof: {},
        assertOwnedRenderer() {},
        step() {},
        async task() {
          return { attachments: [image] };
        },
        async commands() {
          return [];
        },
        async receiptFor() {
          return {
            phase: 'completed',
            command: {
              payload: {
                attachment: {
                  artifactId: digest,
                  byteLength: png.length,
                  digest,
                  mimeType: image.mimeType,
                },
              },
            },
          };
        },
        async waitProduct<T>(
          read: () => Promise<T>,
          matches: (value: T) => boolean,
          label: string
        ) {
          for (let observation = 0; observation < 6; observation++) {
            const value = await read();
            if (matches(value)) return value;
          }
          throw new Error(`TEST original readiness did not settle: ${label}`);
        },
        async screenshot() {
          return { path: join(root, 'TEST-image.png'), sha256: digest };
        },
      }),
      (error) => error === inserted
    );
    assert.equal(focusClicks, 1, 'the original focus action is never replayed');
    assert.equal(fileInputs, 1, 'only the original image was uploaded before comment insertion');
    assert.equal(insertions, 1, 'one insertion follows the exact original readiness');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('original Task assignment prerequisite refuses receipt-only, pending and stale renderer state', async () => {
  const f = assignmentRuntime();
  f.work.refreshPending = true;
  assert.equal(
    await f.evaluate(),
    null,
    'physical receipt does not settle the original UI refresh'
  );
  f.work.refreshPending = false;
  f.detail.refreshPending = true;
  assert.equal(await f.evaluate(), null);
  f.detail.refreshPending = false;
  f.detail.loading = true;
  assert.equal(await f.evaluate(), null);
  f.detail.loading = false;
  f.detail.full.owner = 'bob';
  assert.equal(await f.evaluate(), null, 'retained pre-assignment full Task is not completion');
  f.detail.full.owner = 'alice';
  f.work.teamUnavailable = true;
  assert.equal(
    await f.evaluate(),
    null,
    'visible Task alone is not current accepted live authority'
  );
  f.work.teamUnavailable = false;
  f.controller.canEditNow = () => false;
  assert.equal(await f.evaluate(), null, 'original Task owner forbids editing');
  f.controller.canEditNow = () => true;
  const result = await f.evaluate();
  assert.equal(result?.surfaceId, 'TEST-original-surface');
  assert.equal((result?.identity as { contextId: string }).contextId, 'TEST-context');
  assert.deepEqual(
    [...new Set(f.imports)],
    ['/store/slices/teamSlice.ts', '/store/team/taskDetailReadAuthority.ts']
  );
});

test('original Task assignment prerequisite rejects a foreign context, Team, Task or rebound surface', async () => {
  for (const change of [
    (f: ReturnType<typeof assignmentRuntime>) => {
      f.state.activeContextId = 'foreign-context';
    },
    (f: ReturnType<typeof assignmentRuntime>) => {
      f.state.selectedTeamName = 'host-team:foreign';
    },
    (f: ReturnType<typeof assignmentRuntime>) => {
      f.detail.identity.taskId = 'foreign-task';
    },
    (f: ReturnType<typeof assignmentRuntime>) => {
      f.controller.surfaceId = 'foreign-surface';
    },
    (f: ReturnType<typeof assignmentRuntime>) => {
      f.controller.isOwner = false;
    },
    (f: ReturnType<typeof assignmentRuntime>) => {
      f.trigger.expanded = 'true';
    },
    (f: ReturnType<typeof assignmentRuntime>) => {
      f.trigger.textContent = 'bob';
    },
  ]) {
    const f = assignmentRuntime();
    change(f);
    assert.equal(await f.evaluate(), null);
  }
});

test('original desktop click waits for stable target geometry, without repeating input', { timeout: 5000 }, async () => {
  const points = [
    { x: 100, y: 100, tag: 'BUTTON' },
    { x: 100, y: 100, tag: 'BUTTON' },
    { x: 100, y: 200, tag: 'BUTTON' },
    { x: 100, y: 200, tag: 'BUTTON' },
    { x: 100, y: 200, tag: 'BUTTON' },
  ];
  const dispatched: Record<string, unknown>[] = [];
  const cdp = {
    async evaluate(expression: string) {
      assert.ok(expression.includes('document.querySelectorAll'));
      return points.shift() ?? { x: 100, y: 200, tag: 'BUTTON' };
    },
    async send(method: string, params: Record<string, unknown> = {}) {
      if (method === 'Input.dispatchMouseEvent') dispatched.push({ ...params });
      return {};
    },
  };
  const ui = createDesktopUiControls(cdp, { assertOwnedRenderer() {}, step() {} });
  await ui.click('#TEST-original-toggle', 'TEST moving original toggle');
  assert.deepEqual(dispatched.map(({ type }) => type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  for (const event of dispatched) {
    assert.equal(event.x, 100);
    if (event.type !== 'mouseMoved') assert.equal(event.y, 200);
  }
});

test('original Task hover waits through layout and unavailability before its one physical move', { timeout: 5000 }, async () => {
  const expression = 'TEST_originalTaskHitPoint()';
  const points = [
    { x: 100, y: 100 }, { x: 100, y: 200 }, { x: 100, y: 200 },
    null, { x: 100, y: 200 }, { x: 100, y: 200 }, { x: 100, y: 200 },
  ];
  const dispatched: Record<string, unknown>[] = [], steps: Record<string, unknown>[] = [];
  let reads = 0;
  const ui = createDesktopUiControls({
    async evaluate(actual: string) {
      assert.equal(actual, expression);
      reads++;
      return points.shift();
    },
    async send(method: string, params: Record<string, unknown> = {}) {
      assert.equal(method, 'Input.dispatchMouseEvent');
      assert.equal(reads, 7, 'no move at a stale or temporarily ineligible target');
      dispatched.push({ ...params });
      return {};
    },
  }, { assertOwnedRenderer() {}, step(value) { steps.push(value); } });
  await ui.hoverExpression(expression, 'TEST original Task');
  assert.deepEqual(dispatched, [{ type: 'mouseMoved', x: 100, y: 200 }]);
  assert.deepEqual(steps, [{ action: 'mouseMoved', label: 'TEST original Task', target: { x: 100, y: 200 } }]);
});

test('original desktop click refuses a constantly moving target before dispatch', { timeout: 5000 }, async () => {
  let reads = 0;
  const dispatched: string[] = [];
  const cdp = {
    async evaluate(expression: string) {
      assert.ok(expression.includes('document.querySelectorAll'));
      return { x: 100, y: 100 + reads++ * 10, tag: 'BUTTON' };
    },
    async send(method: string, params: Record<string, unknown> = {}) {
      if (method === 'Input.dispatchMouseEvent') dispatched.push(String(params.type));
      return {};
    },
  };
  const ui = createDesktopUiControls(cdp, { assertOwnedRenderer() {}, step() {} });
  await assert.rejects(ui.click('#TEST-original-toggle', 'TEST moving original toggle'), /did not settle before one click/);
  assert.deepEqual(dispatched, ['mouseMoved'], 'no physical click after unstable ownership');
});

test('original owner-qualified click rereads its full expression through unavailability at unchanged coordinates', { timeout: 5000 }, async () => {
  const expression = '(async () => TEST_currentOwnerAndEnabledControl())()';
  const observations = [
    { x: 100, y: 100 },
    { x: 100, y: 100 },
    null,
    { x: 100, y: 100 },
    { x: 100, y: 100 },
  ];
  const dispatched: Record<string, unknown>[] = [];
  let reads = 0;
  const ui = createDesktopUiControls({
    async evaluate(actual: string) {
      assert.equal(actual, expression, 'every sample executes the original owner-qualified lookup');
      reads++;
      return observations.length ? observations.shift() : { x: 100, y: 100 };
    },
    async send(method: string, params: Record<string, unknown> = {}) {
      if (method === 'Input.dispatchMouseEvent') dispatched.push({ ...params });
      return {};
    },
  }, { assertOwnedRenderer() {}, step() {} });
  await ui.clickExpression(expression, 'TEST original owner-qualified control');
  assert.ok(reads >= 5, 'temporary unavailability is observed before the ready control settles');
  assert.deepEqual(dispatched.map(({ type }) => type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.deepEqual(dispatched.slice(1).map(({ x, y }) => ({ x, y })), [
    { x: 100, y: 100 }, { x: 100, y: 100 },
  ], 'only one press/release at the eligible original target');
});

test('login failure facts retain only bounded original attempts and confirmed milestones', () => {
  const privateSentinel = 'TEST-private-account-URL-code-clipboard-selector-error';
  const evidence = {
    status: 'INCOMPLETE', failure: privateSentinel,
    codexInitialAccount: { managedAccount: { token: privateSentinel }, appServerState: privateSentinel },
    cdpListenerFailure: { scope: 'original-linux-lsof-test-cdp', holderCount: 2,
      files: [{ pid: 123456, endpoint: privateSentinel }] },
    codexLoginUi: { status: 'INCOMPLETE', privateFields: privateSentinel,
      steps: [{ action: 'mouseClick', label: 'start one original browser login',
        selector: privateSentinel, target: { text: privateSentinel } }],
      cases: [{ mode: 'browser', status: 'INCOMPLETE', nativeStatus: 'pending',
        copyAcknowledged: true, authUrl: privateSentinel, userCode: privateSentinel }] },
    cleanup: { remaining: [{ pid: 123456, executable: privateSentinel }],
      capturedHostObserved: true, capturedHostAbsent: false, cleanupFailure: privateSentinel },
  };
  const before = structuredClone(evidence);
  const projection = projectDesktopCodexLoginFailure(evidence);
  assert.equal(projection.initialSnapshotRecorded, true);
  assert.equal(projection.proofRecorded, true);
  assert.equal(projection.originalFailureRecorded, true);
  assert.deepEqual(projection.listenerFailure, { recorded: true, count: 2, overflow: false });
  assert.deepEqual(projection.steps, { count: 1, overflow: false,
    lastAction: 'mouseClick', lastAttempt: 'browser-start' });
  assert.deepEqual(projection.cases, { count: 1, overflow: false, items: [{
    mode: 'browser', status: 'INCOMPLETE', nativeStatus: 'pending', copyAcknowledged: true,
    externalOpenDispatched: null, reopenPreservedOriginal: null, cancelledOriginal: null, privateFieldsCleared: null,
  }] });
  assert.deepEqual(projection.cleanup, { recorded: true, count: 1, overflow: false,
    capturedHostObserved: true, capturedHostAbsent: false, failureRecorded: true });
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes(privateSentinel), false);
  assert.equal(serialized.includes('123456'), false);
  assert.ok(Buffer.byteLength(serialized) <= 4096);
  assert.deepEqual(evidence, before, 'the original private receipt is unchanged');
  const overflow = projectDesktopCodexLoginFailure({ ...evidence, codexLoginUi: {
    steps: Array.from({ length: 257 }, () => ({ action: privateSentinel, label: privateSentinel })),
    cases: [null, { mode: privateSentinel, nativeStatus: privateSentinel }, privateSentinel],
  } });
  assert.deepEqual(overflow.steps, { count: 256, overflow: true, lastAction: null, lastAttempt: null });
  const unknownCase = { mode: null, status: null, nativeStatus: null, copyAcknowledged: null,
    externalOpenDispatched: null, reopenPreservedOriginal: null, cancelledOriginal: null, privateFieldsCleared: null };
  assert.deepEqual(overflow.cases, { count: 2, overflow: true, items: [unknownCase, unknownCase] });
  assert.equal(JSON.stringify(overflow).includes(privateSentinel), false);
  assert.ok(Buffer.byteLength(JSON.stringify(overflow)) <= 4096);
  const malformed = projectDesktopCodexLoginFailure({ codexLoginUi: privateSentinel,
    failure: { privateSentinel }, cleanup: { cleanupFailure: { privateSentinel } } });
  assert.equal(malformed.proofRecorded, null);
  assert.deepEqual(malformed.steps, { count: null, overflow: null, lastAction: null, lastAttempt: null });
  assert.equal(malformed.originalFailureRecorded, null);
  assert.deepEqual(malformed.cleanup, { recorded: true, count: null, overflow: null,
    capturedHostObserved: null, capturedHostAbsent: null, failureRecorded: null });
  assert.equal(JSON.stringify(malformed).includes(privateSentinel), false);
  assert.equal(projectDesktopCodexLoginFailure({}).originalFailureRecorded, false);
});

test('finite readiness failure summaries keep only bounded states and never private snapshot data', () => {
  const secret = 'TEST-private-value https://TEST-private.example/token /TEST-secret/path';
  const evidence = { status: 'INCOMPLETE', stoppedImportUiProof: { hydrationFailureDiagnostics: {
    text: 'Runtime environment unavailable ' + secret, permissions: 'unchecked', inputs: [{ value: secret }] } },
    rendererFailureSnapshot: { store: { provisioning: [{ currentProvisioningRunId: secret,
      error: 'Runtime source changed ' + secret, progress: { state: 'failed', configReady: false,
        message: 'Selected model could not be verified ' + secret } }] } } };
  const before = JSON.stringify(evidence), result = projectDesktopEmulatedReadinessFailure(evidence);
  assert.ok('hydration' in result && result.hydration && 'provisioning' in result && result.provisioning);
  assert.equal(result.hydration.text.runtimeUnavailable, true);
  assert.equal(result.hydration.permissions, 'unchecked');
  assert.equal(result.provisioning.items[0]!.state, 'failed');
  assert.equal(result.provisioning.items[0]!.configReady, false);
  assert.deepEqual(result.provisioning.items[0]!.error.terms, ['runtime', 'source', 'changed']);
  assert.equal(result.provisioning.items[0]!.message.modelUnverified, true);
  assert.doesNotMatch(JSON.stringify(result), /TEST-private|https:|\/TEST-secret|Runtime source changed/);
  assert.equal(JSON.stringify(evidence), before);
  for (const mode of ['emulated-import-ui', 'emulated-opencode-runtime-ui']) {
    assert.ok('emulatedReadinessFailure' in projectDesktopProofReceiptSummary(evidence, { mode, receiptPath: 'TEST-receipt', mixedMode: false }));
    assert.equal('emulatedReadinessFailure' in projectDesktopProofReceiptSummary({ ...evidence, status: 'PASS' }, { mode, receiptPath: 'TEST-receipt', mixedMode: false }), false);
  }
  for (const mode of ['team-ui', 'emulated-extensions-ui'])
    assert.equal('emulatedReadinessFailure' in projectDesktopProofReceiptSummary(evidence, { mode, receiptPath: 'TEST-receipt', mixedMode: false }), false);
  let getterReads = 0;
  projectDesktopEmulatedReadinessFailure(Object.defineProperty({}, 'rendererFailureSnapshot', {
    get() { getterReads++; throw new Error(secret); } }));
  projectDesktopEmulatedReadinessFailure({ rendererFailureSnapshot: { store: {
    provisioning: new Proxy([], { get() { getterReads++; throw new Error(secret); } }) } } });
  assert.equal(getterReads, 0);
  const overflow = projectDesktopEmulatedReadinessFailure({ rendererFailureSnapshot: {
    store: { provisioning: Array.from({ length: 99 }, () => ({ progress: { state: secret } })) } } });
  assert.ok('provisioning' in overflow && overflow.provisioning);
  assert.equal(overflow.provisioning.count, 9); assert.equal(overflow.provisioning.overflow, true);
  assert.equal(overflow.provisioning.items.length, 8);
  assert.ok(overflow.provisioning.items.every(row => row.state === null));
  assert.ok(Buffer.byteLength(JSON.stringify(overflow)) <= 8192);
});

test('Taskboard failure summaries compare retained identities without exposing private snapshot values', () => {
  const secret = 'TEST-private-value https://TEST-private.example/token /TEST-private/path';
  const identity = { contextId: 'local', teamName: 'TEST-private-owner', taskId: 'TEST-private-task' };
  const surface = 'TEST-private-original-surface';
  const inputId = (selectedSurface: string, selected = identity) =>
    'task-comment-input-' + encodeURIComponent(JSON.stringify([selectedSurface,
      JSON.stringify([selected.contextId, selected.teamName, selected.taskId])]));
  const evidence = { status: 'INCOMPLETE', taskBoardUiProof: {
    createReceipt: { effects: { taskId: identity.taskId } },
    attachments: { commentReceipt: { phase: 'completed' }, commentComposerCompleted: {
      ...identity, identity, surfaceId: surface, inputId: inputId(surface), commentText: '', submitPending: false,
    } } }, rendererFailureSnapshot: {
      documentFocused: true, visibility: 'visible',
      store: { selectedTeamName: identity.teamName, selectedTeamError: 'unavailable ' + secret,
        globalTaskDetail: { teamName: identity.teamName, taskId: identity.taskId } },
      dialogs: [{ text: 'Loading task Comments Attachments ' + secret }],
      visibleTaskCardIds: [identity.taskId],
      commandComposer: { textareaCount: 1, textareaOverflow: false,
        single: { disabled: true, focused: false, readOnly: false, connected: true } },
      inputEvents: [{ type: 'focusin', trusted: true, taskId: identity.taskId,
        target: { id: inputId('TEST-private-reloaded-surface') } }],
    } };
  const before = JSON.stringify(evidence), result = projectDesktopTaskBoardFailure(evidence);
  assert.ok('original' in result && result.original && 'inputEvents' in result && result.inputEvents);
  assert.equal(result.original.identityConsistent, true);
  assert.equal(result.original.commentReceiptCompleted, true);
  assert.equal(result.selectedTeamMatchesOriginal, true);
  assert.equal(result.globalTeamMatchesOriginal, true);
  assert.equal(result.globalTaskMatchesOriginal, true);
  assert.equal(result.originalTaskCardObserved, true);
  assert.equal(result.composer.disabled, true);
  assert.deepEqual(result.dialogs.items[0]?.terms, ['loading', 'comments', 'attachments']);
  assert.deepEqual(result.inputEvents.last[0], { type: 'focusin', trusted: true,
    cardTaskMatchesOriginal: true, inputRecorded: true, ownerTaskContextMatchesOriginal: true,
    sameOriginalSurface: false });
  for (const mode of ['task-board-ui', 'task-board-cross-team-ui']) {
    assert.deepEqual(projectDesktopProofReceiptSummary(evidence, {
      mode, receiptPath: 'TEST-receipt', mixedMode: false }).taskBoardFailure, result);
    assert.equal('taskBoardFailure' in projectDesktopProofReceiptSummary({ ...evidence, status: 'PASS' },
      { mode, receiptPath: 'TEST-receipt', mixedMode: false }), false);
  }
  for (const mode of ['cross-team-ui', 'emulated-import-ui', 'emulated-codex-runtime-ui'])
    assert.equal('taskBoardFailure' in projectDesktopProofReceiptSummary(evidence,
      { mode, receiptPath: 'TEST-receipt', mixedMode: false }), false);
  const serialized = JSON.stringify(result);
  for (const privateValue of [secret, identity.teamName, identity.taskId, surface, 'TEST-private-reloaded-surface', 'https://', '/TEST-private/path'])
    assert.equal(serialized.includes(privateValue), false);
  assert.equal(JSON.stringify(evidence), before);
  assert.notEqual(result.dialogs.items, evidence.rendererFailureSnapshot.dialogs);
  assert.notEqual(result.inputEvents.last, evidence.rendererFailureSnapshot.inputEvents);

  const foreign = projectDesktopTaskBoardFailure({ ...evidence, rendererFailureSnapshot: {
    ...evidence.rendererFailureSnapshot, inputEvents: [{ type: 'focusin', trusted: true,
      target: { id: inputId(surface, { ...identity, taskId: 'TEST-foreign-task' }) } }],
  } });
  assert.ok('inputEvents' in foreign && foreign.inputEvents);
  assert.equal(foreign.inputEvents.last[0]?.ownerTaskContextMatchesOriginal, false);
  assert.equal(foreign.inputEvents.last[0]?.sameOriginalSurface, true);
  const inconsistent = projectDesktopTaskBoardFailure({ ...evidence, taskBoardUiProof: {
    ...evidence.taskBoardUiProof, createReceipt: { effects: { taskId: 'TEST-foreign-created-task' } },
  } });
  assert.ok('original' in inconsistent && inconsistent.original);
  assert.equal(inconsistent.original.identityConsistent, false);
  assert.equal(inconsistent.selectedTeamMatchesOriginal, null);
  assert.equal(inconsistent.inputEvents.last[0]?.ownerTaskContextMatchesOriginal, null);

  let getterReads = 0;
  const unreadable = () => { getterReads++; throw new Error(secret); };
  projectDesktopTaskBoardFailure(Object.defineProperty({ ...evidence }, 'rendererFailureSnapshot', { get: unreadable }));
  projectDesktopTaskBoardFailure({ ...evidence, rendererFailureSnapshot: {
    ...evidence.rendererFailureSnapshot, inputEvents: new Proxy([], { get: unreadable }),
    dialogs: [Object.defineProperty({}, 'text', { get: unreadable })],
  } });
  assert.equal(getterReads, 0);
  const overflow = projectDesktopTaskBoardFailure({ ...evidence, rendererFailureSnapshot: {
    ...evidence.rendererFailureSnapshot,
    inputEvents: Array.from({ length: 200 }, () => ({ type: secret, target: { id: secret } })),
    dialogs: Array.from({ length: 9 }, () => ({ text: secret })),
  } });
  assert.ok('inputEvents' in overflow && overflow.inputEvents);
  assert.equal(overflow.inputEvents.count, 97); assert.equal(overflow.inputEvents.overflow, true);
  assert.equal(overflow.inputEvents.last.length, 8);
  assert.equal(overflow.dialogs.count, 4); assert.equal(overflow.dialogs.overflow, true);
  assert.equal(overflow.dialogs.items.length, 3);
  assert.equal(JSON.stringify(overflow).includes(secret), false);
  assert.ok(JSON.stringify(overflow).length <= 4096);
});

test('installer failure summaries preserve original wait sites and attempts without inferring installation effects', () => {
  const secret = 'TEST-private-code-token https://TEST-private.example /TEST-private/path';
  const evidence = { status: 'INCOMPLETE', failureSource: { kind: 'error', frames: [] },
    failure: 'UI read timed out: original installation and Host publication ready; no mutation retry',
    emulatedSelectionUiProof: { status: 'INCOMPLETE', a: { thread: secret },
      steps: [...Array.from({ length: 8 }, () => ({ action: secret, label: secret })),
        { action: 'mouseClick', label: 'install original Codex package exactly once', state: 'attempted',
          selector: secret, target: { text: secret } }],
      observations: [{ phase: 'before-original-installer-update', nativeReady: true,
        originalInputsUnchanged: true, binding: secret, sessionRef: secret, thread: secret }] },
    rendererFailureSnapshot: { dialogs: [{ text: 'Codex is ready for new launches. ' + secret,
      buttons: [{ text: secret }] }] },
  };
  const before = JSON.stringify(evidence), result = projectDesktopCodexInstallerFailure(evidence);
  assert.ok('failureSite' in result && result.failureSite && 'steps' in result && result.steps);
  assert.deepEqual(result.failureSite, { operation: 'read-timeout', stage: 'update-ready' });
  assert.equal(result.atomicWithFailure, false, 'the later retained renderer snapshot does not establish the timeout cause');
  assert.equal(result.steps.count, 9); assert.equal(result.steps.overflow, false); assert.equal(result.steps.last.length, 8);
  assert.deepEqual(result.steps.last.at(-1), { action: 'mouseClick', stage: 'update-submit', attempted: true });
  assert.deepEqual(result.lastLiveObservation, {
    phase: 'before-original-installer-update', nativeReady: true, originalInputsUnchanged: true,
  });
  assert.deepEqual(result.milestones, { firstRuntimeRecorded: true, savedSelectionRecorded: null,
    nextRuntimeRecorded: null, completedInstallerReceiptRecorded: null });
  assert.equal(result.completedInstallerStatus, null, 'missing completed receipt cannot mean Update never started');
  assert.equal(result.snapshot.readyText, true);
  assert.equal('installerStarted' in result, false);
  assert.doesNotMatch(JSON.stringify(result), /TEST-private|https:|\/TEST-private|binding|sessionRef|selector|thread/);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096);
  assert.equal(JSON.stringify(evidence), before, 'original observations and failure remain unchanged');
  const summary = projectDesktopProofReceiptSummary(evidence,
    { mode: 'emulated-installer-ui', receiptPath: 'TEST-receipt', mixedMode: false });
  assert.deepEqual(summary.installerFailure, result); assert.deepEqual(summary.failureSource, evidence.failureSource);
  assert.equal(summary.status, 'INCOMPLETE'); assert.equal(summary.receipt, 'TEST-receipt');
  for (const [mode, status] of [['emulated-installer-ui', 'PASS'], ['emulated-codex-runtime-ui', 'INCOMPLETE'],
    ['codex-login-ui', 'INCOMPLETE']] as const)
    assert.equal('installerFailure' in projectDesktopProofReceiptSummary({ ...evidence, status },
      { mode, receiptPath: 'TEST-receipt', mixedMode: false }), false);
  const completed = projectDesktopCodexInstallerFailure({ ...evidence, emulatedSelectionUiProof: {
    ...evidence.emulatedSelectionUiProof, installer: { status: 'PASS', initialStatus: secret, installed: secret } } });
  assert.ok('milestones' in completed && completed.milestones);
  assert.equal(completed.milestones.completedInstallerReceiptRecorded, true);
  assert.equal(completed.completedInstallerStatus, 'PASS');
  for (const [failure, operation, stage] of [
    ['UI scroll timed out: original Codex Update submit; no effect retry', 'scroll-timeout', 'update-submit'],
    ['UI target read failed: open original Codex Update dialog after pointer enter; facts=' + secret, 'target-read', 'update-notice'],
    ['UI read timed out: original installation and Host publication ready ' + secret + '; no mutation retry', null, null],
    [secret, null, null],
  ] as const) {
    const observed = projectDesktopCodexInstallerFailure({ failure });
    assert.ok('failureSite' in observed && observed.failureSite);
    assert.deepEqual(observed.failureSite, { operation, stage });
    assert.equal(JSON.stringify(observed).includes(secret), false);
  }
});

test('installer failure projection does not invoke input getters and leaves oversized observations unknown', () => {
  const secret = 'TEST-private-getter-token'; let reads = 0;
  const unreadable = () => { reads++; throw new Error(secret); };
  const row = Object.defineProperty({ action: 'mouseClick', state: 'attempted' }, 'label', { get: unreadable });
  const observed = Object.defineProperty({}, 'phase', { get: unreadable });
  const snapshot = { dialogs: [Object.defineProperty({}, 'text', { get: unreadable })] };
  const input = Object.defineProperty({ emulatedSelectionUiProof: { steps: [row], observations: [observed] },
    rendererFailureSnapshot: snapshot }, 'failure', { get: unreadable });
  const result = projectDesktopCodexInstallerFailure(input);
  assert.ok('steps' in result && result.steps);
  assert.deepEqual(result.failureSite, { operation: null, stage: null });
  assert.equal(result.steps.last[0]?.stage, null); assert.equal(result.lastLiveObservation.phase, null);
  assert.equal(result.snapshot.readyText, null);
  const missing = projectDesktopCodexInstallerFailure(Object.defineProperty({}, 'emulatedSelectionUiProof', { get: unreadable }));
  assert.ok('proofRecorded' in missing); assert.equal(missing.proofRecorded, null);
  assert.equal(reads, 0, 'getter values are not observations');
  const oversized = projectDesktopCodexInstallerFailure({
    failure: 'UI read timed out: original installation and Host publication ready; no mutation retry'.padEnd(4001, 'x'),
    emulatedSelectionUiProof: { steps: Array.from({ length: 1025 }, () => row),
      observations: Array.from({ length: 129 }, () => ({ phase: 'before-create' })) },
    rendererFailureSnapshot: { dialogs: Array.from({ length: 4 }, () => ({ text: 'Codex is ready for new launches.' })) },
  });
  assert.ok('steps' in oversized && oversized.steps);
  assert.deepEqual(oversized.steps, { count: null, overflow: true, last: [] });
  assert.deepEqual(oversized.failureSite, { operation: null, stage: null });
  assert.equal(oversized.lastLiveObservation.phase, null); assert.equal(oversized.snapshot.readyText, null);
  const longText = projectDesktopCodexInstallerFailure({ rendererFailureSnapshot: {
    dialogs: [{ text: ('Codex is ready for new launches. ' + secret).padEnd(8001, 'x') }] } });
  assert.ok('snapshot' in longText && longText.snapshot); assert.equal(longText.snapshot.readyText, null);
  assert.equal(reads, 0); assert.equal(JSON.stringify(oversized).includes(secret), false);
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) <= 4096);
});

test('installer CDP and cleanup projection retains only exact finite observations', () => {
  const secret = 'TEST-private-token https://TEST-private.example /TEST-private/path';
  const evidence = { status: 'INCOMPLETE', failure: 'CDP command timed out: Runtime.evaluate',
    emulatedSelectionUiProof: { steps: [
      { action: 'mouseClick', label: 'open original Settings menu after Update', state: 'attempted' },
      { action: 'mouseClick', label: 'expand original provider details after Update', state: 'attempted' }],
      installer: { status: 'PASS', settings: { status: 'PASS', finalStatus: secret } } },
    cleanup: { remaining: [{ pid: 123, argv: secret }], appExitCode: 0, appSignalCode: null,
      capturedHostObserved: true, capturedHostAbsent: false, cleanupFailure: secret },
    emulatedRuntimeCleanup: { absent: true, observationFailed: false, private: secret },
    quitRequested: true, failureQuit: { attempted: true, reply: 'unconfirmed', listenerAbsent: false, reason: secret } };
  const before = JSON.stringify(evidence), result = projectDesktopCodexInstallerFailure(evidence);
  assert.ok('cdpFailure' in result && 'cleanup' in result);
  assert.deepEqual(result.cdpFailure, { kind: 'command-timeout', method: 'Runtime.evaluate' });
  assert.deepEqual(result.failureSite, { operation: null, stage: null }, 'CDP classification does not invent a UI stage');
  assert.deepEqual(result.steps.last.map(row => row.stage), ['settings-menu', 'settings-details']);
  assert.deepEqual(result.settingsReceipt, { recorded: true, status: 'PASS' });
  assert.deepEqual(result.cleanup, { recorded: true, remainingCount: 1, capturedHostObserved: true,
    capturedHostAbsent: false, failureRecorded: true, appExitCodeZero: true, appSignalPresent: false,
    peerRecorded: true, peerAbsent: true, peerObservationFailed: false, quitRequested: true,
    failureQuit: { recorded: true, attempted: true, reply: 'unconfirmed', listenerAbsent: false } });
  assert.deepEqual(projectDesktopProofReceiptSummary(evidence, { mode: 'emulated-installer-ui',
    receiptPath: 'TEST-receipt', mixedMode: false }).installerFailure, result);
  assert.equal(JSON.stringify(evidence), before);
  assert.doesNotMatch(JSON.stringify(result), /TEST-private|https:|\/TEST-private|argv|pid/);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 4096);
  for (const [failure, kind, method] of [
    ['CDP connection closed', 'connection-closed', null], ['Renderer evaluation failed', 'evaluation-failed', null],
    ['CDP command timed out: Page.captureScreenshot', 'command-timeout', 'Page.captureScreenshot'],
    ['CDP command timed out: ' + secret, null, null], ['CDP connection closed ' + secret, null, null],
    ['CDP command timed out: Runtime.evaluate ' + secret, null, null], [secret, null, null],
  ] as const) {
    const observed = projectDesktopCodexInstallerFailure({ failure });
    assert.ok('cdpFailure' in observed);
    assert.deepEqual(observed.cdpFailure, { kind, method });
    assert.equal(observed.cleanup.recorded, null); assert.equal(observed.settingsReceipt.recorded, null);
    assert.equal(JSON.stringify(observed).includes(secret), false);
  }
  let reads = 0; const unreadable = () => { reads++; throw new Error(secret); };
  const guarded = Object.defineProperty({ ...evidence }, 'cleanup', { get: unreadable });
  Object.defineProperty(guarded, 'failureQuit', { get: unreadable });
  Object.defineProperty(guarded, 'emulatedRuntimeCleanup', { get: unreadable });
  const unknown = projectDesktopCodexInstallerFailure(guarded);
  assert.ok('cleanup' in unknown); assert.equal(unknown.cleanup.recorded, null);
  assert.equal(unknown.cleanup.failureQuit.recorded, null); assert.equal(unknown.cleanup.peerRecorded, null);
  for (const [cleanup, expected] of [[{}, false], [{ cleanupFailure: undefined }, false],
    [Object.defineProperty({}, 'cleanupFailure', { get: unreadable }), null]] as const) {
    const nested = projectDesktopCodexInstallerFailure({ cleanup });
    assert.ok('cleanup' in nested); assert.equal(nested.cleanup.failureRecorded, expected);
  }
  assert.equal(reads, 0); assert.equal(JSON.stringify(unknown).includes(secret), false);
});

test('Selection target summaries retain the exact original phase and six closed facts', () => {
  const facts = { matches: 1, disabled: false, ariaDisabled: true,
    pointerEventsNone: false, centerInViewport: true, hitPresent: false };
  for (const [suffix, phase] of [['', 'initial'], [' after pointer enter', 'after-pointer-enter'],
    [' stable target', 'stable-target']] as const) {
    const evidence = { status: 'INCOMPLETE', failureSource: { kind: 'error', frames: [] },
      failure: 'UI target read failed: select original save-only Create' + suffix + '; facts=' + JSON.stringify(facts) };
    const before = JSON.stringify(evidence), result = projectDesktopSelectionTargetFailure(evidence);
    assert.deepEqual(result, { schemaVersion: 1, status: 'available', source: 'retained-target-read-failure',
      atomicWithFailure: false, site: 'save-only-create', phase, facts });
    assert.ok('facts' in result); assert.notEqual(result.facts, facts);
    assert.equal(JSON.stringify(evidence), before);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 1024);
    assert.doesNotMatch(JSON.stringify(result), /select original|facts=|selector|cause/);
    for (const mode of ['emulated-selection-ui', 'emulated-installer-ui']) {
      const summary = projectDesktopProofReceiptSummary(evidence, { mode, receiptPath: 'TEST-receipt', mixedMode: false });
      assert.deepEqual(summary.selectionTargetFailure, result);
      assert.equal(summary.status, 'INCOMPLETE'); assert.equal(summary.receipt, 'TEST-receipt');
      assert.deepEqual(summary.failureSource, evidence.failureSource);
      assert.equal('selectionTargetFailure' in projectDesktopProofReceiptSummary({ ...evidence, status: 'PASS' },
        { mode, receiptPath: 'TEST-receipt', mixedMode: false }), false);
    }
    for (const mode of ['emulated-codex-runtime-ui', 'task-board-cross-team-ui', 'codex-login-ui'])
      assert.equal('selectionTargetFailure' in projectDesktopProofReceiptSummary(evidence,
        { mode, receiptPath: 'TEST-receipt', mixedMode: false }), false);
  }
  for (const matches of [0, 256]) {
    const selected = { matches, disabled: false, ariaDisabled: false,
      pointerEventsNone: false, centerInViewport: false, hitPresent: false };
    const result = projectDesktopSelectionTargetFailure({
      failure: 'UI target read failed: select original save-only Create; facts=' + JSON.stringify(selected) });
    assert.ok('facts' in result); assert.deepEqual(result.facts, selected, 'zero/default facts do not infer a cause');
  }
});

test('Selection target projection rejects unknown or malformed facts without exposing text or invoking getters', () => {
  const secret = 'TEST-private-token https://TEST-private.example /TEST-private/path';
  const facts = { matches: 1, disabled: false, ariaDisabled: false,
    pointerEventsNone: false, centerInViewport: true, hitPresent: true };
  const prefix = 'UI target read failed: select original save-only Create; facts=';
  const badFacts = [null, [], {}, { ...facts, matches: -1 }, { ...facts, matches: 257 },
    { ...facts, matches: 1.5 }, { ...facts, matches: '1' }, { ...facts, extra: secret },
    ...['disabled', 'ariaDisabled', 'pointerEventsNone', 'centerInViewport', 'hitPresent']
      .flatMap(key => [{ ...facts, [key]: undefined }, { ...facts, [key]: secret }])];
  const messages = [...badFacts.map(row => prefix + JSON.stringify(row)),
    prefix + '{', prefix + JSON.stringify(facts) + secret,
    prefix + JSON.stringify(facts).padEnd(1025, ' '),
    (prefix + JSON.stringify(facts)).padEnd(4001, ' '),
    'UI target read failed: ' + secret + '; facts=' + JSON.stringify(facts),
    'UI target read failed: select original save-only Create extra; facts=' + JSON.stringify(facts),
    'UI read timed out: select original save-only Create; no mutation retry', secret];
  for (const failure of messages) {
    const result = projectDesktopSelectionTargetFailure({ failure });
    assert.deepEqual(result, { schemaVersion: 1, status: 'unavailable', reason: 'unrecognized-target-facts' });
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 1024);
  }
  let reads = 0;
  const input = Object.defineProperty({}, 'failure', { get() { reads++; throw new Error(secret); } });
  for (const value of [input, null, [], {}, { failure: 1 }, Object.create({ failure: prefix + JSON.stringify(facts) })])
    assert.equal(projectDesktopSelectionTargetFailure(value).status, 'unavailable');
  assert.equal(reads, 0, 'accessors and inherited values are not retained observations');
});

test('Taskboard focus diagnostics preserve last samples and bounded transitions without exposing private input', () => {
  const secret = 'TEST-private-focus https://TEST-private.example/token /TEST-private/path';
  const stage = 'after one focus click';
  const inputProbe = { present: true, connected: true, disabled: false, focused: true,
    ownerSurfaceId: secret, expectedSurfaceId: secret, ownerRevision: 7, detailPhase: 'ready',
    refreshPending: false, contextSwitching: false, taskId: secret, activeContextId: secret };
  const owner = { selector: secret, commentText: '', submitPending: false, canSubmit: true,
    submitError: secret, attachmentError: null, pendingAttachmentCount: 0, pendingPreparationCount: 0 };
  const focus = { owner, inputProbe, settled: false, inputEnabled: true, focused: true,
    documentFocused: true, visibility: 'visible', domValue: '', activeElement: { id: secret }, timeMs: 123456 };
  const transitions = [
    { ownerPresent: false, inputProbe: { ...inputProbe, ownerRevision: null, focused: false } },
    { ownerPresent: true, inputProbe },
    { ownerPresent: true, inputProbe: { ...inputProbe, ownerRevision: 8 } },
  ];
  const evidenceFor = (observations: unknown) => ({ status: 'INCOMPLETE',
    taskBoardUiProof: { attachments: { commentInputObservations: observations } } });
  const evidence = evidenceFor({ [stage]: focus, [stage + ' transitions']: transitions });
  const before = JSON.stringify(evidence), result = projectDesktopTaskBoardFailure(evidence);
  assert.ok('commentInputFocus' in result && result.commentInputFocus);
  const projected = result.commentInputFocus;
  assert.equal(projected.source, 'retained-comment-input-observations');
  assert.equal(projected.sample, 'last-observed'); assert.equal(projected.atomicWithFailure, false);
  assert.equal(projected.settled, false); assert.equal(projected.focused, true);
  assert.equal(projected.transitions[2]?.inputProbe.focused, true);
  assert.equal('settled' in projected.transitions[2]!, false, 'transitions do not contain the complete live predicate');
  assert.equal(projected.domEmpty, true); assert.equal(projected.draftEmpty, true);
  assert.equal(projected.submitErrorClear, false); assert.equal(projected.attachmentErrorClear, true);
  assert.equal(projected.attachmentsEmpty, true); assert.equal(projected.preparationsEmpty, true);
  assert.equal(projected.inputProbe.ownerSurfaceMatchesExpected, true);
  assert.deepEqual(projected.transitions.map(row => row.ownerRevisionChangedFromPrevious), [null, null, true]);
  assert.equal(projected.captureMayBeCapped, false); assert.equal(projected.extraRetainedRowsOmitted, false);
  assert.equal(result.original.commentReceiptCompleted, false);
  assert.equal(result.selectedTeamMatchesOriginal, null, 'pre-submit observation does not invent a completed owner identity');
  for (const mode of ['task-board-ui', 'task-board-cross-team-ui']) {
    assert.deepEqual(projectDesktopProofReceiptSummary(evidence, { mode, receiptPath: 'TEST-receipt', mixedMode: false }).taskBoardFailure, result);
    assert.equal('taskBoardFailure' in projectDesktopProofReceiptSummary({ ...evidence, status: 'PASS' },
      { mode, receiptPath: 'TEST-receipt', mixedMode: false }), false);
  }
  assert.equal('taskBoardFailure' in projectDesktopProofReceiptSummary(evidence,
    { mode: 'emulated-import-ui', receiptPath: 'TEST-receipt', mixedMode: false }), false);
  assert.equal(JSON.stringify(evidence), before);
  for (const value of [secret, '123456', 'ownerRevision":', 'https://', '/TEST-private/path'])
    assert.equal(JSON.stringify(result).includes(value), false);
  assert.notEqual(projected.transitions, transitions);
  assert.notEqual(projected.transitions[1]?.inputProbe, inputProbe);

  let getterReads = 0;
  const unreadable = () => { getterReads++; throw new Error(secret); };
  const baseline = projectDesktopTaskBoardFailure(evidenceFor({}));
  for (const hidden of [Object.create({ [stage]: focus }), Object.defineProperty({}, stage, { get: unreadable })])
    assert.deepEqual(projectDesktopTaskBoardFailure(evidenceFor(hidden)), baseline);
  assert.equal('commentInputFocus' in baseline, false, 'absent own focus data preserves the original output shape');
  const guarded = projectDesktopTaskBoardFailure(evidenceFor({
    [stage]: Object.defineProperties({ ...focus }, {
      owner: { get: unreadable }, inputProbe: { get: unreadable }, domValue: { get: unreadable },
    }),
    [stage + ' transitions']: new Proxy([Object.defineProperty({}, 'inputProbe', { get: unreadable })], { get: unreadable }),
  }));
  assert.ok('commentInputFocus' in guarded && guarded.commentInputFocus);
  assert.equal(guarded.commentInputFocus.ownerPresent, null);
  assert.equal(guarded.commentInputFocus.domEmpty, null);
  assert.equal(guarded.commentInputFocus.submitErrorClear, null);
  assert.equal(guarded.commentInputFocus.inputProbe.focused, null);
  assert.equal(guarded.commentInputFocus.transitions[0]?.inputProbe.detailPhase, null);
  assert.equal(getterReads, 0);

  const history = Array.from({ length: 20 }, () => ({ ownerPresent: true,
    inputProbe: { ...inputProbe, detailPhase: secret, ownerSurfaceId: '', expectedSurfaceId: '', ownerRevision: -1 } }));
  const bounded = projectDesktopTaskBoardFailure({ ...evidenceFor({
    [stage]: { ...focus, domValue: secret, owner: { ...owner, commentText: secret,
      pendingAttachmentCount: -1, pendingPreparationCount: 0.5 }, inputProbe: { ...inputProbe, focused: 'true' } },
    [stage + ' transitions']: history,
  }), rendererFailureSnapshot: {
    inputEvents: Array.from({ length: 96 }, () => ({ type: 'pointerdown', trusted: false })),
    dialogs: [{ text: 'loading comments attachments' }, { text: 'unavailable' }, { text: 'deleted' }],
  } });
  assert.ok('commentInputFocus' in bounded && bounded.commentInputFocus);
  assert.equal(bounded.commentInputFocus.transitions.length, 12);
  assert.equal(bounded.commentInputFocus.captureMayBeCapped, true);
  assert.equal(bounded.commentInputFocus.extraRetainedRowsOmitted, true);
  assert.equal(bounded.commentInputFocus.transitions[0]?.inputProbe.detailPhase, null);
  assert.equal(bounded.commentInputFocus.transitions[0]?.inputProbe.ownerSurfaceMatchesExpected, null);
  assert.equal(bounded.commentInputFocus.transitions[1]?.ownerRevisionChangedFromPrevious, null);
  assert.equal(bounded.commentInputFocus.inputProbe.focused, null);
  assert.equal(bounded.commentInputFocus.domEmpty, false); assert.equal(bounded.commentInputFocus.draftEmpty, false);
  assert.equal(bounded.commentInputFocus.attachmentsEmpty, null); assert.equal(bounded.commentInputFocus.preparationsEmpty, null);
  assert.ok(JSON.stringify(bounded.commentInputFocus).length <= 4096);
  assert.ok(JSON.stringify(bounded).length > 4096 && JSON.stringify(bounded).length <= 8192);
  assert.equal(JSON.stringify(bounded).includes(secret), false);
});

for (const [change, replacement] of [
  ['unavailable', { unavailableTarget: true, matches: 1 }],
  ['moved', { x: 100, y: 200, tag: 'BUTTON' }],
  ['tag-changed', { x: 100, y: 200, tag: 'INPUT' }],
  ['nonfinite', { x: 100, y: Number.POSITIVE_INFINITY, tag: 'BUTTON' }],
] as const) {
  test(`original desktop click revalidates a target ${change} during the final ownership check`, { timeout: 5000 }, async t => {
    const expression = 'TEST_originalOwnerAndHitTestedTarget()';
    const expressions: string[] = [], dispatched: Record<string, unknown>[] = [];
    const output: string[] = [];
    t.mock.method(console, 'log', (value: unknown) => { output.push(String(value)); });
    let changed = false, guardChanges = 0;
    const ui = createDesktopUiControls({
      async evaluate(actual: string) {
        expressions.push(actual);
        return changed ? replacement : { x: 100, y: 100, tag: 'BUTTON' };
      },
      async send(method: string, params: Record<string, unknown> = {}) {
        if (method === 'Input.dispatchMouseEvent') dispatched.push({ ...params });
        return {};
      },
    }, { assertOwnedRenderer() {
      // Initial point, pointer-enter point, and both original equal stable samples.
      if (!changed && expressions.length === 4) { changed = true; guardChanges++; }
    }, step() {} });
    if (change === 'moved') await ui.clickExpression(expression, 'TEST original final target');
    else await assert.rejects(
      ui.clickExpression(expression, 'TEST original final target'),
      new RegExp(`Original UI target ${change === 'unavailable' ? 'unavailable' : 'moved'} after ownership check`)
    );
    assert.equal(guardChanges, 1, 'the original final ownership guard changes the target once');
    assert.deepEqual(expressions, Array.from({ length: change === 'moved' ? 8 : 5 }, () => expression),
      'only coordinate motion receives two fresh stable reads and another complete final lookup');
    assert.deepEqual(dispatched, change === 'moved' ? [
      { type: 'mouseMoved', x: 100, y: 100 },
      { type: 'mousePressed', x: 100, y: 200, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 100, y: 200, button: 'left', clickCount: 1 },
    ] : [{ type: 'mouseMoved', x: 100, y: 100 }],
    'one hover and at most one press/release, only at the fully revalidated point');
    assert.equal(output.length, change === 'moved' ? 0 : 1);
  });
}

for (const requireCenterHit of [false, true]) {
  test(requireCenterHit
    ? 'original scroll opt-in reveals a covered checkbox with one bounded wheel'
    : 'original default scroll preserves a disabled control before its readiness wait', { timeout: 5000 }, async () => {
    const selector = '#TEST-original-checkbox', child = {}, cover = {};
    const expressions: string[] = [], selectors: string[] = [];
    const hits: { x: number; y: number }[] = [], dispatched: Record<string, unknown>[] = [];
    let revealed = false;
    const scroller = { parentElement: null, scrollHeight: 1200, clientHeight: 600,
      getBoundingClientRect: () => ({ x: 0, top: 80, bottom: 680, width: 900 }) };
    const control = { parentElement: scroller, disabled: !requireCenterHit,
      contains: (node: unknown) => node === child,
      getBoundingClientRect() {
        const top = revealed ? 372 : 96;
        return { x: 90, y: top, top, bottom: top + 16, width: 16, height: 16 };
      } };
    const ui = createDesktopUiControls({
      async evaluate(expression: string) {
        expressions.push(expression);
        return runInNewContext(expression, {
          innerWidth: 1000, innerHeight: 720,
          getComputedStyle: (node: unknown) => ({ overflowY: node === scroller ? 'auto' : 'visible',
            pointerEvents: node === control && control.disabled ? 'none' : 'auto' }),
          document: { documentElement: scroller,
            querySelectorAll(actual: string) { selectors.push(actual); return [control]; },
            elementFromPoint(x: number, y: number) {
              hits.push({ x, y }); return requireCenterHit && revealed ? child : cover;
            } },
        });
      },
      async send(method: string, params: Record<string, unknown> = {}) {
        dispatched.push({ method, ...params });
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseWheel') revealed = true;
        return {};
      },
    }, { assertOwnedRenderer() {}, step() {} });
    if (requireCenterHit) {
      // The old four-argument helper ignores this option; its premature return is the RED.
      await Reflect.apply(ui.scrollTo, undefined, [selector, 'TEST original covered checkbox',
        undefined, 12, { requireCenterHit: true }]);
    } else await ui.scrollTo(selector, 'TEST original disabled control');
    assert.deepEqual(selectors, Array.from({ length: requireCenterHit ? 2 : 1 }, () => selector));
    assert.ok(expressions.every(expression => expression === expressions[0]),
      'each original loop read executes the same actual helper expression');
    assert.deepEqual(hits, requireCenterHit ? [{ x: 98, y: 104 }, { x: 98, y: 380 }] : [],
      'only the opt-in tests the original target center, including its descendant');
    assert.deepEqual(dispatched, requireCenterHit ? [{ method: 'Input.dispatchMouseEvent',
      type: 'mouseWheel', x: 450, y: 380, deltaX: 0, deltaY: -276 }] : [],
      'only the existing centering wheel is used; no checkbox click or default-control input');
  });
}

for (const [position, initialTop, firstDelta] of [['below', 800, 600], ['above', -800, -600]] as const) {
  test(`original scroll reveals an offscreen inner scroller (${position}) before scrolling its clipped target`, { timeout: 5000 }, async () => {
    const selector = '#TEST-original-nested-model';
    const selectors: string[] = [], visibility: unknown[] = [];
    const dispatched: Record<string, unknown>[] = [];
    let wheels = 0;
    const outer = { parentElement: null, scrollHeight: 1600, clientHeight: 681,
      getBoundingClientRect: () => ({ x: 0, top: 0, bottom: 681, width: 1024 }) };
    const inner = { parentElement: outer, scrollHeight: 1200, clientHeight: 380,
      getBoundingClientRect() {
        const top = wheels === 0 ? initialTop : 100;
        return { x: 300, top, bottom: top + 380, width: 600 };
      } };
    const control = { parentElement: inner, contains: () => false,
      getBoundingClientRect() {
        const top = wheels === 0 ? 936 : wheels === 1 ? 500 : 200;
        return { x: 320, y: top, top, bottom: top + 58, width: 300, height: 58 };
      } };
    const ui = createDesktopUiControls({
      async evaluate(expression: string) {
        const value = runInNewContext(expression, {
          innerWidth: 1024, innerHeight: 681,
          getComputedStyle: () => ({ overflowY: 'auto' }),
          document: { documentElement: outer,
            querySelectorAll(actual: string) { selectors.push(actual); return [control]; } },
        }) as Record<string, unknown> | null;
        assert.ok(value, 'the actual expression must find a visible wheel surface for the offscreen inner clip');
        visibility.push(value.visible);
        return value;
      },
      async send(method: string, params: Record<string, unknown> = {}) {
        assert.equal(method, 'Input.dispatchMouseEvent');
        assert.equal(params.type, 'mouseWheel', 'revealing the target performs no click, key or selection input');
        dispatched.push({ method, ...params });
        assert.ok(wheels < 2, 'the two original nested surfaces need only two wheels');
        wheels++;
        return {};
      },
    }, { assertOwnedRenderer() {}, step() {} });
    await ui.scrollTo(selector, 'TEST original nested model');
    assert.deepEqual(selectors, [selector, selector, selector]);
    assert.deepEqual(visibility, [false, false, true],
      'the target stays clipped after the outer wheel and becomes visible only after the inner wheel');
    assert.deepEqual(dispatched, [
      { method: 'Input.dispatchMouseEvent', type: 'mouseWheel', x: 512, y: 340.5, deltaX: 0, deltaY: firstDelta },
      { method: 'Input.dispatchMouseEvent', type: 'mouseWheel', x: 600, y: 290, deltaX: 0, deltaY: 239 },
    ], 'dispatch first to the visible outer dialog, then to the revealed inner model grid');
  });
}

for (const [change, moved] of [['owner', false], ['cutoff', false], ['owner', true], ['cutoff', true]] as const) {
  test(`original desktop click rechecks ${change} after its pending final target read (moved=${moved})`, { timeout: 5000 }, async t => {
    if (change === 'cutoff') t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const originalCutoff = 1001, refusal = new Error('TEST original ' + change + ' no longer current');
    const point = { x: 100, y: 100, tag: 'BUTTON' }, started = deferred<void>(), release = deferred<typeof point>();
    const dispatched: Record<string, unknown>[] = [], steps: Record<string, unknown>[] = [];
    const expression = 'TEST_originalOwnerAndHitTestedTarget()';
    let active = true, reads = 0;
    const ui = createDesktopUiControls({
      async evaluate(actual: string) {
        assert.equal(actual, expression);
        reads++;
        if (reads === 5) { started.resolve(); return release.promise; }
        return point;
      },
      async send(method: string, params: Record<string, unknown> = {}) {
        if (method === 'Input.dispatchMouseEvent') dispatched.push({ ...params });
        return {};
      },
    }, { assertOwnedRenderer() {
      if (!active || change === 'cutoff' && Date.now() >= originalCutoff) throw refusal;
    }, step(value) { steps.push(value); } });
    const pending = ui.clickExpression(expression, 'TEST original pending final target');
    try {
      await started.promise;
      assert.deepEqual(dispatched, [{ type: 'mouseMoved', x: 100, y: 100 }]);
      if (change === 'owner') active = false;
      else t.mock.timers.setTime(originalCutoff);
      release.resolve(moved ? { ...point, y: 200 } : point);
      await assert.rejects(pending, error => {
        assert.equal(error, refusal, 'the exact original authority refusal remains authoritative');
        return true;
      });
      assert.equal(reads, 5, 'no extra target read, polling, or retargeting after the original refusal');
      assert.deepEqual(dispatched, [{ type: 'mouseMoved', x: 100, y: 100 }],
        'no press or release after the original scope or cutoff changes');
      assert.equal(steps.some(step => step.action === 'mouseClick'), false);
    } finally {
      release.resolve(point);
      await pending.catch(() => undefined);
      if (change === 'cutoff') t.mock.timers.reset();
    }
  });
}

test('original desktop click preserves a final transport rejection without more reads or input', { timeout: 5000 }, async () => {
  const expression = 'TEST_originalFinalTransportTarget()', refusal = new Error('TEST original final CDP failure');
  const commands: Record<string, unknown>[] = [];
  let reads = 0;
  const ui = createDesktopUiControls({
    async evaluate(actual: string) {
      assert.equal(actual, expression);
      reads++;
      if (reads === 5) throw refusal;
      return { x: 100, y: 100, tag: 'BUTTON' };
    },
    async send(method: string, params: Record<string, unknown> = {}) {
      commands.push({ method, ...params }); return {};
    },
  }, { assertOwnedRenderer() {}, step() {} });
  await assert.rejects(ui.clickExpression(expression, 'TEST original final transport target'), error => {
    assert.equal(error, refusal, 'the exact original transport failure remains authoritative');
    return true;
  });
  assert.equal(reads, 5, 'a failed final read cannot start another observation');
  assert.deepEqual(commands, [{ method: 'Page.bringToFront' },
    { method: 'Input.dispatchMouseEvent', type: 'mouseMoved', x: 100, y: 100 }]);
});

test('original clarification lookup admits its retained read without completing the assignment prerequisite', async () => {
  for (const stage of [undefined, 'in-progress-comment'] as const) {
    const original = assignmentRuntime(stage);
    if (stage === 'in-progress-comment') {
      original.detail.full.status = 'in_progress';
      original.triggers.length = 0;
    }
    original.detail.loading = true;
    assert.equal(await original.evaluate(), null, 'original assignment/comment readiness still requires a settled read');
  }
  const current = assignmentRuntime('clarification');
  current.detail.loading = true;
  const retained = await current.evaluate();
  assert.equal(retained?.surfaceId, 'TEST-original-surface');
  assert.equal(retained?.ownerRevision, 1);
  assert.equal(retained?.canResolveClarification, true);
  assert.equal(current.detail.loading, true, 'the observer does not complete or replace the retained product read');
  current.detail.loading = false;
  assert.equal((await current.evaluate())?.surfaceId, 'TEST-original-surface');
  assert.deepEqual([...new Set(current.imports)],
    ['/store/slices/teamSlice.ts', '/store/team/taskDetailReadAuthority.ts']);
});

test('original clarification lookup refuses changed owner, revision, refresh and retained-read joins', async () => {
  const changes: [string, (value: ReturnType<typeof assignmentRuntime>) => void][] = [
    ['owner', f => { f.controller.isOwner = false; }],
    ['fresh owner authority', f => { f.controller.canEditNow = () => false; }],
    ['stored owner revision', f => { f.storedSession.ownerRevision++; }],
    ['stored owner surface', f => { f.storedSession.ownerSurfaceId = 'TEST-other-surface'; }],
    ['context', f => { f.state.activeContextId = 'TEST-other-context'; }],
    ['Task identity', f => { f.detail.identity.taskId = 'TEST-other-task'; }],
    ['assignment', f => { f.detail.full.owner = 'bob'; }],
    ['metadata refresh', f => { f.work.refreshPending = true; }],
    ['live metadata', f => { f.work.teamUnavailable = true; }],
    ['detail refresh', f => { f.detail.refreshPending = true; }],
    ['rendered resolve admission', f => { f.controller.canResolveClarification = false; }],
    ['read failure', f => { Reflect.set(f.detail, 'error', 'TEST failed read'); }],
    ['deletion intent', f => { Reflect.set(f.detail, 'deletionIntent', 'deleting'); }],
    ['deleted Task', f => { Reflect.set(f.detail.full, 'deletedAt', 'TEST-deleted'); }],
    ['changed clarification', f => { f.detail.full.needsClarification = 'lead'; }],
    ['missing read token', f => { Reflect.deleteProperty(f.detail, 'fullToken'); }],
    ['foreign resource', f => { f.detail.fullToken.resource = 'snapshot'; }],
    ['foreign Task resource', f => { f.detail.fullToken.key = 'full:TEST-other-task'; }],
    ['context epoch', f => { f.detail.fullToken.scope.contextEpoch++; }],
    ['Team epoch', f => { f.detail.fullToken.scope.teamStateEpoch++; }],
    ['foreign token context', f => { f.detail.fullToken.scope.contextId = 'TEST-other-context'; }],
    ['foreign token Team', f => { f.detail.fullToken.scope.teamName = 'host-team:TEST-other'; }],
  ];
  for (const [label, change] of changes) {
    const current = assignmentRuntime('clarification');
    current.detail.loading = true;
    assert.equal((await current.evaluate())?.surfaceId, 'TEST-original-surface', label);
    change(current);
    assert.equal(await current.evaluate(), null, label + ': no reuse of the earlier eligible observation');
  }
});

type OwnerAvailabilityRow = Record<string, unknown>;

function originalOwnerAvailability(teamCount = 3) {
  const ownerA = 'a'.repeat(64), ownerB = 'b'.repeat(64);
  const handles = ['TEST-original-a', 'TEST-cross/alpha', 'TEST-cross beta'].slice(0, teamCount);
  const names = ['host-team:TEST-original-a', 'host-team:TEST-cross%2Falpha', 'host-team:TEST-cross%20beta'].slice(0, teamCount);
  const aBindings = handles.map((handleId, index) => ({ handle: { handleId },
    ownerResourceRef: ownerA, teamResourceRef: 'TEST-a-resource-' + index, label: 'TEST A ' + index }));
  const aPublic = aBindings[0]!, bPublic = { handle: { handleId: 'TEST-healthy-b' },
    ownerResourceRef: ownerB, teamResourceRef: 'TEST-b-resource', label: 'TEST B' };
  const b = 'host-team:TEST-healthy-b', contextId = 'TEST-original-context';
  const ownerRow = { kind: 'owner', ownerResourceRef: ownerA, code: 'unavailable', outcome: 'unknown' };
  const unavailable: OwnerAvailabilityRow[] = [{ ...ownerRow }, ...names.map(teamName => ({
    kind: 'team', teamName, code: 'unavailable', outcome: 'not-dispatched' }))];
  const healthy: OwnerAvailabilityRow = { teamName: b, ownerResourceRef: ownerB };
  const state = { activeContextId: contextId, teamsLoading: false, teamsError: null,
    teams: [healthy], teamsUnavailable: unavailable };
  const discovery = { state: 'ready', bindings: [...aBindings, bPublic], unavailableOwners: [{ ...ownerRow }] };
  const task = { id: 'TEST-original-b-task', subject: 'TEST original B Task', status: 'pending' };
  const bTask = { handle: bPublic.handle, task, receipt: { phase: 'completed',
    command: { operation: 'task.create', payload: { subject: task.subject } },
    effects: { taskId: task.id }, result: { id: task.id } } };
  const controls = { active: true, invalidateAfterRead: false, targets: 1, notices: 1,
    visible: true, loadedLabel: true, unknownCount: true, refresh: true };
  const noticeOverrides: Record<string, string> = {}, actions: string[] = [], reads: string[] = [];
  const screenshotBoundary = new Error('TEST original first availability screenshot boundary');
  const evidence: OwnerAvailabilityRow = {};
  let screenshots = 0;
  const notice = {
    getBoundingClientRect: () => ({ width: controls.visible ? 320 : 0, height: 40, top: 20, bottom: 60 }),
    hasAttribute: () => true,
    getAttribute(name: string) {
      const attributes: Record<string, string> = { 'data-state': 'partial',
        'data-team-count': String(unavailable.filter(entry => entry.kind === 'team').length),
        'data-owner-count': String(unavailable.filter(entry => entry.kind === 'owner').length),
        'data-loaded-count': String(state.teams.length) };
      return noticeOverrides[name] ?? attributes[name];
    },
    get textContent() { return controls.unknownCount ? 'Team count unknown' : 'TEST known count'; },
    querySelectorAll(selector: string) {
      if (selector === '*') return controls.loadedLabel ? [{ textContent: state.teams.length + ' loaded' }] : [];
      assert.equal(selector, 'button');
      return [{ textContent: 'Refresh', disabled: !controls.refresh }];
    },
  };
  const unused = async () => { throw new Error('TEST unexpected availability operation'); };
  const ui = {
    observeInput: unused, clickExpression: unused, clickSidebar: unused, hoverExpression: unused,
    async click(_selector: string, label: string) { actions.push(label); },
    async scrollTo(_selector: string, label: string) { actions.push(label); },
    async waitRead(expression: string, label: string, timeoutMs = 30_000) {
      assert.equal(label, 'original teams partial availability');
      assert.ok(timeoutMs > 0 && timeoutMs <= 30_000);
      reads.push(expression);
      const value = structuredClone(runInNewContext(expression, {
        innerHeight: 1000, window: { __agentTeamsDevStore: { getState: () => state } },
        document: { querySelectorAll(selector: string) {
          if (selector === '[data-team-aggregate-notice="teams"]') return Array.from({ length: controls.notices }, () => notice);
          assert.equal(selector, '[data-team-name="' + b + '"]');
          return Array.from({ length: controls.targets }, () => ({}));
        } },
      }));
      if (controls.invalidateAfterRead) controls.active = false;
      return value;
    },
  };
  const cdp = {
    on() { throw new Error('TEST unexpected availability subscription'); },
    evaluate: unused, close: unused,
    async send(method: string) {
      assert.equal(method, 'Page.captureScreenshot');
      screenshots++;
      throw screenshotBoundary;
    },
  };
  const run = () => assertDesktopOwnerRoutingAvailability({ cdp, ui, evidence,
    root: 'TEST-no-screenshot-write', deadline: Date.now() + 2000,
    assertCurrent() { assert.ok(controls.active, 'TEST original owner epoch remains current'); },
    contextId, discovery, aPublic, bPublic, bTask, openTeam: unused });
  return { run, discovery, aPublic, bPublic, unavailable, healthy, controls, state, noticeOverrides,
    evidence, actions, reads, screenshotBoundary, screenshots: () => screenshots };
}

test('original owner availability admits three captured A Teams through its actual first DOM read', { timeout: 5000 }, async () => {
  const f = originalOwnerAvailability();
  const captured = structuredClone(f.discovery);
  await assert.rejects(f.run(), error => {
    assert.equal(error, f.screenshotBoundary, 'all original aggregate assertions precede the retained screenshot boundary');
    return true;
  });
  assert.deepEqual(f.discovery, captured, 'the already captured discovery is read without mutation');
  assert.equal(f.reads.length, 1, 'the actual retained DOM expression is evaluated once');
  assert.equal(f.screenshots(), 1);
  assert.deepEqual(f.actions, ['open original availability menu', 'open original available Teams list', 'original healthy B Team']);
  assert.equal((f.evidence.availability as OwnerAvailabilityRow).status, 'INCOMPLETE');
  assert.deepEqual((f.evidence.availability as OwnerAvailabilityRow).observations, [],
    'the finite boundary test does not manufacture a PNG or a complete UI proof');
});

test('original owner availability retains singleton, subset and duplicate-row cardinality semantics', { timeout: 5000 }, async () => {
  for (const variant of ['singleton', 'subset', 'duplicate'] as const) {
    const f = originalOwnerAvailability(variant === 'singleton' ? 1 : 3);
    if (variant !== 'singleton') f.unavailable.splice(2);
    if (variant === 'duplicate') f.unavailable.push({ ...f.unavailable[1]! });
    await assert.rejects(f.run(), error => {
      assert.equal(error, f.screenshotBoundary, variant + ': no new completeness or uniqueness oracle');
      return true;
    });
    assert.equal(f.reads.length, 1, variant);
    assert.equal(f.screenshots(), 1, variant);
  }
});

test('original owner availability refuses foreign identities and preserves its existing aggregate guards', { timeout: 5000 }, async () => {
  const changes: [string, (f: ReturnType<typeof originalOwnerAvailability>) => void][] = [
    ['healthy B as unavailable A', f => { f.unavailable[1]!.teamName = 'host-team:TEST-healthy-b'; }],
    ['unregistered A-shaped key', f => { f.unavailable[1]!.teamName = 'host-team:TEST-unregistered-a'; }],
    ['noncanonical key', f => { f.unavailable[2]!.teamName = 'host-team:TEST-cross/alpha'; }],
    ['boxed key', f => { f.unavailable[1]!.teamName = Object('host-team:TEST-original-a'); }],
    ['null key', f => { f.unavailable[1]!.teamName = null; }],
    ['uncaptured key', f => { f.discovery.bindings.splice(1, 1); }],
    ['uncaptured original A', f => { f.discovery.bindings.splice(0, 1); }],
    ['non-string captured handle', f => { Reflect.set(f.discovery.bindings[1]!.handle, 'handleId', Object('TEST-cross/alpha')); }],
    ['foreign binding owner', f => { f.discovery.bindings[1]!.ownerResourceRef = f.bPublic.ownerResourceRef; }],
    ['foreign unavailable owner', f => { f.unavailable[0]!.ownerResourceRef = f.bPublic.ownerResourceRef; }],
    ['missing unavailable owner', f => { f.unavailable.shift(); }],
    ['duplicate unavailable owner', f => { f.unavailable.push({ ...f.unavailable[0]! }); }],
    ['unknown row kind', f => { f.unavailable[1]!.kind = 'TEST-other-kind'; }],
    ['unknown refusal code', f => { f.unavailable[1]!.code = 'TEST-other-code'; }],
    ['unknown dispatch outcome', f => { f.unavailable[1]!.outcome = 'completed'; }],
    ['original sixteen-row bound', f => { while (f.unavailable.length < 17) f.unavailable.push({ ...f.unavailable[1]! }); }],
    ['healthy B owner', f => { f.healthy.ownerResourceRef = f.aPublic.ownerResourceRef; }],
    ['missing healthy B', f => { f.state.teams.splice(0); }],
    ['duplicate healthy B', f => { f.state.teams.push({ ...f.healthy }); }],
    ['visible B target count', f => { f.controls.targets = 2; }],
    ['notice count', f => { f.controls.notices = 2; }],
    ['notice team count', f => { f.noticeOverrides['data-team-count'] = '99'; }],
    ['notice owner count', f => { f.noticeOverrides['data-owner-count'] = '0'; }],
    ['notice loaded count', f => { f.noticeOverrides['data-loaded-count'] = '0'; }],
    ['notice visibility', f => { f.controls.visible = false; }],
    ['loaded label', f => { f.controls.loadedLabel = false; }],
    ['unknown-count label', f => { f.controls.unknownCount = false; }],
    ['Refresh admission', f => { f.controls.refresh = false; }],
    ['context', f => { f.state.activeContextId = 'TEST-other-context'; }],
    ['original post-read epoch', f => { f.controls.invalidateAfterRead = true; }],
  ];
  for (const [label, change] of changes) {
    const f = originalOwnerAvailability();
    change(f);
    await assert.rejects(f.run(), error => {
      assert.ok(error instanceof Error, label);
      assert.notEqual(error, f.screenshotBoundary, label);
      assert.equal((error as { code?: string }).code, 'ERR_ASSERTION', label);
      return true;
    });
    assert.equal(f.screenshots(), 0, label + ': no proof screenshot after refusal');
  }
});


test('original owner availability refuses invalid captured discovery before navigation', { timeout: 5000 }, async () => {
  for (const variant of ['empty A handle', 'duplicate A handle', 'over-bound capture'] as const) {
    const f = originalOwnerAvailability();
    if (variant === 'empty A handle') f.discovery.bindings[1]!.handle.handleId = '';
    if (variant === 'duplicate A handle') f.discovery.bindings.push(f.discovery.bindings[1]!);
    if (variant === 'over-bound capture') while (f.discovery.bindings.length <= 16) {
      f.discovery.bindings.push({ ...f.bPublic, handle: { handleId: 'TEST-extra-' + f.discovery.bindings.length } });
    }
    await assert.rejects(f.run(), variant === 'empty A handle' ? /Invalid Host team/ : assert.AssertionError);
    assert.deepEqual(f.actions, [], variant);
    assert.deepEqual(f.reads, [], variant);
    assert.equal(f.screenshots(), 0, variant);
  }
});

const ownerAvailabilityPrefix = [
  'open original availability menu', 'open original available Teams list', 'original healthy B Team',
];

function ownerAvailabilityFixture() {
  const ownerA = 'a'.repeat(64), ownerB = 'b'.repeat(64), ownerForeign = 'c'.repeat(64);
  const aPublic = { handle: { handleId: 'TEST-original-A' }, ownerResourceRef: ownerA };
  const bPublic = { handle: { handleId: 'TEST-healthy-B' }, ownerResourceRef: ownerB };
  const bindings: Record<string, unknown>[] = [aPublic,
    { handle: { handleId: 'TEST-cross-handle-0' }, ownerResourceRef: ownerA },
    { handle: { handleId: 'TEST-cross-handle-1' }, ownerResourceRef: ownerA }, bPublic,
    { handle: { handleId: 'TEST-foreign' }, ownerResourceRef: ownerForeign }];
  const unavailableOwner = { kind: 'owner', ownerResourceRef: ownerA,
    code: 'unavailable', outcome: 'not-dispatched' };
  const unavailable: Record<string, unknown>[] = [unavailableOwner,
    ...['TEST-original-A', 'TEST-cross-handle-0', 'TEST-cross-handle-1'].map(handleId => ({
      kind: 'team', teamName: hostTeamSelectionKey(handleId), displayName: handleId,
      code: 'unavailable', outcome: 'not-dispatched',
    }))];
  const observed = { contextId: 'TEST-context', loaded: 1, unavailable, targets: 1,
    healthy: { teamName: hostTeamSelectionKey(bPublic.handle.handleId), ownerResourceRef: ownerB },
    notice: { state: 'partial', teams: 3, owners: 1, loaded: 1, visible: true,
      loadedLabel: true, unknownCount: true, refresh: true } };
  const steps: string[] = [], checkpoint = new Error('TEST first availability screenshot checkpoint');
  let screenshots = 0;
  const task = { id: 'TEST-task', subject: 'TEST healthy B Task', status: 'pending' };
  type Options = Parameters<typeof assertDesktopOwnerRoutingAvailability>[0];
  const options: Options = {
    cdp: {
      on() { assert.fail('unexpected availability CDP listener'); },
      async send(method: string) {
        assert.equal(method, 'Page.captureScreenshot'); screenshots++; throw checkpoint;
      },
      async evaluate() { assert.fail('unexpected availability CDP evaluation'); },
      async close() { assert.fail('unexpected availability CDP close'); },
    },
    ui: {
      async click(_selector: string, label: string) { steps.push(label); },
      async scrollTo(_selector: string, label: string) { steps.push(label); },
      async waitRead(_expression: string, label: string) {
        assert.equal(label, 'original teams partial availability'); return observed;
      },
    } as Options['ui'],
    evidence: {}, root: '/TEST-owner-availability', deadline: Date.now() + 5000,
    assertCurrent() {}, contextId: observed.contextId, aPublic, bPublic,
    discovery: { state: 'ready', bindings, unavailableOwners: [unavailableOwner] },
    bTask: { handle: bPublic.handle, task,
      receipt: { phase: 'completed', command: { operation: 'task.create', payload: { subject: task.subject } },
        effects: { taskId: task.id }, result: { id: task.id } } },
    async openTeam() { assert.fail('first observation must finish before further original navigation'); },
  };
  return { options, observed, bindings, steps, checkpoint, screenshots: () => screenshots };
}

test('owner availability admits every captured A Team through the actual first observation', async () => {
  const f = ownerAvailabilityFixture();
  await assert.rejects(assertDesktopOwnerRoutingAvailability(f.options), error => {
    assert.equal(error, f.checkpoint, 'all original identity, owner, notice and healthy B checks pass before the screenshot');
    return true;
  });
  assert.equal(f.screenshots(), 1);
  assert.deepEqual(f.steps, ownerAvailabilityPrefix);
  assert.equal((f.options.evidence.availability as Record<string, unknown>).status, 'INCOMPLETE',
    'the deliberate checkpoint does not qualify later actions or cleanup');
});

for (const [label, teamName] of [
  ['healthy B', hostTeamSelectionKey('TEST-healthy-B')],
  ['captured foreign owner', hostTeamSelectionKey('TEST-foreign')],
  ['unknown Team', hostTeamSelectionKey('TEST-unknown')],
  ['malformed Team', 123],
] as const) {
  test('owner availability refuses ' + label + ' in unavailable A rows', async () => {
    const f = ownerAvailabilityFixture();
    f.observed.unavailable[2]!.teamName = teamName;
    await assert.rejects(assertDesktopOwnerRoutingAvailability(f.options), assert.AssertionError);
    assert.equal(f.screenshots(), 0);
    assert.deepEqual(f.steps, ownerAvailabilityPrefix);
  });
}

for (const label of ['missing selected A', 'non-string A handle', 'empty A handle', 'duplicate A handle', 'over-bound capture'] as const) {
  test('owner availability refuses ' + label + ' before original navigation', async () => {
    const f = ownerAvailabilityFixture();
    if (label === 'missing selected A') f.bindings.shift();
    if (label === 'non-string A handle') f.bindings[1]!.handle = { handleId: 123 };
    if (label === 'empty A handle') f.bindings[1]!.handle = { handleId: '' };
    if (label === 'duplicate A handle') f.bindings.push(f.bindings[1]!);
    if (label === 'over-bound capture') while (f.bindings.length <= 16) f.bindings.push({
      handle: { handleId: 'TEST-extra-' + f.bindings.length }, ownerResourceRef: 'c'.repeat(64),
    });
    await assert.rejects(assertDesktopOwnerRoutingAvailability(f.options),
      label === 'empty A handle' ? /Invalid Host team/ : assert.AssertionError);
    assert.equal(f.screenshots(), 0);
    assert.deepEqual(f.steps, []);
  });
}

async function selectionStoppedConvergence(options: {
  modes?: string[]; tables?: boolean[]; guardMs?: number[]; readMs?: number[]; bindingMismatch?: boolean;
} = {}) {
  const { stripTypeScriptTypes } = await import('node:module');
  const { hostTeamRunId } = await import('../../src/features/agent-backend/contracts/teamRunSelection.ts');
  const { desktopJsLiteral: literal } = await import('./desktop-ui-controls.ts');
  const source = (await readFile(new URL('./desktop-emulated-selection-ui.ts', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  const pollBegin = '  const poll = async <T>(', pollEnd = '  const visible = (text: string) =>';
  const stopBegin = '  const stop = async (', stopEnd = '\n\n  await ui.observeInput();';
  for (const marker of [pollBegin, pollEnd, stopBegin, stopEnd]) assert.equal(source.split(marker).length, 2);
  assert.ok(source.includes('proof.bStop = await stop(liveB);'));
  assert.ok(source.includes('proof.aStop = await stop(liveA, true); proof.stoppedScreenshot = await screenshot(\'stopped\');'));
  const actual = stripTypeScriptTypes(source.slice(source.indexOf(pollBegin), source.indexOf(pollEnd)) +
    source.slice(source.indexOf(stopBegin), source.indexOf(stopEnd)));
  const makeStop = Function('environment', `'use strict';
    const {assert,effects,ui,cdp,options,processTable,literal,hostTeamSelectionKey,hostTeamRunId,Date,setTimeout}=environment;
    ${actual}
    return stop;`) as (environment: Record<string, unknown>) => (live: unknown, observeStoppedUi?: boolean) => Promise<unknown>;
  const key = hostTeamSelectionKey('TEST-selection-owner'), runId = hostTeamRunId('TEST-selection-owner', 'TEST-launch', 'TEST-roster');
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-launch', memberId: 'TEST-lead', generation: 'TEST-generation' };
  const trace: string[] = [], delays: number[] = [], budgets: number[] = [], values: boolean[] = [];
  const failure = new Error('TEST original stopped observation refusal');
  let now = 0, reads = 0, guards = 0, tables = 0, sessions = 0, storeReads = 0;
  const box = (visible = true) => ({ visible, getBoundingClientRect: () => ({ width: 100, height: 30 }) });
  const live = { handleId: 'TEST-selection-owner', definition: { launchId: 'TEST-launch', rosterRevision: 'TEST-roster' },
    initial: { binding }, thread: { pid: 104 }, async session() {
      sessions++; trace.push('session');
      return { phase: 'closed', custody: 'released', binding: options.bindingMismatch ? { ...binding, generation: 'TEST-other' } : { ...binding } };
    } };
  const stop = makeStop({ assert, literal, hostTeamSelectionKey, hostTeamRunId,
    Date: { now: () => now }, setTimeout(done: () => void, delay: number) {
      assert.equal(delay, 100); delays.push(delay); now += delay; done();
    },
    effects: async () => { trace.push('effects'); return []; },
    ui: { async scrollTo(selector: string, label: string) {
      assert.equal(selector, 'button[aria-label="Stop"]'); assert.equal(label, 'original Team Stop'); trace.push('scroll');
    }, async click(selector: string, label: string, text: string) {
      assert.equal(selector, 'button[aria-label="Stop"]'); assert.equal(label, 'stop original selected Team once');
      assert.equal(text, 'Stop'); trace.push('click');
    } },
    options: { assertOwnedRenderer() { trace.push('guard'); const index = guards++; now += options.guardMs?.[index] ?? 0; } },
    processTable() { trace.push('process'); const index = tables++; return options.tables?.[index] ? [{ pid: 104 }] : []; },
    cdp: { async evaluate(expression: string, timeoutMs: number) {
      trace.push('evaluate'); budgets.push(timeoutMs); const index = reads++, mode = options.modes?.[index];
      if (mode === undefined) throw failure;
      const changed = hostTeamRunId('TEST-selection-owner', 'TEST-launch', 'TEST-other-roster');
      const observedRun = mode === 'other-revision' ? changed : runId;
      const state = { selectedTeamName: mode === 'other-owner' ? hostTeamSelectionKey('TEST-other-owner') : key,
        currentProvisioningRunIdByTeam: { [key]: mode === 'provisioning-pin' ? changed : observedRun },
        currentRuntimeRunIdByTeam: { [key]: mode === 'runtime-pin' ? changed : observedRun },
        provisioningRuns: mode === 'missing-progress' ? {} : { [observedRun]: {
          teamName: mode === 'progress-owner' ? hostTeamSelectionKey('TEST-other-owner') : key,
          runId: mode === 'progress-run' ? changed : observedRun,
          state: mode === 'ready' || mode === 'dismissed-ready' ? 'ready' : mode === 'cancelled' ? 'cancelled' : 'disconnected',
        } } };
      const launch = { ...box(mode !== 'hidden-launch'), textContent: 'Launch', disabled: mode === 'disabled-launch' };
      const wrapper = { tagName: mode === 'wrong-wrapper' ? 'SECTION' : 'DIV',
        childElementCount: mode === 'ready' || mode === 'render-pending' ? 1 : 0 };
      const banner = { ...box(), nextElementSibling: wrapper, querySelectorAll(selector: string) {
        if (selector === 'button') return mode === 'missing-launch' ? [] : [launch];
        assert.equal(selector, ':scope > span'); return [{ textContent: mode === 'wrong-status' ? 'TEST unknown' : 'Team is offline' }];
      } };
      const team = { ...box(mode !== 'hidden-team'), getAttribute(name: string) {
        assert.equal(name, 'data-team-name'); return mode === 'dom-owner' ? hostTeamSelectionKey('TEST-other-owner') : key;
      }, querySelector(selector: string) { assert.equal(selector, '[data-section-id="team"]'); return {}; },
      querySelectorAll(selector: string) { assert.equal(selector, ':scope > [role="status"]'); return mode === 'duplicate-status' ? [banner, banner] : [banner]; } };
      const value = runInNewContext(expression, {
        window: { __agentTeamsDevStore: { getState() { storeReads++; return state; } } },
        document: { querySelectorAll(selector: string) {
          assert.equal(selector, '[data-team-name]'); return mode === 'duplicate-team' ? [team, team] : [team];
        } }, getComputedStyle: (element: { visible: boolean }) => ({ visibility: element.visible ? 'visible' : 'hidden' }),
      });
      assert.equal(typeof value, 'boolean'); values.push(value); now += options.readMs?.[index] ?? 0; return value;
    } },
  });
  return { run: (observeStoppedUi = false) => stop(live, observeStoppedUi), binding, trace, delays, budgets, values, failure,
    counts: () => ({ sessions, tables, guards, reads, storeReads, now }) };
}

test('original Selection final Stop joins physical absence with its exact stopped UI within the same poll budget', async () => {
  const f = await selectionStoppedConvergence({ tables: [true, false, false, false],
    modes: ['ready', 'render-pending', 'stopped'], guardMs: [60_000] });
  assert.deepEqual(await f.run(true), { binding: f.binding, phase: 'closed', custody: 'released', originalPid: 104, absent: true });
  assert.deepEqual(f.values, [false, false, true], 'accepted stopped progress and its rendered completion are both required');
  assert.deepEqual(f.budgets, [14_900, 14_800, 14_700], 'new CDP reads consume the original second poll deadline');
  assert.deepEqual(f.delays, [100, 100, 100]);
  assert.deepEqual(f.counts(), { sessions: 1, tables: 4, guards: 3, reads: 3, storeReads: 3, now: 60_300 });
  assert.deepEqual(f.trace, ['scroll', 'click', 'effects', 'session', 'effects', 'process',
    'effects', 'process', 'guard', 'evaluate', 'effects', 'process', 'guard', 'evaluate', 'effects', 'process', 'guard', 'evaluate']);
  const b = await selectionStoppedConvergence({ tables: [true, false] });
  assert.deepEqual(await b.run(), { binding: b.binding, phase: 'closed', custody: 'released', originalPid: 104, absent: true });
  assert.deepEqual(b.budgets, []); assert.deepEqual(b.delays, [100]);
  assert.deepEqual(b.trace, ['scroll', 'click', 'effects', 'session', 'effects', 'process', 'effects', 'process']);
});

test('Selection stopped convergence refuses wrong identity, unaccepted progress, visible progress and exhausted observation budget', async () => {
  for (const mode of ['other-owner', 'other-revision', 'provisioning-pin', 'runtime-pin', 'missing-progress', 'progress-owner',
    'progress-run', 'cancelled', 'ready', 'dismissed-ready', 'render-pending', 'dom-owner', 'hidden-team', 'duplicate-team',
    'duplicate-status', 'wrong-status', 'missing-launch', 'disabled-launch', 'hidden-launch', 'wrong-wrapper']) {
    const f = await selectionStoppedConvergence({ modes: [mode] });
    await assert.rejects(f.run(true), error => error === f.failure);
    assert.deepEqual(f.values, [false], mode); assert.deepEqual(f.delays, [100], mode);
    assert.equal(f.trace.filter(value => value === 'click').length, 1, mode);
    assert.deepEqual(f.budgets, [30_000, 30_000], mode);
  }
  const expired = await selectionStoppedConvergence({ modes: ['stopped'], guardMs: [75_000] });
  await assert.rejects(expired.run(true), /original stopped UI observation.*original action is never repeated/);
  assert.deepEqual(expired.budgets, []); assert.deepEqual(expired.delays, []);
  const late = await selectionStoppedConvergence({ modes: ['stopped'], guardMs: [60_000], readMs: [15_000] });
  await assert.rejects(late.run(true), /original stopped UI observation.*original action is never repeated/);
  assert.deepEqual(late.values, [true]); assert.deepEqual(late.budgets, [15_000]); assert.deepEqual(late.delays, []);
  const mismatch = await selectionStoppedConvergence({ modes: ['stopped'], bindingMismatch: true });
  await assert.rejects(mismatch.run(true), { code: 'ERR_ASSERTION' });
  assert.deepEqual(mismatch.values, [true], 'the original exact stopped binding assertion remains after the UI read');
});


test('the existing passive click recorder distinguishes the actual Team from later navigation without new actions', async () => {
  const teamA = 'host-team:TEST-A', teamB = 'host-team:TEST-B';
  type NavigationState = { selectedTeamName: string | null; activeTabId: string; openTabs: unknown[] };
  const state = (selectedTeamName: string | null, activeTabId = 'list'): NavigationState => ({
    selectedTeamName, activeTabId,
    openTabs: [{ id: 'list', type: 'teams' }, { id: 'a', type: 'team', teamName: teamA },
      { id: 'b', type: 'team', teamName: teamB }],
  });
  const setup = async () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const microtasks: Array<() => void> = [], timers: Array<() => void> = [];
    let current = state(teamA), failRead = false, failTarget = false;
    const calls = { send: 0, evaluate: 0, stateReads: 0, microtasks: 0, timers: 0, business: 0 };
    class Target {
      tagName = 'DIV'; id = ''; className = 'TEST-card-body';
      readonly team: string | null;
      constructor(team: string | null) { this.team = team; }
      getAttribute(name: string) { return name === 'data-team-name' ? this.team : null; }
      closest(selector: string) {
        if (selector === '[data-team-name]') {
          if (failTarget) throw new Error('PRIVATE-target');
          return this.team === null ? null : this;
        }
        assert.ok(['button', '[role="dialog"]', '.kanban-task-card'].includes(selector));
        return null;
      }
    }
    const passiveWindow: Record<string, unknown> = {
      __agentTeamsDevStore: { getState: () => {
        calls.stateReads++;
        if (failRead) throw new Error('PRIVATE-store');
        return current;
      } },
    };
    const document = {
      activeElement: new Target(null),
      querySelectorAll(selector: string) {
        assert.ok(['[aria-roledescription="sortable"][aria-pressed="true"]', '[id^="DndLiveRegion-"]'].includes(selector));
        return [];
      },
      addEventListener(type: string, listener: (event: Record<string, unknown>) => void,
        options: { capture: boolean; passive: boolean }) {
        assert.equal(options.capture, true); assert.equal(options.passive, true);
        assert.equal(listeners.has(type), false); listeners.set(type, listener);
      },
    };
    const cdp = {
      async send(method: string, params?: Record<string, unknown>) {
        calls.send++;
        assert.equal(method, 'Emulation.setFocusEmulationEnabled'); assert.deepEqual(params, { enabled: true });
      },
      async evaluate(expression: string) {
        calls.evaluate++;
        if (expression === 'document.visibilityState') return 'visible';
        assert.equal(calls.evaluate, 1, 'execute only the actual existing observer installation');
        return runInNewContext(expression, {
          window: passiveWindow, document, Element: Target, TextEncoder,
          performance: { now: () => 17 },
          queueMicrotask: (callback: () => void) => { calls.microtasks++; microtasks.push(callback); },
          setTimeout: (callback: () => void, delay: number) => {
            assert.equal(delay, 0); calls.timers++; timers.push(callback);
          },
        });
      },
    };
    await createDesktopUiControls(cdp, {
      assertOwnedRenderer: () => assert.fail('observer does not add an ownership call'),
      step: () => assert.fail('passive observer does not dispatch an action'),
    }).observeInput();
    assert.equal(listeners.size, 9); assert.equal(calls.send, 1); assert.equal(calls.evaluate, 2);
    const rows = (name = '__TEST_desktopInputEvents') => passiveWindow[name] as Array<Record<string, unknown>>;
    const fire = (team: string | null, type = 'click', trusted = true) => {
      const blocked = () => { calls.business++; assert.fail('observer cannot change or redispatch input'); };
      listeners.get(type)!({ type, target: new Target(team), isTrusted: trusted, clientX: 191, clientY: 228,
        button: 0, buttons: type === 'pointermove' ? 1 : 0, defaultPrevented: false,
        preventDefault: blocked, stopPropagation: blocked, stopImmediatePropagation: blocked, dispatchEvent: blocked });
      return rows(type === 'pointermove' ? '__TEST_desktopDragEvents' : undefined).at(-1)!;
    };
    return { calls, rows, fire, update: (next: NavigationState) => { current = next; },
      failRead: () => { failRead = true; }, failTarget: () => { failTarget = true; },
      microtask: () => { assert.equal(microtasks.length, 1); microtasks.shift()!(); },
      dispatch: () => { assert.equal(timers.length, 1); timers.shift()!(); },
    };
  };
  const normalized = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  for (const actualTarget of [teamA, teamB]) {
    const f = await setup(), row = f.fire(actualTarget);
    // The original physical step retains intended B separately; this observer records actual A or B.
    assert.ok(row.teamNavigation, 'the original passive click must retain its actual Team ancestor');
    assert.deepEqual(normalized(row.teamNavigation), { targetTeamKey: actualTarget,
      before: { selectedTeamKey: teamA, activeSurface: 'teams', activeTeamKey: null } });
    f.update(state(actualTarget, actualTarget === teamA ? 'a' : 'b')); f.microtask();
    f.update(state(teamA, 'a')); f.dispatch();
    const navigation = normalized(row.teamNavigation);
    assert.deepEqual(navigation.afterMicrotask, { selectedTeamKey: actualTarget, activeSurface: 'team', activeTeamKey: actualTarget });
    assert.deepEqual(navigation.afterDispatch, { selectedTeamKey: teamA, activeSurface: 'team', activeTeamKey: teamA });
    assert.equal(navigation.targetTeamKey, actualTarget, 'a later selected Team cannot rewrite the actual clicked ancestor');
    assert.deepEqual(f.calls, { send: 1, evaluate: 2, stateReads: 3, microtasks: 1, timers: 1, business: 0 });
  }
  for (const mode of ['read-throws', 'duplicate-tab', 'too-many-tabs', 'bad-selected', 'bad-target', 'target-throws', 'untrusted', 'no-card', 'utf8-cap']) {
    const f = await setup();
    let target: string | null = teamB;
    if (mode === 'read-throws') f.failRead();
    if (mode === 'target-throws') f.failTarget();
    if (mode === 'duplicate-tab') f.update({ ...state(teamA), openTabs: [{ id: 'list', type: 'teams' }, { id: 'list', type: 'teams' }] });
    if (mode === 'too-many-tabs') f.update({ ...state(teamA), openTabs: Array.from({ length: 65 }, () => ({ id: 'list', type: 'teams' })) });
    if (mode === 'bad-selected') f.update(state('PRIVATE-selected'));
    if (mode === 'bad-target') target = 'host-team:' + 'x'.repeat(247);
    if (mode === 'no-card') target = null;
    if (mode === 'utf8-cap') {
      target = 'host-team:' + '文'.repeat(246);
      f.update({ selectedTeamName: target, activeTabId: 'a', openTabs: [{ id: 'a', type: 'team', teamName: target }] });
    }
    const row = f.fire(target, 'click', mode !== 'untrusted'); f.microtask(); f.dispatch();
    if (['read-throws', 'duplicate-tab', 'too-many-tabs', 'bad-selected'].includes(mode))
      assert.deepEqual(normalized(row.teamNavigation), { targetTeamKey: teamB, before: null, afterMicrotask: null, afterDispatch: null });
    else assert.equal(row.teamNavigation, null);
    assert.equal(JSON.stringify(row).includes('PRIVATE-'), false);
    assert.ok(Buffer.byteLength(JSON.stringify(row.teamNavigation), 'utf8') <= 4096);
    assert.equal(f.calls.send, 1); assert.equal(f.calls.evaluate, 2); assert.equal(f.calls.microtasks, 1);
    assert.equal(f.calls.timers, 1); assert.equal(f.calls.business, 0);
  }
  const bounded = await setup();
  for (let i = 0; i < 100; i++) { bounded.fire(null); bounded.microtask(); bounded.dispatch(); }
  for (let i = 0; i < 35; i++) { bounded.fire(null, 'pointermove'); bounded.microtask(); bounded.dispatch(); }
  assert.equal(bounded.rows().length, 96); assert.equal(bounded.rows('__TEST_desktopDragEvents').length, 32);
  assert.deepEqual(bounded.calls, { send: 1, evaluate: 2, stateReads: 0, microtasks: 135, timers: 135, business: 0 });
});


async function originalLiveMembershipPoll() {
  const { stripTypeScriptTypes } = await import('node:module');
  const source = (await readFile(new URL('./desktop-live-membership-ui-smoke.ts', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  const begin = '  const poll = async <T>(', end = "  const workspace = join(fixture.root, 'workspace');";
  for (const marker of [begin, end]) assert.equal(source.split(marker).length, 2, 'one original P11 poll boundary');
  const actual = stripTypeScriptTypes(source.slice(source.indexOf(begin), source.indexOf(end)));
  const makePoll = Function('environment', `'use strict';
    const {assert,current,Date,setTimeout}=environment;
    ${actual}
    return poll;`) as (environment: Record<string, unknown>) =>
      (observe: () => Promise<boolean>, accepts: (value: boolean) => boolean, label: string) => Promise<boolean>;
  return (observations: { at: number; value?: boolean; error?: Error }[], guardError?: Error) => {
    let now = 0, reads = 0;
    const trace: string[] = [], delays: number[] = [];
    const poll = makePoll({ assert, Date: { now: () => now },
      current() { trace.push('guard'); if (guardError) throw guardError; },
      setTimeout(done: () => void, delay: number) {
        assert.equal(delay, 100); delays.push(delay); now += delay; done();
      },
    });
    return { trace, delays, reads: () => reads,
      run: (label: string) => poll(async () => {
        const observation = observations[reads++]; assert.ok(observation, 'no unplanned observation');
        trace.push('read'); assert.ok(observation.at >= now); now = observation.at;
        if (observation.error) throw observation.error;
        assert.equal(typeof observation.value, 'boolean'); return observation.value!;
      }, value => value, label),
    };
  };
}

for (const scenario of [
  { name: 'first result at the exact cutoff', values: [{ at: 90_000, value: true }], reads: 1, trace: ['read'], delays: [] },
  { name: 'first result after the cutoff', values: [{ at: 90_001, value: true }], reads: 1, trace: ['read'], delays: [] },
  { name: 'polled result after the cutoff', values: [{ at: 0, value: false }, { at: 90_001, value: true }], reads: 2,
    trace: ['read', 'guard', 'read'], delays: [100] },
]) test('P11 keeps the original 90-second cutoff for ' + scenario.name, async () => {
  const make = await originalLiveMembershipPoll(), f = make(scenario.values), label = 'TEST original P11 deadline';
  await assert.rejects(f.run(label), error => error instanceof assert.AssertionError && error.message.includes(label));
  assert.equal(f.reads(), scenario.reads); assert.deepEqual(f.trace, scenario.trace); assert.deepEqual(f.delays, scenario.delays);
});

test('P11 actual poll retains timely acceptance, original cadence, currentness and read-error identity', async () => {
  const make = await originalLiveMembershipPoll(), label = 'TEST original P11 observation';
  const immediate = make([{ at: 89_999, value: true }]);
  assert.equal(await immediate.run(label), true); assert.equal(immediate.reads(), 1);
  assert.deepEqual(immediate.trace, ['read']); assert.deepEqual(immediate.delays, []);
  const later = make([{ at: 0, value: false }, { at: 101, value: true }]);
  assert.equal(await later.run(label), true); assert.equal(later.reads(), 2);
  assert.deepEqual(later.trace, ['read', 'guard', 'read']); assert.deepEqual(later.delays, [100]);
  const refusal = new Error('TEST original observation failure'), failed = make([{ at: 90_001, error: refusal }]);
  await assert.rejects(failed.run(label), error => error === refusal);
  assert.equal(failed.reads(), 1); assert.deepEqual(failed.trace, ['read']); assert.deepEqual(failed.delays, []);
  const stale = new Error('TEST original currentness failure'), guarded = make([{ at: 0, value: false }], stale);
  await assert.rejects(guarded.run(label), error => error === stale);
  assert.equal(guarded.reads(), 1); assert.deepEqual(guarded.trace, ['read', 'guard']); assert.deepEqual(guarded.delays, []);
  const noReady = make([{ at: 90_000, value: false }]);
  await assert.rejects(noReady.run(label), assert.AssertionError);
  assert.equal(noReady.reads(), 1); assert.deepEqual(noReady.trace, ['read']); assert.deepEqual(noReady.delays, []);
});

test('repeated final click movement exhausts the original shared observations without a press', { timeout: 5000 }, async t => {
  const expression = 'TEST_originalGeometryTarget()', label = 'TEST original geometry target';
  const positions = [100, 100, 100, 100, 101, 102, 102, 102, 103, 103, 103, 104, 104, 104, 105, 105, 105, 106];
  const expressions: string[] = [], commands: Record<string, unknown>[] = [];
  const steps: Record<string, unknown>[] = [], output: string[] = [];
  t.mock.method(console, 'log', (value: unknown) => { output.push(String(value)); });
  const ui = createDesktopUiControls({
    async evaluate(actual: string) {
      expressions.push(actual);
      assert.ok(expressions.length <= positions.length, 'the original observation allowance is never replenished');
      return { x: positions[expressions.length - 1], y: 100, tag: 'BUTTON',
        text: 'TEST-private-original-target', geometry: {
          targetRect: [90, 90, 20, 20], dialogRect: [20, 30, 400, 300],
          targetAnimations: 1, dialogAnimations: 0, fonts: 'loaded',
        } };
    },
    async send(method: string, params: Record<string, unknown> = {}) {
      commands.push({ method, ...params }); return {};
    },
  }, { assertOwnedRenderer() {}, step(value) { steps.push(value); } });
  await assert.rejects(ui.clickExpression(expression, label),
    /Original UI target moved after ownership check/);
  assert.deepEqual(expressions, Array.from({ length: 18 }, () => expression));
  assert.deepEqual(commands, [{ method: 'Page.bringToFront' },
    { method: 'Input.dispatchMouseEvent', type: 'mouseMoved', x: 100, y: 100 }]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.action, 'mouseMoved');
  const trace = steps[0]!.geometryTrace as { samples: Record<string, unknown>[]; overflow: boolean };
  assert.deepEqual(trace.samples.map(row => row.phase), ['initial', 'after-hover', 'stable', 'stable', 'final',
    'stable', 'stable', 'stable', 'final', 'stable', 'stable', 'final', 'stable', 'stable', 'final',
    'stable', 'stable', 'final']);
  assert.equal(trace.overflow, false);
  assert.deepEqual(trace.samples.map(row => row.x), positions);
  for (const row of trace.samples) {
    assert.deepEqual(Object.keys(row).sort(), ['dialogAnimations', 'dialogRect', 'fonts', 'phase',
      'tag', 'targetAnimations', 'targetRect', 'unavailable', 'x', 'y']);
    assert.deepEqual(row.targetRect, [90, 90, 20, 20]);
    assert.deepEqual(row.dialogRect, [20, 30, 400, 300]);
    assert.equal(row.targetAnimations, 1); assert.equal(row.dialogAnimations, 0);
    assert.equal(row.fonts, 'loaded');
  }
  assert.equal(output.length, 1);
  assert.ok(Buffer.byteLength(output[0]!, 'utf8') <= 8192);
  assert.deepEqual(JSON.parse(output[0]!) as unknown, { kind: 'TEST_DESKTOP_CLICK_GEOMETRY', geometry: trace });
  assert.equal(output[0]!.includes('TEST-private'), false);
});

test('geometry metadata getters cannot replace the original unavailable-target refusal when stdout throws', { timeout: 5000 }, async t => {
  const secret = 'TEST-private-geometry-value', stdoutFailure = new Error('TEST-geometry-stdout-failure');
  const expression = 'TEST_originalGeometryAccessors()', expressions: string[] = [];
  const commands: Record<string, unknown>[] = [], steps: Record<string, unknown>[] = [], output: string[] = [];
  const descriptors: { fonts: number; rectangle: number[] }[] = [];
  let diagnosticGetterReads = 0, businessTagReads = 0;
  t.mock.method(console, 'log', (value: unknown) => { output.push(String(value)); throw stdoutFailure; });
  const ui = createDesktopUiControls({
    async evaluate(actual: string) {
      expressions.push(actual);
      if (expressions.length === 5) return {
        unavailableTarget: true, matches: 1,
        get geometry() { diagnosticGetterReads++; throw new Error(secret); },
        get tag() { diagnosticGetterReads++; throw new Error(secret); },
      };
      const reads = { fonts: 0, rectangle: [0, 0, 0, 0] };
      descriptors.push(reads);
      const targetRect = Object.defineProperty([90, 90, 20, 20], '0', {
        get() { diagnosticGetterReads++; throw new Error(secret); },
      });
      const dialogRect = new Proxy([20, 30, 400, 300], {
        getOwnPropertyDescriptor(target, key) {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
          if (typeof key === 'string' && /^[0-3]$/.test(key) && descriptor) {
            const index = Number(key);
            reads.rectangle[index] = reads.rectangle[index]! + 1;
            return { ...descriptor, value: reads.rectangle[index] === 1 ? descriptor.value : secret };
          }
          return descriptor;
        },
      });
      const geometry = new Proxy({
        targetRect, dialogRect,
        get targetAnimations() { diagnosticGetterReads++; throw new Error(secret); },
        dialogAnimations: 1, fonts: 'loaded',
      }, {
        getOwnPropertyDescriptor(target, key) {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
          if (key === 'fonts' && descriptor) {
            reads.fonts++;
            return { ...descriptor, value: reads.fonts === 1 ? 'loaded' : secret };
          }
          return descriptor;
        },
      });
      return { x: 100, y: 100, text: secret, geometry,
        get tag() { businessTagReads++; return businessTagReads <= 4 ? 'BUTTON' : secret; } };
    },
    async send(method: string, params: Record<string, unknown> = {}) {
      commands.push({ method, ...params }); return {};
    },
  }, { assertOwnedRenderer() {}, step(value) { steps.push(value); } });
  await assert.rejects(ui.clickExpression(expression, 'TEST original unavailable geometry'), error => {
    assert.ok(error instanceof Error);
    assert.notEqual(error, stdoutFailure);
    assert.equal(error.name, 'AssertionError');
    assert.match(error.message, /^Original UI target unavailable after ownership check/);
    return true;
  });
  assert.deepEqual(expressions, Array.from({ length: 5 }, () => expression));
  assert.deepEqual(commands, [{ method: 'Page.bringToFront' },
    { method: 'Input.dispatchMouseEvent', type: 'mouseMoved', x: 100, y: 100 }]);
  assert.equal(diagnosticGetterReads, 0);
  assert.equal(businessTagReads, 4, 'only the two original stable comparisons read the business tag');
  assert.deepEqual(descriptors, Array.from({ length: 4 }, () => ({ fonts: 1, rectangle: [1, 1, 1, 1] })));
  const trace = steps[0]!.geometryTrace as { samples: Record<string, unknown>[]; overflow: boolean };
  assert.equal(steps.length, 1); assert.equal(trace.samples.length, 5); assert.equal(trace.overflow, false);
  for (const row of trace.samples.slice(0, 4)) {
    assert.equal(row.tag, null); assert.equal(row.targetRect, null); assert.equal(row.targetAnimations, null);
    assert.deepEqual(row.dialogRect, [20, 30, 400, 300]); assert.equal(row.fonts, 'loaded');
  }
  assert.equal(trace.samples[4]!.unavailable, true);
  assert.equal(trace.samples[4]!.tag, null); assert.equal(trace.samples[4]!.targetRect, null);
  assert.equal(output.length, 1);
  assert.ok(Buffer.byteLength(output[0]!, 'utf8') <= 8192);
  assert.deepEqual(JSON.parse(output[0]!) as unknown, { kind: 'TEST_DESKTOP_CLICK_GEOMETRY', geometry: trace });
  assert.equal(output[0]!.includes(secret), false);
  assert.equal(JSON.stringify(trace).includes(secret), false);
});

test('the actual generated target expression keeps the same eligible click when optional geometry APIs fail', { timeout: 5000 }, async t => {
  const output: string[] = [];
  t.mock.method(console, 'log', (value: unknown) => { output.push(String(value)); });
  for (const failOptionalGeometry of [false, true]) {
    const selector = '#TEST-original-geometry-control', visibleText = 'TEST-private-visible-target';
    const expressions: string[] = [], selectors: string[] = [];
    const hits: { x: number; y: number }[] = [], commands: Record<string, unknown>[] = [];
    const steps: Record<string, unknown>[] = [], animationArguments: unknown[][] = [];
    let targetRectReads = 0, dialogRectReads = 0, fontReads = 0;
    const child = {};
    const dialog = {
      getBoundingClientRect() { dialogRectReads++; return { x: 10, y: 20, width: 300, height: 200 }; },
      getAnimations(...args: unknown[]) {
        animationArguments.push(args); return [{ playState: 'running', pending: false }];
      },
    };
    const control = {
      textContent: visibleText, tagName: 'BUTTON',
      getBoundingClientRect() { targetRectReads++; return { x: 20, y: 40, width: 100, height: 30 }; },
      contains: (value: unknown) => value === child,
      matches(actual: string) { assert.equal(actual, ':disabled'); return false; },
      closest(actual: string) { assert.equal(actual, '[role="dialog"]'); return dialog; },
      getAnimations(...args: unknown[]) {
        animationArguments.push(args);
        return [{ playState: 'running', pending: false }, { playState: 'finished', pending: false },
          { playState: 'paused', pending: true }];
      },
    };
    const ui = createDesktopUiControls({
      async evaluate(expression: string) {
        expressions.push(expression);
        return runInNewContext(expression, {
          innerWidth: 1000, innerHeight: 720,
          getComputedStyle: () => ({ pointerEvents: 'auto' }),
          document: {
            querySelectorAll(actual: string) { selectors.push(actual); return [control]; },
            elementFromPoint(x: number, y: number) { hits.push({ x, y }); return child; },
            fonts: { get status() {
              fontReads++;
              if (failOptionalGeometry) throw new Error('TEST-private-optional-font-error');
              return 'loaded';
            } },
          },
        });
      },
      async send(method: string, params: Record<string, unknown> = {}) {
        commands.push({ method, ...params }); return {};
      },
    }, { assertOwnedRenderer() {}, step(value) { steps.push(value); } });
    await ui.click(selector, 'TEST original generated target', visibleText);
    assert.equal(expressions.length, 5);
    assert.ok(expressions.every(expression => expression === expressions[0]));
    assert.deepEqual(selectors, Array.from({ length: 5 }, () => selector));
    assert.deepEqual(hits, Array.from({ length: 5 }, () => ({ x: 70, y: 55 })));
    assert.equal(targetRectReads, 10, 'the original eligibility and center reads remain unchanged');
    assert.equal(dialogRectReads, failOptionalGeometry ? 0 : 5); assert.equal(fontReads, 5);
    assert.deepEqual(animationArguments, Array.from({ length: failOptionalGeometry ? 0 : 10 }, () => []),
      'optional animation observations query each original element without a descendant option');
    assert.deepEqual(commands, [{ method: 'Page.bringToFront' },
      { method: 'Input.dispatchMouseEvent', type: 'mouseMoved', x: 70, y: 55 },
      { method: 'Input.dispatchMouseEvent', type: 'mousePressed', x: 70, y: 55, button: 'left', clickCount: 1 },
      { method: 'Input.dispatchMouseEvent', type: 'mouseReleased', x: 70, y: 55, button: 'left', clickCount: 1 }]);
    assert.deepEqual(steps.map(step => step.action), ['mouseMoved', 'mouseClick']);
    const trace = steps[0]!.geometryTrace as { samples: Record<string, unknown>[]; overflow: boolean };
    assert.deepEqual(trace.samples.map(row => row.phase), ['initial', 'after-hover', 'stable', 'stable', 'final']);
    for (const row of trace.samples) {
      assert.equal(row.x, 70); assert.equal(row.y, 55); assert.equal(row.tag, 'BUTTON');
      assert.deepEqual(row.targetRect, failOptionalGeometry ? null : [20, 40, 100, 30]);
      assert.deepEqual(row.dialogRect, failOptionalGeometry ? null : [10, 20, 300, 200]);
      assert.equal(row.targetAnimations, failOptionalGeometry ? null : 2);
      assert.equal(row.dialogAnimations, failOptionalGeometry ? null : 1);
      assert.equal(row.fonts, failOptionalGeometry ? null : 'loaded');
    }
    assert.equal(JSON.stringify(trace).includes('TEST-private'), false);
  }
  assert.deepEqual(output, [], 'a successful original click does not emit a failure diagnostic');
});

async function originalReviewCorrectionStage(observations: unknown[], insertFailure?: Error) {
  const { stripTypeScriptTypes } = await import('node:module');
  const source = (await readFile(new URL('./desktop-task-review-cycle-ui-smoke.ts', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  const begin = '  const commentTarget = record(', end = "  await snapshotStage(await newReceipt(commentBefore, 'task.comment'), 'in_progress');";
  for (const marker of [begin, end]) assert.equal(source.split(marker).length, 2, 'one original correction input boundary');
  const actual = stripTypeScriptTypes(source.slice(source.indexOf(begin), source.indexOf(end)));
  const selector = '[role="dialog"] textarea[id="TEST-original-correction-input"]';
  const original = { selector, canEditNow: true }, trace: string[] = [], budgets: number[] = [];
  let reads = 0;
  const cdp = {
    async evaluate(expression: string) {
      assert.equal(expression, 'TEST-original-current-correction-expression');
      assert.ok(reads < observations.length, 'no unplanned currentness observation');
      const value = observations[reads++]; trace.push('read');
      if (value instanceof Error) throw value;
      return value === 'current' ? original : value && typeof value === 'object' && !Array.isArray(value)
        ? { selector, ...value } : value;
    },
    async send(method: string, params?: Record<string, unknown>) {
      assert.equal(method, 'Input.insertText');
      assert.deepEqual(params, { text: 'TEST original correction text' });
      trace.push('insert');
      if (insertFailure) throw insertFailure;
      return {};
    },
  };
  const controls = createDesktopUiControls(cdp, { assertOwnedRenderer() {}, step() {} });
  const ui = {
    ...controls,
    waitRead: ((expression: string, label: string, timeoutMs = 30_000, accepts?: (value: unknown) => boolean) => {
      assert.equal(label, 'exact current correction Task/owner/surface');
      budgets.push(timeoutMs);
      return controls.waitRead(expression, label, timeoutMs, accepts);
    }) as typeof controls.waitRead,
    async scrollTo(target: string, label: string) {
      assert.equal(target, selector); assert.equal(label, 'existing Task comment composer'); trace.push('scroll');
    },
    async click(target: string, label: string, text?: string) {
      if (label === 'focus existing correction comment') {
        assert.equal(target, selector); assert.equal(text, undefined); trace.push('focus');
      } else {
        assert.equal(target, '[role="dialog"] button.message-composer-send-button');
        assert.equal(label, 'original correction Comment once'); assert.equal(text, 'Comment'); trace.push('submit');
      }
    },
  };
  const run = Function('environment', `'use strict';
    const {assert,record,ui,cdp,options,taskId,commentText,desktopTaskCommentInputExpression}=environment;
    return (async()=>{${actual}})();`) as (environment: Record<string, unknown>) => Promise<void>;
  return { trace, budgets, reads: () => reads, run: () => run({ assert, ui, cdp,
    record(value: unknown) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value; },
    options: { handleId: 'TEST-original-correction-owner' }, taskId: 'TEST-original-correction-task',
    commentText: 'TEST original correction text',
    desktopTaskCommentInputExpression(handleId: string, taskId: string) {
      assert.equal(handleId, 'TEST-original-correction-owner'); assert.equal(taskId, 'TEST-original-correction-task');
      return 'TEST-original-current-correction-expression';
    },
  }) };
}

test('original review correction refuses missing or false live edit authority before any input action', { timeout: 5000 }, async () => {
  for (const observation of [null, {}, { canEditNow: false }, { canEditNow: 1 }, [{ canEditNow: true }]]) {
    const refusal = new Error('TEST original currentness read failed');
    const f = await originalReviewCorrectionStage([observation, refusal]);
    await assert.rejects(f.run(), error => error === refusal);
    assert.deepEqual(f.trace, ['read', 'read']); assert.deepEqual(f.budgets, [30_000]);
    assert.equal(f.reads(), 2);
  }
});

test('original review correction admits current authority with one original insertion and submit', { timeout: 5000 }, async () => {
  for (const observations of [['current'], [{ canEditNow: false }, 'current']]) {
    const f = await originalReviewCorrectionStage(observations);
    await f.run();
    assert.deepEqual(f.trace, [...observations.map(() => 'read'), 'scroll', 'focus', 'insert', 'submit']);
    assert.deepEqual(f.budgets, [30_000]); assert.equal(f.reads(), observations.length);
  }
  const failure = new Error('TEST original insertion response failed');
  const refused = await originalReviewCorrectionStage(['current'], failure);
  await assert.rejects(refused.run(), error => error === failure);
  assert.deepEqual(refused.trace, ['read', 'scroll', 'focus', 'insert']);
  assert.deepEqual(refused.budgets, [30_000]); assert.equal(refused.reads(), 1);
});

async function originalEmulatedBootChat(fixture: {
  clock: { now: number }; modes: string[]; expireAfter?: 'preview' | 'final-target' | 'reply'; memberName?: string;
  scenario?: 'selection' | 'lifecycle' | 'runtime' | 'collaboration'; backShown?: boolean;
}) {
  const { stripTypeScriptTypes } = await import('node:module');
  const { desktopJsLiteral: literal } = await import('./desktop-ui-controls.ts');
  const scenario = fixture.scenario ?? 'selection', timeoutMs = scenario === 'lifecycle' ? 30_000 : 60_000;
  const source = (await readFile(new URL(`./desktop-emulated-${scenario}-ui.ts`, import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  const [begin, end] = scenario === 'selection' ? ['  const leadSelector = (live: Live) => {', '  const assertSameLive = async (']
    : scenario === 'collaboration' ? ['  const back = async (', '  const commandText = (row: Row) =>']
      : ['  await openDesktopEmulatedBootChat(cdp, {', '  proof.launchScreenshot ='];
  for (const marker of [begin, end]) assert.equal(source.split(marker).length, 2, 'one original initial conversation boundary');
  if (scenario === 'selection') for (const live of ['liveA', 'liveB']) assert.equal(source.split(`await openInitialChat(${live});`).length, 2);
  if (scenario === 'collaboration') assert.equal(source.split("await openMember('alice', true);").length, 2);
  const actual = stripTypeScriptTypes(source.slice(source.indexOf(begin), source.indexOf(end)));
  const shared = await readFile(new URL('./desktop-emulated-boot-chat.ts', import.meta.url), 'utf8');
  const sharedBegin = 'export async function openDesktopEmulatedBootChat(';
  assert.equal(shared.split(sharedBegin).length, 2, 'one actual shared BOOT gate');
  const sharedActual = stripTypeScriptTypes(shared.slice(shared.indexOf(sharedBegin)).replace(/^export /u, ''));
  const memberName = fixture.memberName ?? (scenario === 'selection' ? 'team-lead' : 'alice');
  const name = memberName === 'team-lead' ? 'lead' : memberName;
  const selector = `button[aria-label^=${literal(name + ',')}]`;
  const commands: Record<string, unknown>[] = [], steps: Record<string, unknown>[] = [];
  const budgets: { label: string; ms: number }[] = [], values: boolean[] = [], trace: string[] = [];
  const refusal = new Error('TEST original preview observation failed');
  let previews = 0, targets = 0, opened = false, backShown = fixture.backShown === true;
  const rect = { x: 20, y: 40, width: 100, height: 30, top: 40, bottom: 70 };
  const button = (label: string, texts: string[]) => ({
    label, tagName: 'BUTTON', parentElement: null,
    textContent: texts.join(' '), getBoundingClientRect: () => rect,
    matches(actual: string) { assert.equal(actual, ':disabled'); return false; },
    closest(actual: string) { assert.equal(actual, '[role="dialog"]'); return null; },
    getAnimations: () => [], contains: () => false,
    querySelectorAll(actual: string) { assert.equal(actual, 'span'); return texts.map(textContent => ({ textContent })); },
  });
  let buttons = [button(name + ', conversation', ['TEST pending'])];
  const backSelector = 'button[aria-label="Back to chats"]', backButton = button('Back to chats', ['Back to chats']);
  let pointedButton = buttons[0];
  const cdp = {
    async evaluate(expression: string) {
      const back = expression.startsWith('Boolean(document.querySelector(');
      const preview = expression.includes('TEST boot ready') && !expression.startsWith('document.body.');
      const reply = expression.startsWith('document.body.');
      if (preview) {
        const mode = fixture.modes[previews++];
        if (mode === undefined) throw refusal;
        const text = mode === 'current' || mode === 'duplicate-row' || mode === 'duplicate-span' ? 'TEST boot ready'
          : mode === 'user-prefix' ? 'You: TEST boot ready' : mode === 'substring' ? 'TEST boot ready later' : 'TEST pending';
        const row = button(name + ', conversation', mode === 'duplicate-span' ? [text, text] : [text]);
        buttons = mode === 'missing' ? [] : mode === 'wrong-row'
          ? [row, button('TEST-other-lead, conversation', ['TEST boot ready'])]
          : mode === 'duplicate-row' ? [row, row] : [row];
      }
      const value = runInNewContext(expression, {
        innerWidth: 1000, innerHeight: 720, getComputedStyle: () => ({ pointerEvents: 'auto' }),
        document: {
          querySelectorAll(actual: string) {
            if (actual === backSelector) { pointedButton = backButton; return backShown ? [backButton] : []; }
            assert.equal(actual, selector, 'the original captured lead selector is unchanged');
            pointedButton = buttons[0];
            return buttons.filter(row => row.label.startsWith(name + ','));
          },
          querySelector(actual: string) { assert.equal(actual, backSelector); return backShown ? backButton : null; },
          elementFromPoint: () => pointedButton, fonts: { status: 'loaded' },
          documentElement: { getBoundingClientRect: () => ({ x: 0, width: 1000, top: 0, bottom: 720 }) },
          body: { innerText: opened ? 'TEST boot ready' : '' },
        },
      });
      await Promise.resolve();
      if (preview) {
        assert.equal(typeof value, 'boolean'); values.push(value); trace.push('preview');
        fixture.clock.now += 10_000;
        if (fixture.expireAfter === 'preview') fixture.clock.now = timeoutMs;
      } else if (reply) {
        trace.push('reply'); fixture.clock.now += 1000;
        if (fixture.expireAfter === 'reply') fixture.clock.now = timeoutMs;
      } else if (back) {
        trace.push('back'); fixture.clock.now += 1000;
      } else if (expression.includes('const elements =')) {
        targets++; trace.push('target'); fixture.clock.now += 500;
        if (fixture.expireAfter === 'final-target' && targets === 5) fixture.clock.now = timeoutMs;
      } else {
        assert.ok(expression.includes('const top=Math.max')); trace.push('scroll'); fixture.clock.now += 1000;
      }
      return value;
    },
    async send(method: string, params: Record<string, unknown> = {}) {
      assert.ok(method === 'Page.bringToFront' || method === 'Input.dispatchMouseEvent');
      commands.push({ method, ...params }); trace.push(String(params.type ?? method));
      if (params.type === 'mouseReleased') {
        if (pointedButton === backButton) backShown = false;
        else opened = true;
      }
      return {};
    },
  };
  const make = Function('environment', `'use strict';
    const {assert,literal,ui,createDesktopUiControls,cdp,options,steps,memberName}=environment;
    ${sharedActual}
    ${scenario === 'selection' || scenario === 'collaboration' ? actual : ''}
    return ${scenario === 'selection' ? '() => openInitialChat({memberName})' : scenario === 'collaboration'
      ? "() => openMember('alice', true)" : `async () => {${actual}}`};`) as (environment: Record<string, unknown>) => () => Promise<void>;
  const run = make({ assert, literal, ui: undefined, cdp, steps, memberName, options: { assertOwnedRenderer() {} },
    createDesktopUiControls(port: typeof cdp, options: Parameters<typeof createDesktopUiControls>[1]) {
      const controls = createDesktopUiControls(port, options);
      return { ...controls, waitRead: ((expression: string, label: string, timeoutMs = 30_000,
        accepts?: (value: unknown) => boolean) => {
        budgets.push({ label, ms: timeoutMs }); return controls.waitRead(expression, label, timeoutMs, accepts);
      }) as typeof controls.waitRead };
    },
  });
  return { run, commands, steps, budgets, values, trace, refusal };
}

test('original first A and B conversation waits for its exact preview before one physical click in the shared budget', { timeout: 5000 }, async t => {
  const clock = { now: 0 }; t.mock.method(Date, 'now', () => clock.now);
  for (const memberName of ['team-lead', 'TEST-captured-lead']) {
    clock.now = 0;
    const f = await originalEmulatedBootChat({ clock, memberName, modes: ['pending', 'current'] });
    await f.run();
    assert.deepEqual(f.values, [false, true]);
    assert.deepEqual(f.budgets, [{ label: 'original lead BOOT preview', ms: 60_000 },
      { label: 'original visible reply TEST boot ready', ms: 36_500 }]);
    assert.deepEqual(f.commands, [{ method: 'Page.bringToFront' },
      { method: 'Input.dispatchMouseEvent', type: 'mouseMoved', x: 70, y: 55 },
      { method: 'Input.dispatchMouseEvent', type: 'mousePressed', x: 70, y: 55, button: 'left', clickCount: 1 },
      { method: 'Input.dispatchMouseEvent', type: 'mouseReleased', x: 70, y: 55, button: 'left', clickCount: 1 }]);
    assert.deepEqual(f.trace, ['preview', 'preview', 'scroll', 'Page.bringToFront', 'target', 'mouseMoved',
      'target', 'target', 'target', 'target', 'mousePressed', 'mouseReleased', 'reply']);
    assert.deepEqual(f.steps.map(row => [row.action, row.label]), [
      ['mouseMoved', 'hover open original lead conversation'], ['mouseClick', 'open original lead conversation']]);
  }
});

test('original initial conversation rejects observations crossing the same cutoff without a late press or replay', { timeout: 5000 }, async t => {
  const clock = { now: 0 }; t.mock.method(Date, 'now', () => clock.now);
  for (const expireAfter of ['preview', 'final-target', 'reply'] as const) {
    clock.now = 0;
    const f = await originalEmulatedBootChat({ clock, modes: ['current'], expireAfter });
    await assert.rejects(f.run(), /original initial conversation deadline/);
    assert.equal(f.commands.filter(row => row.type === 'mousePressed').length, expireAfter === 'reply' ? 1 : 0);
    assert.equal(f.commands.filter(row => row.type === 'mouseReleased').length, expireAfter === 'reply' ? 1 : 0);
    assert.equal(f.values.length, 1); assert.equal(f.budgets[0]!.ms, 60_000);
    assert.equal(f.budgets.length, expireAfter === 'reply' ? 2 : 1);
    assert.equal(f.trace.filter(value => value === 'reply').length, expireAfter === 'reply' ? 1 : 0);
  }
});

test('original initial conversation refuses missing wrong or duplicate terminal previews before opening a chat', { timeout: 5000 }, async t => {
  const clock = { now: 0 }; t.mock.method(Date, 'now', () => clock.now);
  for (const mode of ['missing', 'pending', 'wrong-row', 'user-prefix', 'substring', 'duplicate-row', 'duplicate-span']) {
    clock.now = 0;
    const f = await originalEmulatedBootChat({ clock, modes: [mode] });
    await assert.rejects(f.run(), error => error === f.refusal);
    assert.deepEqual(f.values, [false], mode); assert.deepEqual(f.commands, [], mode);
    assert.deepEqual(f.steps, [], mode); assert.deepEqual(f.trace, ['preview'], mode);
    assert.deepEqual(f.budgets, [{ label: 'original lead BOOT preview', ms: 60_000 }]);
  }
});

test('original lifecycle runtime and collaboration retain their boot budgets and navigation before one chat click', { timeout: 5000 }, async t => {
  const clock = { now: 0 }; t.mock.method(Date, 'now', () => clock.now);
  for (const [scenario, backShown, previewBudget, replyBudget, replyLabel] of [
    ['lifecycle', false, 30_000, 7500, 'original lifecycle boot reply'],
    ['runtime', false, 60_000, 37_500, 'original visible reply TEST boot ready'],
    ['collaboration', false, 59_000, 35_500, 'original visible TEST boot ready'],
    ['collaboration', true, 55_500, 32_000, 'original visible TEST boot ready'],
  ] as const) {
    clock.now = 0;
    const f = await originalEmulatedBootChat({ clock, scenario, backShown, modes: ['pending', 'current'] });
    await f.run();
    assert.deepEqual(f.values, [false, true]);
    assert.deepEqual(f.budgets, [{ label: 'original lead BOOT preview', ms: previewBudget }, { label: replyLabel, ms: replyBudget }]);
    assert.equal(f.trace.filter(value => value === 'back').length, scenario === 'collaboration' ? 1 : 0);
    assert.equal(f.trace.filter(value => value === 'scroll').length, scenario === 'collaboration' ? backShown ? 2 : 1 : 0);
    const clicks = f.steps.filter(row => row.action === 'mouseClick');
    assert.deepEqual(clicks.map(row => row.label), [...(backShown ? ['original Back to chats'] : []),
      scenario === 'lifecycle' ? 'original lifecycle lead chat' : scenario === 'runtime' ? 'open original lead conversation' : 'open original alice conversation']);
    assert.equal(f.commands.filter(row => row.type === 'mousePressed').length, backShown ? 2 : 1);
    assert.equal(f.commands.filter(row => row.type === 'mouseReleased').length, backShown ? 2 : 1);
    assert.ok(f.trace.indexOf('preview') < f.trace.lastIndexOf('mousePressed'));
    clock.now = 0;
    const expired = await originalEmulatedBootChat({ clock, scenario, backShown, modes: ['current'], expireAfter: 'preview' });
    await assert.rejects(expired.run(), /original initial conversation deadline/);
    assert.equal(expired.commands.filter(row => row.type === 'mousePressed').length, backShown ? 1 : 0);
    assert.equal(expired.commands.filter(row => row.type === 'mouseReleased').length, backShown ? 1 : 0);
  }
});

async function finiteMembershipFunction(begin: string, end: string, name: string, environment: Record<string, unknown>) {
  const { stripTypeScriptTypes } = await import('node:module');
  const source = (await readFile(new URL('./desktop-live-membership-controlled.ts', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  for (const marker of [begin, end]) assert.equal(source.split(marker).length, 2, 'one private finite P11 source boundary');
  const actual = stripTypeScriptTypes(source.slice(source.indexOf(begin), source.indexOf(end)).replace(/^export /u, ''));
  return Function('environment', `'use strict';const {assert,process,processFacts,command,readFile,realpath,join,dirname}=environment;
    ${actual}
    return ${name};`)(environment) as (...args: unknown[]) => unknown;
}

test('finite V2 P11 admission rejects mixed selectors before any fixture or process observation', async () => {
  const allowed = { LEGACY_DESKTOP_FINITE_V2_MEMBERSHIP: '1', LEGACY_DESKTOP_BACKEND_GO: '1',
    LEGACY_DESKTOP_PROOF_MODE: 'native-mixed-create-launch-ui', LEGACY_DESKTOP_MIXED_MEMBERSHIP_UI: '1',
    LEGACY_DESKTOP_OPENCODE_GENERATION: 'v2', OPENCODE_V2_EMBEDDED_BUN: '/TEST-bun',
    OPENCODE_V2_EMBEDDED_GRAPH: '/TEST-graph', OPENCODE_V2_EMBEDDED_BUN_SHA256: 'a'.repeat(64) };
  const select = async (env: Record<string, string | undefined>, platform = 'linux', arch = 'x64') => {
    const actual = await finiteMembershipFunction('export function desktopFiniteV2MembershipSelected()',
      '/** One existing private owner;', 'desktopFiniteV2MembershipSelected', { assert, process: { env, platform, arch } });
    return actual();
  };
  assert.equal(await select({}), false); assert.equal(await select(allowed), true);
  for (const override of [{ LEGACY_DESKTOP_FINITE_V2_MEMBERSHIP: 'yes' }, { LEGACY_DESKTOP_BACKEND_GO: '0' },
    { LEGACY_DESKTOP_PROOF_MODE: 'team-ui' }, { LEGACY_DESKTOP_MIXED_MEMBERSHIP_UI: undefined },
    { LEGACY_DESKTOP_OPENCODE_GENERATION: 'v1' }, { LEGACY_DESKTOP_EMULATED_ONLY: '1' },
    { LEGACY_DESKTOP_CLAUDE_PATH: '/TEST-unselected' }, { LEGACY_DESKTOP_CODEX_PATH: '/TEST-unselected' },
    { LEGACY_DESKTOP_PACKED_CAPTURE_PATH: '/TEST-other.json' }, { OPENCODE_V2_EMBEDDED_GRAPH: undefined },
    { OPENCODE_V2_EMBEDDED_BUN_SHA256: 'bad' }])
    await assert.rejects(select({ ...allowed, ...override }), assert.AssertionError);
  await assert.rejects(select(allowed, 'darwin'), assert.AssertionError);
  await assert.rejects(select(allowed, 'linux', 'arm64'), assert.AssertionError);
});

test('finite V2 P11 Linux projection keeps exact kernel identity and refuses changed or foreign children', async () => {
  const { dirname, join } = await import('node:path');
  const host = { pid: 200, parentPid: 100, groupId: 100, birth: 'original ps host', command: 'node' };
  const peer = { pid: 201, parentPid: 200, groupId: 201, birth: 'original ps peer', command: 'node' };
  const native = { pid: 202, parentPid: 200, groupId: 202, birth: 'original ps V2', command: 'bun' };
  const unrelated = { pid: 300, parentPid: 1, groupId: 300, birth: 'original other', command: 'other' };
  const exercise = async (variant: 'ready' | 'no-host' | 'changed-birth' | 'foreign-executable' | 'foreign-wrapper' | 'wrong-parent') => {
    const reads: string[] = [], stats = new Map<number, number>(); let censuses = 0;
    const table = variant === 'no-host' ? [unrelated] : [host, peer, native, unrelated];
    const fixture = { node: '/TEST/node', hostEntry: '/TEST/host/cli.js', finiteInitialPeers: {
      peers: [{ provider: 'claude', executable: { path: '/TEST/peer' } }] } };
    const actual = await finiteMembershipFunction('export async function desktopFiniteMembershipProcesses(',
      'export function captureDesktopFiniteMembershipScope(', 'desktopFiniteMembershipProcesses', {
        assert, process: { platform: 'linux', env: { OPENCODE_V2_EMBEDDED_BUN: '/TEST/bun' } }, dirname, join,
        processFacts() { censuses++; return table; },
        command(pid: number) { assert.equal(pid, 200); return '/TEST/node /TEST/host/cli.js'; },
        async realpath(path: string) {
          reads.push(path); const pid = Number(path.split('/')[2]);
          assert.equal(path, `/proc/${pid}/exe`);
          return variant === 'foreign-executable' && pid === 201 ? '/TEST/foreign' : pid === 202 ? '/TEST/bun' : '/TEST/node';
        },
        async readFile(path: string) {
          reads.push(path); const pid = Number(path.split('/')[2]), row = table.find(value => value.pid === pid); assert.ok(row);
          if (path.endsWith('/stat')) {
            const count = (stats.get(pid) ?? 0) + 1; stats.set(pid, count);
            const fields = Array<string>(20).fill('0'); fields[0] = 'S';
            fields[1] = String(variant === 'wrong-parent' && pid === 201 ? 299 : row.parentPid);
            fields[2] = String(row.groupId); fields[19] = String(pid * 10 + (variant === 'changed-birth' && pid === 201 && count === 2 ? 1 : 0));
            return `${pid} (TEST name with ) bracket) ${fields.join(' ')}`;
          }
          assert.equal(path, `/proc/${pid}/cmdline`);
          const args = pid === 200 ? ['/TEST/node', '/TEST/host/cli.js'] : pid === 201
            ? ['/TEST/node', variant === 'foreign-wrapper' ? '/TEST/other' : '/TEST/peer', '--original']
            : ['/TEST/bun', '--no-env-file', '--config=/dev/null', '--no-install', '/TEST/host/adapters/providers/OpenCodeV2EmbeddedChild.js'];
          return Buffer.from(args.join('\0') + '\0');
        },
      });
    const promise = actual(100, fixture) as Promise<unknown>;
    if (variant !== 'ready' && variant !== 'no-host') await assert.rejects(promise, assert.AssertionError);
    else {
      const result = await promise;
      assert.deepEqual(result, variant === 'no-host' ? table : [
        { ...host, birth: 'linux-starttime:2000', command: '/TEST/node' },
        { ...peer, birth: 'linux-starttime:2010', command: '/TEST/node' },
        { ...native, birth: 'linux-starttime:2020', command: '/TEST/bun' }, unrelated]);
      assert.equal(censuses, 1); assert.ok(reads.every(path => !path.includes('/300/')));
      assert.equal(reads.length, variant === 'no-host' ? 0 : 12);
    }
    assert.deepEqual(table, variant === 'no-host' ? [unrelated] : [host, peer, native, unrelated]);
  };
  for (const variant of ['ready', 'no-host', 'changed-birth', 'foreign-executable', 'foreign-wrapper', 'wrong-parent'] as const)
    await exercise(variant);
});

async function finiteMembershipTerminalCompletion() {
  const source = (await readFile(new URL('./desktop-backend-smoke.ts', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  const begin = '    assertDesktopProofCompleted(evidence, {', end = "  if (mode === 'task-board-cross-team-ui') {";
  for (const marker of [begin, end]) assert.equal(source.split(marker).length, 2, 'one original terminal completion boundary');
  const actual = source.slice(source.indexOf(begin), source.indexOf(end));
  const invoke = Function('assert', 'options', `'use strict';
    const { evidence, finiteMembership, primaryError, finalError } = options;
    const packed = false, emulatedOnly = false, controlledProcessMode = false;
    const mode = 'native-mixed-create-launch-ui', scheduleUiMode = false, capturedMcpUiMode = false;
    const cleanupFailure = undefined, remaining = [];
    let originalCompletions = 0;
    const assertDesktopProofCompleted = () => {
      originalCompletions++;
      if (finalError) throw finalError;
    };
    try { if (primaryError) throw primaryError; }
    catch (error) { throw error; }
    finally {
      ${actual}
    return originalCompletions;
  `);
  return (options: { evidence: { status: string }; finiteMembership: boolean; primaryError?: Error; finalError?: Error }) =>
    invoke(assert, options) as number;
}

test('finite V2 terminal completion retains the original scenario Error after successful original final assertions', async () => {
  const complete = await finiteMembershipTerminalCompletion();
  const original = new Error('original finite membership scenario failure');
  assert.throws(() => complete({ evidence: { status: 'INCOMPLETE' }, finiteMembership: true, primaryError: original }),
    error => error === original);
});

test('finite V2 terminal completion retains original finally precedence and refuses incomplete successful work', async () => {
  const complete = await finiteMembershipTerminalCompletion();
  const original = new Error('original body failure'), finalError = new Error('original final assertion failure');
  assert.throws(() => complete({ evidence: { status: 'INCOMPLETE' }, finiteMembership: true, primaryError: original, finalError }),
    error => error === finalError);
  assert.throws(() => complete({ evidence: { status: 'INCOMPLETE' }, finiteMembership: true }), {
    name: 'AssertionError', message: /original finite-peer V2 membership and cleanup must both pass/u,
  });
  assert.equal(complete({ evidence: { status: 'PASS' }, finiteMembership: true }), 1);
  assert.equal(complete({ evidence: { status: 'INCOMPLETE' }, finiteMembership: false }), 1);
});
