import { EventEmitter, errorMonitor } from 'node:events';
import { readFileSync } from 'node:fs';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { extendOwnedHistory, remainingOwned } from './teams-create-page-owned-processes.mjs';
const row = (pid, parent, birth) => ({ pid, parent, birth: new Date(birth).toISOString() });

test('retains exact descendants when a verified parent exits', () => {
  const root = row(100, 1, '2026-01-01T00:00:00Z');
  const pnpm = row(101, 100, '2026-01-01T00:00:01Z');
  const electron = row(102, 101, '2026-01-01T00:00:02Z');
  const history = extendOwnedHistory([root], [pnpm, electron]);
  assert.deepEqual(history, [root, pnpm, electron]);
  assert.deepEqual(remainingOwned(history, [electron]), [electron]);
  assert.deepEqual(remainingOwned(history, []), []);
});

test('never adopts children of a reused parent PID', () => {
  const root = row(100, 1, '2026-01-01T00:00:00Z');
  const reused = row(100, 1, '2026-01-01T01:00:00Z');
  const foreign = row(222, 100, '2026-01-01T01:00:01Z');
  assert.deepEqual(extendOwnedHistory([root], [reused, foreign]), [root]);
  assert.deepEqual(remainingOwned([root], [reused]), []);
});

test('refuses older child identity and an unknown owner history', () => {
  const root = row(100, 1, '2026-01-01T00:00:00Z');
  assert.deepEqual(extendOwnedHistory([root], [row(101, 100, '2025-12-31T23:59:59Z')]), [root]);
  assert.throws(() => extendOwnedHistory([], []), /history is unavailable/);
});


const desktopSource = readFileSync(new URL('./teams-create-page-desktop.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function actualBlock(begin, end, includeBegin = false) {
  const start = desktopSource.indexOf(begin), finish = desktopSource.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && finish > start && desktopSource.indexOf(begin, start + 1) === -1);
  return desktopSource.slice(start + (includeBegin ? 0 : begin.length), finish);
}
const clientSource = actualBlock(
  '  return { port, renderer, inspectorWebSocketDebuggerUrl };\n}\n\n',
  '\nasync function waitForProcessGroupExit('
);
const actionSource = actualBlock(
  '  await cdp.click("document.querySelector(\'[role=dialog] [data-task-detail-open-tab]\')"',
  "  await captureScreenshot(cdp, fixture, 'zh-tw-task-detail-tab');", true
);
const dumpSource = actualBlock('async function dumpRenderer(', '\nasync function captureScreenshot(', true);
const hydrationLabel = 'fully hydrated visible localized task detail in active native tab';
const buttonExpression = "document.querySelector('[role=dialog] [data-task-detail-open-tab]')";

