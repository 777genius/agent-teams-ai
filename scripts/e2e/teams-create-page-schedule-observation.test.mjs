import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

import { observeScheduleTeamSelection, scheduleOptionObservationSource } from './teams-create-page-schedule-observation.mjs';

const teamName = 'teams-create-page-e2e-test';
function fixture({ setupFailure = false, clickFailure = null, waitFailure = null, readFailure = false,
  beforeEvents = () => {}, eventCycles = 1 } = {}) {
  const listeners = [], calls = [], options = [];
  let registrations = 0, selected = false, removed = 0, snapshot;
  const option = {
    tagName: 'DIV', isConnected: true, parentElement: null,
    contains(node) { return node === this; },
    getAttribute(name) { return ({ 'data-value': teamName, role: 'option', 'aria-disabled': 'false', 'aria-selected': 'true' })[name] ?? null; },
    getAnimations() { return []; },
    getBoundingClientRect() { return { left: 10, top: 20, width: 80, height: 20 }; },
  };
  const trigger = {
    tagName: 'BUTTON', isConnected: true,
    get textContent() { return selected ? teamName : 'Select a team...'; },
    getAttribute(name) { return name === 'aria-controls' ? 'TEST-popup' : name === 'aria-expanded' ? String(!selected) : null; },
    matches() { return false; }, contains(node) { return node === this; },
  };
  const popup = { contains(node) { return node === option; } };
  const dialog = { contains(node) { return node === trigger; } };
  const document = {
    visibilityState: 'visible', activeElement: trigger,
    querySelector(selector) { return selector.includes('#schedule-label') ? { closest: () => dialog } : trigger; },
    getElementById(id) { return id === 'TEST-popup' ? popup : null; },
    elementFromPoint() { return option; }, hasFocus() { return true; },
    addEventListener(kind, listener, opts) {
      options.push(opts);
      if (setupFailure && ++registrations === 4) throw new Error('TEST setup failure');
      listeners.push({ kind, listener, capture: opts.capture });
    },
    removeEventListener(kind, listener, opts) {
      const index = listeners.findIndex(row => row.kind === kind && row.listener === listener && row.capture === opts.capture);
      if (index >= 0) { listeners.splice(index, 1); removed++; }
    },
  };
  const browser = { scrollX: 0, scrollY: 0, innerWidth: 1024, innerHeight: 674 };
  const event = { target: option, clientX: 50, clientY: 30, isTrusted: true, defaultPrevented: false };
  const renderer = createContext({ window: browser, document, element: option, target: { x: 50, y: 30 } });
  const client = {
    async click(expression, task, observedTeam) {
      calls.push({ kind: 'click', expression, task, observedTeam });
      runInContext(scheduleOptionObservationSource(observedTeam), renderer);
      if (clickFailure) throw clickFailure;
      beforeEvents({ option, trigger, popup, document, browser, event });
      for (let cycle = 0; cycle < eventCycles; cycle++) for (const kind of ['pointerdown', 'pointerup', 'click']) for (const capture of [true, false]) {
        for (const row of [...listeners]) if (row.kind === kind && row.capture === capture)
          row.listener(event);
      }
      selected = true;
    },
    async waitFor(expression, label, timeoutMs) {
      calls.push({ kind: 'wait', expression, label, timeoutMs });
      if (waitFailure) throw waitFailure;
    },
    async evaluate(expression) {
      calls.push({ kind: 'read' });
      if (readFailure) throw new Error('TEST read unavailable');
      // CDP returnByValue crosses the renderer's realm as JSON data.
      snapshot = JSON.parse(JSON.stringify(await runInContext(expression, renderer)));
      return snapshot;
    },
  };
  return { client, calls, options, listeners, browser, get removed() { return removed; }, get snapshot() { return snapshot; } };
}

test('actual schedule observer preserves one selection and original wait, then removes every passive listener', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const f = fixture();
  await observeScheduleTeamSelection(f.client, teamName);
  assert.equal(f.calls.filter(row => row.kind === 'click').length, 1);
  assert.equal(f.calls[0].task, null);
  assert.equal(f.calls[0].observedTeam, teamName);
  assert.equal(f.calls[1].timeoutMs, 45_000);
  assert.equal(f.calls[1].label, 'saved prompt acknowledgement for the exact fixture team visible before Save');
  assert.equal(f.snapshot.setup, 'armed');
  assert.equal(f.snapshot.finished, 'success');
  assert.equal(f.snapshot.events.length, 6);
  assert.ok(f.snapshot.events.every(row => row.trusted && row.targetSameOption && row.targetInOption));
  assert.equal(f.snapshot.before.state.triggerTextMatches, false);
  assert.equal(f.snapshot.after.state.triggerTextMatches, true);
  assert.equal(f.snapshot.before.optionInTriggerPopup, true);
  assert.equal(f.snapshot.cleanupComplete, true);
  assert.equal(f.removed, 6); assert.equal(f.listeners.length, 0);
  assert.ok(f.options.every(option => option.passive === true));
});

