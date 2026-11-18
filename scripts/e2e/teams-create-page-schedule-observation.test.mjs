import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

import { observeScheduleTeamSelection, scheduleOptionObservationSource } from './teams-create-page-schedule-observation.mjs';

const teamName = 'teams-create-page-e2e-test';
function fixture({ setupFailure = false, clickFailure = null, waitFailure = null, readFailure = false } = {}) {
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
  const browser = {}, renderer = createContext({ window: browser, document, element: option, target: { x: 50, y: 30 } });
  const client = {
    async click(expression, task, observedTeam) {
      calls.push({ kind: 'click', expression, task, observedTeam });
      runInContext(scheduleOptionObservationSource(observedTeam), renderer);
      if (clickFailure) throw clickFailure;
      for (const kind of ['pointerdown', 'pointerup', 'click']) for (const capture of [true, false]) {
        for (const row of [...listeners]) if (row.kind === kind && row.capture === capture)
          row.listener({ target: option, clientX: 50, clientY: 30, isTrusted: true, defaultPrevented: false });
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
      snapshot = await runInContext(expression, renderer);
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