function taskTabHarness(setup = '', mouseError = null) {
  const renderer = createContext({});
  const control = runInContext(`(() => {
    const key = JSON.stringify(['TEST-context', 'TEST-team', '77']);
    const state = {
      activeContextId: 'TEST-context', isContextSwitching: false, activeTabId: 'teams',
      globalTaskDetail: { contextId: 'TEST-context', teamName: 'TEST-team', taskId: '77' },
      taskDetailSessionById: { [key]: { ownerSurfaceId: 'TEST-dialog', ownerRevision: 1 } },
      taskDetailById: { [key]: { phase: 'ready' } },
      paneLayout: { focusedPaneId: 'pane', panes: [
        { id: 'pane', activeTabId: 'teams', tabs: [{ id: 'teams', type: 'teams' }] },
      ] },
    };
    const c = { state, key, listeners: [], scrolls: 0, rectangles: 0, stateReads: 0,
      getterCalls: 0, registrations: 0, removed: 0, prevented: 0, stopped: 0,
      passiveFlags: [], authorityCalls: 0, extraClicks: 0, focuses: 0, clockReads: 0, timerCalls: 0,
      attributes: 0, pageVisible: false, dialogVisible: true, burst: 0 };
    class Element {
      constructor(attrs = {}, parent = null) { this.attrs = attrs; this.parentElement = parent;
        this.nodeType = 1; this.isConnected = true; this.disabled = false; }
      scrollIntoView() { c.scrolls++; }
      click() { c.extraClicks++; }
      focus() { c.focuses++; }
      getAnimations() { return []; }
      contains(other) {
        for (let node = other; node; node = node.parentElement) if (node === this) return true;
        return false;
      }
      getBoundingClientRect() { if (this === button) c.rectangles++;
        return { left: 10, top: 20, width: 80, height: 20 }; }
      getClientRects() { return c.pageVisible ? [{}] : []; }
      getAttribute(name) { c.attributes++; return this.attrs[name] ?? null; }
      hasAttribute(name) { c.attributes++; return Object.hasOwn(this.attrs, name); }
      querySelector(selector) { return selector === 'h1' ? heading : null; }
    }
    const body = new Element(), dialog = new Element({ role: 'dialog' }, body);
    const button = new Element({ 'data-task-detail-open-tab': '' }, dialog);
    const foreign = new Element({}, body), descendant = new Element({}, button);
    const heading = { textContent: 'TEST zh-TW task detail' };
    const page = new Element({ 'data-task-detail-team': 'TEST-team', 'data-origin-current': 'true' }, body);
    body.innerText = 'TEST task dialog';
    function store() {}
    store.getState = () => { c.stateReads++; if (c.throwState) throw new Error('TEST original state error'); return state; };
    const document = {
      body,
      elementFromPoint() { return button; },
      querySelector(selector) {
        if (selector.includes('data-task-detail-open-tab')) return button;
        if (selector.includes('data-task-detail-page')) return c.pageVisible ? page : null;
        if (selector === '[role="dialog"]' || selector === '[role=dialog]') return c.dialogVisible ? dialog : null;
        return null;
      },
      addEventListener(type, listener, options) {
        c.registrations++; c.passiveFlags.push(options?.passive === true);
        if (c.registrationThrowAt === c.registrations) throw new Error('TEST registration failure');
        c.listeners.push({ type, listener, capture: options === true || options?.capture === true });
      },
      removeEventListener(type, listener, options) {
        const capture = options === true || options?.capture === true;
        const index = c.listeners.findIndex(row => row.type === type && row.listener === listener && row.capture === capture);
        if (index >= 0) { c.listeners.splice(index, 1); c.removed++; }
      },
    };
    const clock = { now() { c.clockReads++; return 0; } };
    function diagnosticTimer() { c.timerCalls++; throw new Error('TEST forbidden diagnostic timer'); }
    function DiagnosticDate() { c.clockReads++; throw new Error('TEST forbidden diagnostic clock'); }
    DiagnosticDate.now = clock.now;
    const browser = { document, Element, __agentTeamsDevStore: store,
      innerWidth: 1000, innerHeight: 720,
      performance: clock, Date: DiagnosticDate, setTimeout: diagnosticTimer, clearTimeout: diagnosticTimer };
    Object.assign(globalThis, { document, window: browser,
      Element, c, state, key, button, foreign, descendant, heading, body, dialog,
      performance: clock, Date: DiagnosticDate, setTimeout: diagnosticTimer, clearTimeout: diagnosticTimer });
    browser.window = browser; browser.globalThis = browser; globalThis.globalThis = browser;
    for (const name of ['getAllPaneTabs', 'openTaskDetailTab', 'setActiveTab', 'claimTaskDetailOwner', 'transferTaskDetailOwner'])
      state[name] = () => { c.authorityCalls++; throw new Error('TEST forbidden diagnostic action'); };
    c.emit = (type, target = c.target ?? button) => {
      const event = { type, target, isTrusted: true, defaultPrevented: false,
        preventDefault() { c.prevented++; }, stopPropagation() { c.stopped++; } };
      for (const capture of [true, false]) for (const row of [...c.listeners])
        if (row.type === type && row.capture === capture) row.listener(event);
    };
    c.ready = () => {
      const tab = { id: 'task-tab', type: 'team', teamName: 'TEST-team',
        taskDetail: { contextId: 'TEST-context', taskId: '77' } };
      state.paneLayout.panes[0].tabs.push(tab); state.paneLayout.panes[0].activeTabId = tab.id;
      state.activeTabId = tab.id; state.globalTaskDetail = null;
      state.taskDetailSessionById[key].ownerSurfaceId = tab.id;
      state.taskDetailSessionById[key].ownerRevision = 2;
      c.pageVisible = true; c.dialogVisible = false;
    };
    return c;
  })()`, renderer);
  if (setup) runInContext(setup, renderer);
  const writes = [], calls = [], results = [];
  const inputClock = { now: 0 };
  const actual = runInNewContext(`${clientSource}\n${dumpSource}\n({
    CdpClient, dumpRenderer, flow: async (cdp, fixture, taskId) => { ${actionSource} }
  })`, { assert, setTimeout, clearTimeout, Date: { now: () => inputClock.now }, process: {
    platform: 'linux', stderr: { write(value) { writes.push(value); } },
  } });
  const client = new actual.CdpClient({ on() {}, close() {} });
  client.send = async (method, params) => {
    calls.push({ method, params });
    if (method === 'Runtime.evaluate') {
      try { return { result: { value: await runInContext(params.expression, renderer) } }; }
      catch (error) { return { exceptionDetails: { exception: { description: error.message } } }; }
    }
    assert.equal(method, 'Input.dispatchMouseEvent');
    if (params.type === 'mousePressed') {
      if (mouseError) throw mouseError;
      for (let i = 0; i < Math.max(1, control.burst); i++) control.emit('pointerdown');
    } else {
      assert.equal(params.type, 'mouseReleased'); control.emit('pointerup'); control.emit('click');
    }
    return {};
  };
  const originalWait = client.waitFor.bind(client);
  let predicate, timeout;
  client.waitFor = async (expression, label, timeoutMs) => {
    if (label !== hydrationLabel) return originalWait(expression, label, timeoutMs);
    predicate = expression; timeout = timeoutMs;
    results.push(await client.evaluate(expression));
  };
  return {
    control, renderer, calls, results, client, inputClock,
    run: () => actual.flow(client, { teamName: 'TEST-team' }, '77'),
    sample: async () => { const value = await client.evaluate(predicate); results.push(value); return value; },
    repeat: count => runInContext(`for (let n = 0; n < ${count}; n++) { (${predicate}); }`, renderer),
    mutate: code => runInContext(code, renderer),
    timeout: () => timeout,
    async dump() { await actual.dumpRenderer(client, 'TEST task-tab failure'); return JSON.parse(writes.at(-1)); },
  };
}
function originalInput(h) {
  assert.equal(h.control.scrolls, 1); assert.equal(h.control.rectangles, 2);
  assert.deepEqual(h.calls.filter(row => row.method === 'Input.dispatchMouseEvent').map(row => ({
    ...row.params,
  })), [
    { type: 'mousePressed', x: 50, y: 30, button: 'left', clickCount: 1 },
    { type: 'mouseReleased', x: 50, y: 30, button: 'left', clickCount: 1 },
  ]);
  assert.equal(h.timeout(), 60_000);
  assert.equal(h.control.prevented, 0); assert.equal(h.control.stopped, 0);
  assert.equal(h.control.authorityCalls, 0); assert.equal(h.control.extraClicks, 0); assert.equal(h.control.focuses, 0);
  assert.equal(h.control.clockReads, 0); assert.equal(h.control.timerCalls, 0);
}
function observed(dump) {
  const value = dump.taskTabObservation;
  assert.ok(value && value.version === 1, 'Actual original task-tab flow must retain its bounded observation');
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 4096);
  assert.deepEqual(Object.keys(value).sort(), ['before', 'events', 'eventsCapped', 'finished', 'first', 'last', 'samples', 'samplesCapped', 'version']);
  for (const row of value.events) assert.deepEqual(Object.keys(row).sort(),
    ['inDialog', 'kind', 'measuredConnected', 'phase', 'prevented', 'sameMeasured', 'taskTabTarget', 'trusted']);
  return value;
}