test('actual passive events retain the changed hit after the final sample without retrying the failed selection', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const original = new Error('TEST original exact-team acknowledgement failure');
  const f = fixture({ waitFailure: original, beforeEvents({ option, popup, document, event }) {
    const scroller = { parentElement: null, scrollTop: 44, scrollLeft: 0, scrollHeight: 300, clientHeight: 100 };
    option.parentElement = scroller;
    option.getBoundingClientRect = () => ({ left: 10, top: -24, width: 80, height: 20 });
    const foreign = { tagName: 'DIV', isConnected: true, parentElement: scroller,
      textContent: 'PRIVATE foreign team text',
      getAttribute(name) { return name === 'role' ? 'option' : 'PRIVATE foreign attribute'; },
      getBoundingClientRect() { return { left: 10, top: 20, width: 80, height: 20 }; } };
    popup.contains = node => node === option || node === foreign;
    document.elementFromPoint = () => foreign;
    event.target = foreign;
  } });
  await assert.rejects(observeScheduleTeamSelection(f.client, teamName), error => error === original);
  assert.deepEqual(f.calls.map(call => call.kind), ['click', 'wait', 'read']);
  assert.equal(f.calls[1].timeoutMs, 45_000);
  assert.equal(f.snapshot.before.geometry.hitInOption, true);
  assert.equal(f.snapshot.before.geometry.top, 20);
  const captured = f.snapshot.events.filter(event => event.phase === 'capture');
  assert.deepEqual(captured.map(event => event.kind), ['pointerdown', 'pointerup', 'click']);
  for (const event of captured) {
    assert.equal(event.trusted, true);
    assert.equal(event.hitInOption, false);
    assert.deepEqual(event.layout.intended.box, [10, -24, 80, 20]);
    assert.deepEqual(event.layout.target.box, [10, 20, 80, 20]);
    assert.equal(event.layout.target.connected, true);
    assert.equal(event.layout.target.intended, false);
    assert.equal(event.layout.target.inPopup, true);
    assert.notEqual(event.layout.target.id, event.layout.intended.id);
    assert.equal(event.layout.target.id, event.layout.hit.id);
    assert.equal(event.layout.target.item, event.layout.target.id);
    assert.equal(event.layout.scroll.intended.rows[0][2], 44);
    assert.deepEqual(event.layout.scroll.viewport, [0, 0, 1024, 674]);
  }
  assert.ok(f.snapshot.events.filter(event => event.phase === 'bubble').every(event => event.layout === null));
  assert.equal(new Set(captured.map(event => event.layout.target.id)).size, 1);
  assert.equal(JSON.stringify(f.snapshot).includes('PRIVATE'), false);
  assert.equal(f.snapshot.cleanupComplete, true);
  assert.equal(f.listeners.length, 0);
});

test('event facts distinguish an outside overlay from a different dispatch target without adopting either', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const f = fixture({ beforeEvents({ document, event }) {
    const target = { tagName: 'SPAN', isConnected: false, parentElement: null,
      getBoundingClientRect: () => ({ left: 1, top: 2, width: 3, height: 4 }) };
    const overlay = { tagName: 'DIV', isConnected: true, parentElement: null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1024, height: 674 }) };
    event.target = target;
    document.elementFromPoint = () => overlay;
  } });
  await observeScheduleTeamSelection(f.client, teamName);
  const event = f.snapshot.events[0];
  assert.notEqual(event.layout.target.id, event.layout.hit.id);
  assert.equal(event.layout.target.connected, false);
  assert.equal(event.layout.hit.connected, true);
  assert.equal(event.layout.target.item, null);
  assert.equal(event.layout.hit.item, null);
  assert.equal(event.layout.target.intended, null);
  assert.equal(event.layout.hit.inPopup, false);
  assert.deepEqual(event.layout.hit.box, [0, 0, 1024, 674]);
  assert.deepEqual(f.calls.map(call => call.kind), ['click', 'wait', 'read']);
  assert.equal(f.snapshot.finished, 'success', 'Diagnostics cannot redefine the original acknowledgement');
});