test('actual task-tab action retains before/first/last evidence without changing its input or predicate', async () => {
  const h = taskTabHarness('c.target = descendant;');
  await h.run(); originalInput(h);
  assert.deepEqual(h.results, [false]);
  h.control.ready(); assert.equal(await h.sample(), true);
  assert.equal(h.control.listeners.length, 0, 'Original success evaluation removes the observer');
  const value = observed(await h.dump());
  assert.equal(value.before.globalDialog, 'target'); assert.equal(value.before.sessionPresent, true);
  assert.equal(value.before.targetTabs, 0); assert.equal(value.first.predicate.result, 'false');
  assert.equal(value.last.predicate.result, 'true'); assert.equal(value.last.state.targetTabs, 1);
  assert.equal(value.last.state.rootActiveTarget, true); assert.equal(value.last.state.ownerChanged, true);
  assert.equal(value.samples, 2); assert.equal(value.events.length, 6);
  assert.equal(h.control.registrations, 6); assert.ok(Array.from(h.control.passiveFlags).every(value => value === true));
  assert.deepEqual(value.events.map(row => [row.kind, row.phase, row.sameMeasured, row.trusted]), [
    ['pointerdown', 'capture', true, true], ['pointerdown', 'bubble', true, true],
    ['pointerup', 'capture', true, true], ['pointerup', 'bubble', true, true],
    ['click', 'capture', true, true], ['click', 'bubble', true, true],
  ]);
  assert.equal(h.control.stateReads, 3, 'Only one new before read; events/dump reuse no store call');
  assert.equal(h.calls.filter(row => row.method === 'Runtime.evaluate').length, 7);
  h.control.emit('click'); assert.deepEqual(observed(await h.dump()), value);
});

test('actual delivery may miss the measured task button; failure disposal retains that fact only', async () => {
  const h = taskTabHarness('c.target = foreign;');
  await h.run(); originalInput(h); assert.deepEqual(h.results, [false]);
  const value = observed(await h.dump());
  assert.equal(value.events.length, 6);
  assert.ok(value.events.every(row => row.sameMeasured === false && row.taskTabTarget === false && row.inDialog === false));
  assert.equal(value.last.state.globalDialog, 'target'); assert.equal(value.last.predicate.result, 'false');
  assert.equal(h.control.listeners.length, 0); assert.equal(h.control.removed, 6);
  assert.equal(h.control.stateReads, 2);
  assert.equal(h.calls.filter(row => row.method === 'Runtime.evaluate').length, 6);
  h.control.emit('click'); assert.deepEqual(observed(await h.dump()), value);
});

test('actual predicate preserves null/undefined and reports session/context/pane facts without authority calls', async () => {
  for (const mode of ['null', 'undefined']) {
    const h = taskTabHarness(); await h.run(); originalInput(h);
    h.control.ready();
    h.mutate(mode === 'null' ? 'c.pageVisible = false;' : 'heading.textContent = undefined;');
    assert.equal(await h.sample(), mode === 'null' ? null : undefined);
    h.mutate("state.activeContextId = 'TEST-other'; state.isContextSwitching = true; state.paneLayout.focusedPaneId = 'other'; delete state.taskDetailSessionById[key];");
    assert.equal(await h.sample(), mode === 'null' ? null : undefined);
    const value = observed(await h.dump());
    assert.equal(value.last.predicate.result, mode); assert.equal(value.last.state.contextMatches, false);
    assert.equal(value.last.state.switching, true); assert.equal(value.last.state.sessionPresent, false);
    assert.equal(value.last.state.focusedTarget, false); assert.equal(h.control.listeners.length, 0);
  }
});

test('diagnostic-only accessor reads are refused without invocation or changing original work', async () => {
  for (const key of ['taskDetailSessionById', 'taskDetailById', 'activeContextId', 'isContextSwitching']) {
    const h = taskTabHarness(`Object.defineProperty(state, ${JSON.stringify(key)}, { get() { c.getterCalls++; return {}; } });`);
    await h.run(); originalInput(h); assert.deepEqual(h.results, [false]);
    const dump = await h.dump(); assert.equal(h.control.getterCalls, 0);
    if (dump.taskTabObservation) assert.ok(Buffer.byteLength(JSON.stringify(dump.taskTabObservation)) <= 4096);
    assert.equal(h.control.listeners.length, 0);
  }
  const h = taskTabHarness("Object.defineProperty(state.taskDetailSessionById[key], 'ownerRevision', { get() { c.getterCalls++; return 2; } });");
  await h.run(); originalInput(h); await h.dump(); assert.equal(h.control.getterCalls, 0);
  const operand = taskTabHarness('const held = state.globalTaskDetail; Object.defineProperty(state, \'globalTaskDetail\', { get() { c.getterCalls++; return held; } });');
  await operand.run(); originalInput(operand); await operand.dump();
  assert.equal(operand.control.getterCalls, 1, 'The unchanged original predicate alone reads its original operand');
});

test('observer setup and sinks cannot replace original failures or create additional input', async () => {
  for (const setup of ['Object.preventExtensions(window);', 'c.registrationThrowAt = 3;']) {
    const h = taskTabHarness(setup); await h.run(); originalInput(h);
    assert.equal(h.control.listeners.length, 0, 'Partial setup is disposed before original input completes');
    await h.dump(); assert.equal(h.control.listeners.length, 0); assert.deepEqual(h.results, [false]);
  }
  const h = taskTabHarness('c.throwState = true;');
  await assert.rejects(h.run(), /TEST original state error/);
  assert.equal(h.calls.filter(row => row.method === 'Input.dispatchMouseEvent').length, 2);
  await h.dump(); assert.equal(h.control.listeners.length, 0);
  const failure = new Error('TEST original mouse transport refusal'), stopped = taskTabHarness('', failure);
  await assert.rejects(stopped.run(), error => error === failure);
  assert.equal(stopped.calls.filter(row => row.method === 'Input.dispatchMouseEvent').length, 1);
  await stopped.dump(); assert.equal(stopped.control.listeners.length, 0);
});

test('actual observer bounds events, ancestry, snapshots and counters without emitting private text', async () => {
  const h = taskTabHarness("c.burst = 10; state.taskDetailSessionById[key].ownerSurfaceId = 'TEST-private-owner-secret'; body.innerText = 'TEST-private-body-secret';");
  await h.run(); originalInput(h);
  h.repeat(65_536);
  const value = observed(await h.dump()), serialized = JSON.stringify(value);
  assert.equal(value.events.length, 8); assert.equal(value.eventsCapped, true);
  assert.equal(value.samples, 65_535); assert.equal(value.samplesCapped, true);
  assert.ok(h.control.attributes <= 16 * 2 * 8);
  assert.equal(serialized.includes('TEST-private'), false);
  assert.equal(serialized.includes('TEST-context'), false); assert.equal(serialized.includes('TEST-team'), false);
  const deep = taskTabHarness('let target = foreign; for (let n = 0; n < 18; n++) target = new Element({}, target); c.target = target;');
  await deep.run(); originalInput(deep);
  assert.ok(observed(await deep.dump()).events.every(row => row.sameMeasured === null && row.inDialog === null));
  for (const setup of [
    'state.paneLayout.panes = Array.from({ length: 9 }, (_, n) => ({ id: String(n), activeTabId: null, tabs: [] }));',
    "state.paneLayout.panes[0].tabs = Array.from({ length: 33 }, (_, n) => ({ id: String(n), type: 'teams' }));",
  ]) {
    const bounded = taskTabHarness(setup); await bounded.run(); originalInput(bounded);
    const projection = observed(await bounded.dump());
    assert.equal(projection.before, null); assert.equal(projection.last.state, null);
  }
});