test('throwing or malformed event layout reads leave the original error and passive cleanup intact', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const original = new Error('TEST original acknowledgement');
  const f = fixture({ waitFailure: original, beforeEvents({ option, document, event }) {
    option.getBoundingClientRect = () => { throw new Error('TEST geometry unavailable'); };
    Object.defineProperty(option, 'scrollTop', { get() { throw new Error('TEST scroll unavailable'); } });
    const foreign = { tagName: 'DIV', isConnected: true, parentElement: null,
      getBoundingClientRect: () => ({ left: Infinity, top: 1_000_001, width: NaN, height: 20 }) };
    document.elementFromPoint = () => foreign;
    event.target = foreign;
  } });
  await assert.rejects(observeScheduleTeamSelection(f.client, teamName), error => error === original);
  assert.equal(f.snapshot.events[0].layout.intended.box, null);
  assert.equal(f.snapshot.events[0].layout.scroll.intended, null);
  assert.deepEqual(f.snapshot.events[0].layout.hit.box, [null, null, null, 20]);
  assert.equal(f.snapshot.cleanupComplete, true);
  assert.equal(f.listeners.length, 0);
  assert.equal(f.calls.filter(call => call.kind === 'click').length, 1);
});

test('event geometry keeps the original count and byte bounds with bounded scroll ancestry', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const f = fixture({ eventCycles: 3, beforeEvents({ option }) {
    let parent = null;
    for (let depth = 0; depth < 20; depth++) parent = { parentElement: parent,
      scrollTop: depth + 1, scrollLeft: 0, scrollHeight: 300, clientHeight: 100 };
    option.parentElement = parent;
  } });
  await observeScheduleTeamSelection(f.client, teamName);
  assert.equal(f.snapshot.events.length, 12);
  assert.equal(f.snapshot.eventsCapped, true);
  assert.equal(f.snapshot.events[0].layout.scroll.intended.rows.length, 3);
  assert.equal(f.snapshot.events[0].layout.scroll.intended.capped, true);
  assert.ok(JSON.stringify(f.snapshot).length <= 12_288);
  assert.equal(f.snapshot.cleanupComplete, true);
  assert.equal(f.listeners.length, 0);
  assert.equal(f.calls.filter(call => call.kind === 'click').length, 1);
});

test('partial observer installation cleans up and cannot prevent the original selection', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const f = fixture({ setupFailure: true });
  await observeScheduleTeamSelection(f.client, teamName);
  assert.equal(f.calls.filter(row => row.kind === 'click').length, 1);
  assert.equal(f.calls.filter(row => row.kind === 'wait').length, 1);
  assert.equal(f.snapshot.setup, 'failed');
  assert.equal(f.snapshot.cleanupAttempted, true);
  assert.equal(f.snapshot.cleanupComplete, true);
  assert.equal(f.removed, 3); assert.equal(f.listeners.length, 0);
});

test('original click and acknowledgement errors survive diagnostic failure without another input', async (t) => {
  const writes = [];
  t.mock.method(process.stderr, 'write', value => { writes.push(value); return true; });
  for (const phase of ['clickFailure', 'waitFailure']) for (const readFailure of [false, true]) {
    const original = new Error(`TEST original ${phase}`);
    const f = fixture({ [phase]: original, readFailure });
    await assert.rejects(observeScheduleTeamSelection(f.client, teamName), error => error === original);
    assert.equal(f.calls.filter(row => row.kind === 'click').length, 1);
    assert.equal(f.calls.filter(row => row.kind === 'wait').length, phase === 'clickFailure' ? 0 : 1);
    assert.equal(f.calls.filter(row => row.kind === 'read').length, 1);
    if (readFailure) {
      assert.equal(f.snapshot, undefined, 'Unavailable renderer read cannot claim cleanup');
      const logged = JSON.parse(writes.at(-1));
      assert.equal(logged.readUnavailable, true);
      assert.equal(logged.cleanupConfirmed, false);
      f.browser.__teamsScheduleOptionObservation.read(teamName, 'failure');
    } else {
      assert.equal(f.snapshot.finished, 'failure');
      assert.equal(f.snapshot.cleanupComplete, true);
    }
    assert.equal(f.listeners.length, 0);
  }
});