test('ordinary non-opted-in click adds no store read/listener or diagnostic field', async () => {
  const h = taskTabHarness(); await h.client.click(buttonExpression);
  assert.equal(h.control.scrolls, 1); assert.equal(h.control.rectangles, 2);
  assert.equal(h.calls.filter(row => row.method === 'Input.dispatchMouseEvent').length, 2);
  assert.equal(h.control.stateReads, 0); assert.equal(h.control.registrations, 0);
  assert.equal(Object.hasOwn(await h.dump(), 'taskTabObservation'), false);
  assert.equal(h.calls.filter(row => row.method === 'Runtime.evaluate').length, 5);
});

test('settled task-tab click installs one observer only in the final sample within its original deadline', async () => {
  const h = taskTabHarness(), evaluate = h.client.evaluate.bind(h.client);
  const observations = [], waits = [], waitFor = h.client.waitFor.bind(h.client);
  h.client.waitFor = async (expression, label, timeoutMs) => {
    waits.push({ label, timeoutMs });
    return waitFor(expression, label, timeoutMs);
  };
  h.client.evaluate = async expression => {
    observations.push(h.control.registrations);
    const result = await evaluate(expression);
    h.inputClock.now += 2000;
    return result;
  };
  await h.run(); originalInput(h);
  assert.deepEqual(observations, [0, 0, 0, 0, 6]);
  assert.deepEqual(waits, [
    { label: buttonExpression, timeoutMs: 30_000 },
    { label: `settled exact E2E click target: ${buttonExpression}`, timeoutMs: 26_000 },
    { label: hydrationLabel, timeoutMs: 60_000 },
  ]);
  assert.equal(h.control.registrations, 6); assert.equal(h.control.stateReads, 2);
  const value = observed(await h.dump());
  assert.equal(value.events.length, 6); assert.equal(h.control.listeners.length, 0);
});

test('task-tab click refuses exact or late final samples without replaying its observer or dispatching input', async () => {
  for (const elapsed of [30_000, 30_001]) {
    const h = taskTabHarness(), evaluate = h.client.evaluate.bind(h.client);
    h.client.evaluate = async expression => {
      const result = await evaluate(expression);
      if (expression.includes('target.taskTabObserved =')) h.inputClock.now = elapsed;
      return result;
    };
    await assert.rejects(h.run(), /E2E click target deadline/);
    assert.equal(h.control.scrolls, 1); assert.equal(h.control.rectangles, 2);
    assert.equal(h.control.registrations, 6); assert.equal(h.control.stateReads, 1);
    assert.equal(h.calls.filter(row => row.method === 'Input.dispatchMouseEvent').length, 0);
    assert.equal(h.calls.filter(row => row.method === 'Runtime.evaluate').length, 4);
    const value = observed(await h.dump());
    assert.deepEqual(value.events, []); assert.equal(value.samples, 0);
    assert.equal(h.control.listeners.length, 0); assert.equal(h.control.removed, 6);
  }
});

test('task-tab click rejects a late initial target before scrolling or installing diagnostics', async () => {
  const h = taskTabHarness(), evaluate = h.client.evaluate.bind(h.client);
  h.client.evaluate = async expression => {
    const result = await evaluate(expression); h.inputClock.now = 30_000; return result;
  };
  await assert.rejects(h.run(), /E2E click target deadline/);
  assert.equal(h.control.scrolls, 0); assert.equal(h.control.rectangles, 0);
  assert.equal(h.control.registrations, 0); assert.equal(h.control.stateReads, 0);
  assert.equal(h.calls.filter(row => row.method === 'Input.dispatchMouseEvent').length, 0);
  assert.equal(h.calls.filter(row => row.method === 'Runtime.evaluate').length, 1);
});

test('malformed or oversize diagnostic identity/state stays unavailable without coercion', async () => {
  for (const setup of [
    "state.globalTaskDetail.contextId = { toString() { c.getterCalls++; return 'TEST-context'; } };",
    "state.globalTaskDetail.contextId = 'x'.repeat(257);",
    'state.taskDetailSessionById = [];',
    'state.taskDetailById = null;',
  ]) {
    const h = taskTabHarness(setup); await h.run(); originalInput(h); assert.deepEqual(h.results, [false]);
    const dump = await h.dump(); assert.equal(h.control.getterCalls, 0);
    if (dump.taskTabObservation) {
      const value = observed(dump); assert.equal(value.before, null); assert.equal(value.last.state, null);
    }
    assert.equal(h.control.listeners.length, 0); assert.ok(h.control.stateReads <= 2);
  }
});

test('actual diagnostic serialization failure leaves the original failure snapshot usable', async () => {
  const h = taskTabHarness(); await h.run(); originalInput(h); assert.deepEqual(h.results, [false]);
  observed(await h.dump());
  const priorCalls = h.calls.length;
  h.mutate("c.sinkCalls = 0; JSON.stringify = () => { c.sinkCalls++; throw new Error('TEST diagnostic sink failure'); };");
  const dump = await h.dump();
  assert.equal(dump.dialog, true); assert.equal(dump.bodyText, 'TEST task dialog');
  assert.equal(dump.taskTabObservation, null); assert.equal(h.control.sinkCalls, 1);
  assert.equal(h.calls.length, priorCalls + 1); assert.equal(h.control.stateReads, 2);
  assert.equal(h.control.listeners.length, 0);
});

function processFailureHarness({ holdRenderer = false } = {}) {
  const children = [], sockets = [], writes = [], timerHistory = [], timers = new Map();
  const control = { now: 1000, failClock: false, failDiagnosticWrite: false,
    screenshots: 0, cleanupCalls: 0, onCleanup: () => {}, cleanupError: null, processReads: 0 };
  let nextTimer = 0, releaseRenderer, rendererEntered;
  const rendererStarted = new Promise(resolve => { rendererEntered = resolve; });
  const rendererGate = new Promise(resolve => { releaseRenderer = resolve; });
  class TestSocket extends EventEmitter {
    constructor() { super(); this.frames = []; sockets.push(this); queueMicrotask(() => this.emit('open')); }
    send(value) { this.frames.push(JSON.parse(value)); }
    close() { this.emit('close'); }
  }
  const fakeProcess = { platform: 'win32', execPath: '/TEST/node', env: {}, stderr: {
    write(value) {
      if (control.failDiagnosticWrite && value.startsWith('CREATE_PAGE_PROCESS_DIAGNOSTIC '))
        throw new Error('TEST unavailable diagnostic sink');
      writes.push(value);
    },
  } };
  const globals = actualBlock('const appLogTail = [];', '// Use an explicit, available port:', true);
  const startup = actualBlock('async function startApp(fixture) {', '\nfunction installTaskTabObservation(', true);
  const failureTail = actualBlock('  } catch (error) {\n    failure = error;', '\n  assert(qualifiedResult,', true);
  const finalError = actualBlock('main().catch(async (error) => {', '\n});');
  const actual = runInNewContext([
    globals, startup, clientSource, dumpSource,
    'async function fail(primary, client) { cdp = client; const fixture = {};',
    'let failure = null, cleanupFailure = null; try { throw primary;',
    failureTail, '}',
    'async function finish(error) {', finalError, '}',
    '({ startApp, CdpClient, fail, finish })',
  ].join('\n'), {
    assert, Error, AggregateError, errorMonitor, extendOwnedHistory, WebSocket: TestSocket,
    process: fakeProcess, repoRoot: '/TEST/repo',
    Date: { now() { if (control.failClock) throw new Error('TEST unavailable clock'); return control.now; } },
    realpath: async value => value, findFreeInspectorPort: async () => 45550,
    spawn(command, args, options) {
      assert.equal(command, 'cmd.exe'); assert.deepEqual(Array.from(args), ['/d', '/s', '/c', 'pnpm dev:mcp --inspect=45550']);
      assert.equal(options.cwd, '/TEST/repo'); assert.equal(options.windowsHide, true);
      const child = new EventEmitter(); child.pid = 100 + children.length;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      const originalOn = child.stdout.on;
      child.stdout.on = function (event, listener) {
        originalOn.call(this, event, listener);
        if (event === 'data') this.emit('data',
          'DevTools listening on ws://127.0.0.1:9222/devtools/browser/TEST\n' +
          'Debugger listening on ws://127.0.0.1:45550/abcdef\n');
        return this;
      };
      children.push(child); return child;
    },
    processes() { control.processReads++; return children.map(child => row(child.pid, 1, '2026-01-01T00:00:00Z')); },
    waitForRenderer(port) {
      assert.equal(port, 9222); rendererEntered();
      return holdRenderer ? rendererGate : Promise.resolve({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/TEST' });
    },
    setTimeout(callback, ms) {
      const id = ++nextTimer; timers.set(id, callback); timerHistory.push({ id, ms }); return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async captureScreenshot() { control.screenshots++; throw new Error('TEST screenshot disconnected'); },
    async cleanup() {
      control.cleanupCalls++; control.onCleanup(); if (control.cleanupError) throw control.cleanupError;
    },
  });
  const fixture = { providerCliPaths: { codex: '/TEST/codex', claude: '/TEST/claude' } };
  for (const key of ['claudeRoot', 'userDataRoot', 'claudeConfigDir', 'multimodelDataHome',
    'multimodelCacheHome', 'xdgConfigHome', 'xdgDataHome', 'xdgCacheHome', 'xdgStateHome',
    'xdgRuntimeDir', 'runtimeWrapperPath', 'codexHome']) fixture[key] = '/TEST/' + key;
  return {
    control, children, sockets, writes, timers, timerHistory, fakeProcess, rendererStarted,
    start: () => actual.startApp(fixture), release: () => releaseRenderer({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/TEST' }),
    connect: () => actual.CdpClient.connect('ws://127.0.0.1:9222/devtools/page/TEST'),
    fail: (error, client) => actual.fail(error, client), finish: error => actual.finish(error),
    fire(id) { const callback = timers.get(id); assert.equal(typeof callback, 'function'); timers.delete(id); callback(); },
    receipt() {
      const value = writes.filter(line => line.startsWith('CREATE_PAGE_PROCESS_DIAGNOSTIC ')).at(-1);
      return value ? JSON.parse(value.slice('CREATE_PAGE_PROCESS_DIAGNOSTIC '.length)) : null;
    },
  };
}

test('process diagnostics retain a late original launcher exit after startup and a newer launch', async () => {
  const h = processFailureHarness();
  const first = await h.start();
  assert.equal(first.port, 9222); assert.equal(first.inspectorWebSocketDebuggerUrl, 'ws://127.0.0.1:45550/abcdef');
  const oldClient = await h.connect();
  await h.start();
  h.control.now = 1200; h.children[0].emit('exit', 3221225477, null);
  h.control.now = 1300; h.sockets[0].emit('close');
  await h.finish(new Error('TEST read retained lifecycle'));
  const receipt = h.receipt(); assert.ok(receipt, 'late process facts must survive the already-settled startup race');
  assert.deepEqual(receipt.events.map(value => [value.event, value.launch]),
    [['launcher-spawn', 1], ['launcher-spawn', 2], ['launcher-exit', 1], ['cdp-close', 1]]);
  assert.deepEqual(receipt.events[2], { event: 'launcher-exit', launch: 1, at: 1200, code: 3221225477, signal: null });
  assert.equal(receipt.events[3].pendingCount, 0); assert.equal(oldClient.pending.size, 0);
  assert.equal(h.control.processReads, 4); assert.equal(h.timerHistory.length, 0);
});

test('process diagnostics preserve the original startup-exit rejection and do not add an error handler', async () => {
  const h = processFailureHarness({ holdRenderer: true });
  const starting = h.start(); const result = starting.catch(error => error);
  await h.rendererStarted;
  h.children[0].emit('exit', null, 'SIGTERM');
  const error = await result;
  assert.match(error.message, /^pnpm dev:mcp exited before CDP was ready \(SIGTERM\)/);
  h.release(); await h.finish(error);
  const receipt = h.receipt(); assert.ok(receipt);
  assert.equal(receipt.events.at(-1).signal, 'SIGTERM'); assert.equal(h.children[0].listenerCount('error'), 0);

  const live = processFailureHarness(); await live.start();
  const original = Object.assign(new Error('TEST private spawn path must not be projected'), { code: 'ENOENT' });
  let accessorReads = 0;
  Object.defineProperty(original, 'path', { get() { accessorReads++; throw new Error('TEST forbidden path read'); } });
  assert.throws(() => live.children[0].emit('error', original), value => value === original);
  assert.equal(live.children[0].listenerCount('error'), 0); assert.equal(accessorReads, 0);
  await live.finish(original);
  assert.deepEqual(live.receipt().events.at(-1), { event: 'launcher-error', launch: 1, at: 1000, code: 'ENOENT' });
  assert.equal(JSON.stringify(live.receipt()).includes('private spawn'), false);
});

test('process diagnostics retain pending method names while preserving CDP close errors and command timers', async () => {
  const h = processFailureHarness(); await h.start(); const client = await h.connect();
  const originals = [], pending = [];
  for (let i = 0; i < 10; i++) {
    const method = i === 0 ? 'Runtime.evaluate' : i === 1 ? 'Input.dispatchMouseEvent' : 'TEST private method ' + i;
    pending.push(client.send(method, { expression: 'TEST private renderer input' }).catch(error => error));
    const entry = client.pending.get(client.nextId), reject = entry.reject;
    entry.reject = error => { originals.push(error); reject(error); };
  }
  h.control.now = 1500; h.sockets[0].emit('close');
  const errors = await Promise.all(pending);
  assert.equal(client.pending.size, 0); assert.equal(h.timers.size, 0);
  errors.forEach((error, index) => { assert.equal(error, originals[index]); assert.equal(error.message, 'CDP connection closed'); });
  assert.equal(h.sockets[0].frames.length, 10);
  assert.ok(h.timerHistory.every(value => value.ms === 30000));
  await h.finish(errors[0]);
  const receipt = h.receipt(); assert.ok(receipt);
  const closed = receipt.events.find(value => value.event === 'cdp-close');
  assert.equal(closed.pendingCount, 10); assert.equal(closed.pendingMethodsCapped, true);
  assert.deepEqual(closed.pendingMethods, ['Runtime.evaluate', 'Input.dispatchMouseEvent', null, null, null, null, null, null]);
  assert.equal(JSON.stringify(receipt).includes('private'), false);

  const afterClose = client.send('Runtime.evaluate').catch(error => error);
  assert.equal(client.pending.size, 1, 'observation must not add a new closed-socket refusal path');
  const timer = h.timerHistory.at(-1); assert.equal(timer.ms, 30000);
  h.fire(timer.id);
  assert.equal((await afterClose).message, 'CDP command timed out: Runtime.evaluate');
  assert.equal(client.pending.size, 0); assert.equal(h.sockets[0].frames.length, 11);
});

test('process diagnostics order the original failure before secondary dump and cleanup without replacing it', async () => {
  const h = processFailureHarness(); await h.start();
  const original = new Error('CDP connection closed'), secondary = new Error('CDP command timed out: Runtime.evaluate');
  h.control.onCleanup = () => { h.control.now = 1800; h.children[0].emit('exit', 3221225477, null); };
  let dumpCalls = 0;
  const client = { async evaluate() { dumpCalls++; h.control.now = 1700; throw secondary; } };
  await assert.rejects(h.fail(original, client), value => value === original);
  await h.finish(original);
  const receipt = h.receipt(); assert.ok(receipt);
  assert.deepEqual(receipt.events.map(value => value.event),
    ['launcher-spawn', 'primary-failure', 'cleanup-started', 'launcher-exit']);
  assert.deepEqual(receipt.events[1], { event: 'primary-failure', launch: 1, at: 1000, kind: 'cdp-closed', method: null });
  assert.equal(receipt.events[2].at, 1700); assert.equal(receipt.events[3].at, 1800);
  assert.equal(dumpCalls, 1); assert.equal(h.control.screenshots, 1); assert.equal(h.control.cleanupCalls, 1);
  assert.ok(h.writes.some(value => value.startsWith('Renderer dump failed: Error: CDP command timed out: Runtime.evaluate')));
  assert.equal(h.fakeProcess.exitCode, 1);
});

test('process diagnostics preserve the original failure and cleanup aggregate identities', async () => {
  const h = processFailureHarness(); await h.start();
  const primary = new Error('TEST original work'), cleanup = new Error('TEST original cleanup');
  h.control.cleanupError = cleanup;
  let result;
  await assert.rejects(h.fail(primary, { async evaluate() { throw new Error('TEST diagnostic-only failure'); } }), error => {
    result = error;
    return error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup;
  });
  await h.finish(result);
  assert.equal(h.control.cleanupCalls, 1); assert.equal(h.receipt().events[1].kind, 'other');
  assert.equal(h.fakeProcess.exitCode, 1);
});

test('process diagnostics stay bounded and observational when clocks or sinks fail', async () => {
  const h = processFailureHarness(); await h.start(); await h.connect();
  for (let i = 0; i < 40; i++) h.sockets[0].emit('close');
  await h.finish(new Error('TEST retained bounded events'));
  const receipt = h.receipt(); assert.ok(receipt);
  assert.equal(receipt.events.length, 16); assert.equal(receipt.eventsCapped, true);
  assert.equal(receipt.recordingFailed, false); assert.ok(JSON.stringify(receipt).length <= 8192);
  assert.equal(h.timerHistory.length, 0); assert.equal(h.sockets[0].frames.length, 0);

  const broken = processFailureHarness(); await broken.start();
  broken.control.failClock = true; broken.control.failDiagnosticWrite = true;
  const original = new Error('TEST same original error');
  await assert.rejects(broken.fail(original, { async evaluate() { throw new Error('TEST secondary dump'); } }), error => error === original);
  await broken.finish(original);
  assert.equal(broken.fakeProcess.exitCode, 1); assert.equal(broken.control.cleanupCalls, 1);
  assert.equal(broken.writes.some(value => value.includes('TEST same original error')), true);
});
