import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import test from 'node:test';
import { createContext, runInContext, runInNewContext } from 'node:vm';

import { observeScheduleTeamSelection, scheduleOptionObservationSource } from './teams-create-page-schedule-observation.mjs';

const teamName = 'teams-create-page-e2e-test';
function fixture({ setupFailure = false, clickFailure = null, waitFailure = null, readFailure = false,
  beforeSetup = () => {}, beforeEvents = () => {}, eventCycles = 1 } = {}) {
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
      beforeSetup({ option, trigger, popup, document, browser, event });
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

test('passive placement distinguishes popup translation from an inserted preceding row', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  for (const translate of [true, false]) {
    let top = 20, popupTop = 10, rows;
    const original = new Error('TEST original acknowledgement');
    const f = fixture({ waitFailure: original, beforeSetup({ option, popup, trigger }) {
      rows = [option]; popup.querySelectorAll = () => rows;
      option.getBoundingClientRect = () => ({ left: 10, top, width: 80, height: 20 });
      popup.getBoundingClientRect = () => ({ left: 0, top: popupTop, width: 100, height: 100 });
      trigger.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 10 });
    }, beforeEvents() {
      top += 28;
      if (translate) popupTop += 28;
      else rows.unshift({ getBoundingClientRect: () => ({ left: 10, top: 20, width: 80, height: 28 }) });
    } });
    await assert.rejects(observeScheduleTeamSelection(f.client, teamName), error => error === original);
    const before = f.snapshot.before.placement, after = f.snapshot.events[0].layout.placement;
    assert.equal(after.popup.box[1] - before.popup.box[1], translate ? 28 : 0);
    assert.equal(after.rows.length, translate ? 1 : 2);
    assert.equal(after.rows.at(-1).id, before.rows[0].id);
    assert.equal(after.rows.at(-1).box[1] - before.rows[0].box[1], 28);
    assert.deepEqual(after.trigger, before.trigger); assert.equal(after.rowsCapped, false);
    assert.deepEqual(f.calls.map(call => call.kind), ['click', 'wait', 'read']);
    assert.equal(f.snapshot.cleanupComplete, true); assert.equal(f.listeners.length, 0);
  }
});

test('placement reads at most six rows and retains no private text or invalid numbers', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const indices = [], row = { get textContent() { throw new Error('PRIVATE text'); },
    getBoundingClientRect: () => ({ left: Infinity, top: 1_000_001, width: NaN, height: 20 }) };
  const f = fixture({ beforeSetup({ popup }) {
    popup.querySelectorAll = () => new Proxy({ length: 7 }, { get(target, key) {
      if (key === 'length') return target.length;
      const index = Number(key); assert.ok(index >= 0 && index < 6); indices.push(index); return row;
    } });
  } });
  await observeScheduleTeamSelection(f.client, teamName);
  assert.equal(indices.length, 24); assert.equal(f.snapshot.before.placement.rows.length, 6);
  assert.equal(f.snapshot.before.placement.rowsCapped, true);
  assert.deepEqual(f.snapshot.before.placement.rows[0].box, [null, null, null, 20]);
  assert.equal(JSON.stringify(f.snapshot).includes('PRIVATE'), false);
  assert.equal(f.snapshot.cleanupComplete, true); assert.equal(f.listeners.length, 0);
});

test('unavailable placement cannot alter the original failure or listener cleanup', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const original = new Error('TEST original acknowledgement');
  const f = fixture({ waitFailure: original, beforeSetup({ popup }) {
    popup.querySelectorAll = () => { throw new Error('PRIVATE query failure'); };
  } });
  await assert.rejects(observeScheduleTeamSelection(f.client, teamName), error => error === original);
  assert.equal(f.snapshot.before.placement, null); assert.equal(f.snapshot.events[0].layout.placement, null);
  assert.equal(f.snapshot.events[0].targetInOption, true); assert.equal(f.snapshot.finished, 'failure');
  assert.equal(JSON.stringify(f.snapshot).includes('PRIVATE'), false);
  assert.equal(f.snapshot.cleanupComplete, true); assert.equal(f.listeners.length, 0);
});

test('oversized placement is omitted while the original bounded event facts survive', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const f = fixture({ eventCycles: 3, beforeSetup({ popup }) {
    const rows = Array.from({ length: 6 }, () => ({
      getBoundingClientRect: () => ({ left: 999999.999, top: 999999.999, width: 999999.999, height: 999999.999 }),
    }));
    popup.querySelectorAll = () => rows;
  }, beforeEvents({ option }) {
    let parent = null;
    for (let depth = 0; depth < 20; depth++) parent = { parentElement: parent,
      scrollTop: depth + 1, scrollLeft: 0, scrollHeight: 300, clientHeight: 100 };
    option.parentElement = parent;
  } });
  await observeScheduleTeamSelection(f.client, teamName);
  assert.equal(f.snapshot.placementOmitted, true); assert.equal(f.snapshot.before.placement, undefined);
  assert.equal(f.snapshot.events.length, 12); assert.equal(f.snapshot.eventsCapped, true);
  assert.ok(f.snapshot.events.every(event => event.layout?.placement === undefined));
  assert.deepEqual(f.snapshot.events[0].layout.intended.box, [10, 20, 80, 20]);
  assert.equal(f.snapshot.events[0].layout.scroll.intended.rows.length, 3);
  assert.ok(JSON.stringify(f.snapshot).length <= 12_288);
  assert.equal(f.snapshot.cleanupComplete, true); assert.equal(f.listeners.length, 0);
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

function actualScheduleClick(options = {}) {
  const source = readFileSync(new URL('./teams-create-page-desktop.mjs', import.meta.url), 'utf8');
  const first = source.indexOf('class CdpClient {'), last = source.indexOf('\nasync function waitForProcessGroupExit(', first);
  assert.ok(first > 0 && last > first);
  const helpers = readFileSync(new URL('./teams-create-page-schedule-observation.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const c = { now: 0, frames: 0, hoverFrames: 0, hovers: 0, presses: 0, releases: 0, clicks: 0,
    referenceReleases: 0, scrolls: 0, uiMutations: 0, selected: '', open: true, moved: false,
    rect: { left: 130, top: 249, width: 753, height: 44 }, listeners: [], calls: [], writes: [],
    snapshots: [], waits: [], handles: new Map(), finalReads: 0, detached: false,
    finalPointReads: { boxes: 0, hits: 0, animations: 0 } };
  class Element {
    constructor(tagName, parentElement = null, attributes = {}) {
      this.tagName = tagName; this.parentElement = parentElement; this.attributes = attributes;
      this.isConnected = true; this.disabled = false;
    }
    contains(node) { for (; node; node = node.parentElement) if (node === this) return true; return false; }
    getAttribute(name) {
      if (this === trigger && name === 'aria-expanded') return String(c.open);
      return this.attributes[name] ?? null;
    }
    matches() { return this.disabled; }
    getAnimations() {
      if (c.finalReadActive) c.finalPointReads.animations++;
      return c.finalReadActive && c.animation ? [{ playState: 'running' }] : [];
    }
    getBoundingClientRect() {
      if (c.finalReadActive) c.finalPointReads.boxes++;
      return this.isConnected ? { ...c.rect } : { left: 0, top: 0, width: 0, height: 0 };
    }
    scrollIntoView() { c.scrolls++; }
    closest() { return this === label ? c.dialog : null; }
    click() { c.uiMutations++; throw new Error('TEST forbidden DOM click'); }
    focus() { c.uiMutations++; throw new Error('TEST forbidden focus mutation'); }
    setAttribute() { c.uiMutations++; throw new Error('TEST forbidden attribute mutation'); }
  }
  const body = new Element('BODY'), dialog = new Element('DIV', body), popup = new Element('DIV', body);
  const trigger = new Element('BUTTON', dialog, { 'aria-controls': 'TEST-popup' });
  Object.defineProperty(trigger, 'textContent', { get: () => c.selected || 'Select a team...' });
  const option = new Element('DIV', popup, { role: 'option', 'data-value': teamName, 'aria-disabled': 'false' });
  option.textContent = teamName;
  const paragraph = new Element('P', option), foreign = new Element('DIV', popup), label = new Element('INPUT', dialog);
  const review = new Element('INPUT', dialog);
  Object.assign(c, { option, trigger, popup, dialog, foreign });
  const document = {
    visibilityState: 'visible', activeElement: label, hasFocus: () => true,
    querySelectorAll() { return [c.option]; },
    querySelector(selector) {
      if (selector === '#schedule-saved-prompt-reviewed') return c.selected === teamName ? review : null;
      if (selector.includes('#schedule-label')) return label;
      if (selector === '[role=dialog]') return c.dialog;
      return c.trigger;
    },
    getElementById(id) { return id === 'TEST-popup' ? c.popup : null; },
    elementFromPoint(x, y) {
      if (c.finalReadActive) c.finalPointReads.hits++;
      const r = c.rect;
      return !c.blockedHit && option.isConnected && x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height
        ? paragraph : foreign;
    },
    addEventListener(kind, listener, config) { c.listeners.push({ kind, listener, capture: config.capture }); },
    removeEventListener(kind, listener, config) {
      const at = c.listeners.findIndex(row => row.kind === kind && row.listener === listener && row.capture === config.capture);
      if (at >= 0) c.listeners.splice(at, 1);
    },
  };
  const browser = { innerWidth: 1024, innerHeight: 674 }, renderer = createContext({ window: browser, document,
    requestAnimationFrame(callback) {
      queueMicrotask(() => {
        c.now += 16; c.frames++;
        if (c.hovers) c.hoverFrames++;
        if (options.delayedLayout && c.hovers && !c.moved && c.hoverFrames === 2) {
          c.rect.top += 100; c.moved = true;
        }
        options.onFrame?.(c);
        callback(c.now);
      });
    },
  });
  const actual = runInNewContext(`${helpers}\n${source.slice(first, last)}\n({ CdpClient, observeScheduleTeamSelection })`, {
    assert, Date: { now: () => c.now },
    setTimeout(callback, ms) { c.now += ms; queueMicrotask(callback); return 1; }, clearTimeout() {},
    process: { stderr: { write(value) { c.writes.push(value); } } },
  });
  const client = new actual.CdpClient({ on() {}, close() {} });
  const click = client.click.bind(client);
  client.click = async (...args) => {
    c.clicks++;
    const firstCall = c.calls.length;
    try { return await click(...args); }
    catch (error) { c.clickError = error; throw error; }
    finally { c.clickCalls = c.calls.slice(firstCall); }
  };
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const emit = (kind, phase, target, point) => {
    for (const row of [...c.listeners]) if (row.kind === kind && row.capture === (phase === 'capture'))
      row.listener({ target, clientX: point.x, clientY: point.y, isTrusted: true, defaultPrevented: false });
  };
  client.send = async (method, params, timeoutMs) => {
    c.calls.push({ method, params, timeoutMs, at: c.now, frame: c.frames });
    if (method === 'Runtime.releaseObject') {
      c.referenceReleases++; c.handles.delete(params.objectId);
      if (options.releaseError) throw options.releaseError;
      return {};
    }
    if (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn') {
      if (method === 'Runtime.callFunctionOn' && options.frameTimeout && params.functionDeclaration.includes('requestAnimationFrame')) {
        c.now += timeoutMs; throw options.frameTimeout;
      }
      const final = method === 'Runtime.callFunctionOn' && !params.functionDeclaration.includes('await new Promise');
      if (final) { c.finalReads++; options.beforeFinal?.(c); c.finalReadActive = true; }
      let response;
      try {
        const value = method === 'Runtime.evaluate'
          ? await runInContext(params.expression, renderer)
          : await runInContext('(' + params.functionDeclaration + ')', renderer).call(c.handles.get(params.objectId));
        if (params.returnByValue === false) {
          c.handles.set('TEST-original-target', value);
          response = { result: { type: 'object', objectId: 'TEST-original-target' } };
        } else response = { result: { value: copy(value) } };
      } catch (error) { response = { exceptionDetails: { exception: { description: error.message } } }; }
      finally { if (final) c.finalReadActive = false; }
      if (final) options.afterFinal?.(c);
      options.afterRead?.(c, method, params);
      return response;
    }
    assert.equal(method, 'Input.dispatchMouseEvent');
    if (params.type === 'mouseMoved') {
      c.hovers++; c.hoverFrames = 0;
      options.afterHover?.(c);
      if (options.hoverError) throw options.hoverError;
      return {};
    }
    if (params.type === 'mousePressed') {
      c.presses++;
      // Finite reproduction: the first pointer delivery exposes delayed placement before its hit.
      if (options.delayedLayout && !c.hovers && !c.moved) { c.rect.top += 100; c.moved = true; }
      c.pressedTarget = document.elementFromPoint(params.x, params.y);
      for (const phase of ['capture', 'bubble']) emit('pointerdown', phase, c.pressedTarget, params);
      if (options.pressError) throw options.pressError;
    } else {
      assert.equal(params.type, 'mouseReleased'); c.releases++;
      for (const phase of ['capture', 'bubble']) emit('pointerup', phase, c.pressedTarget, params);
      emit('click', 'capture', c.pressedTarget, params);
      c.selected = option.contains(c.pressedTarget) ? teamName : 'org-team-e2e-other';
      c.open = false; option.isConnected = false; document.activeElement = trigger;
      emit('click', 'bubble', c.pressedTarget, params);
    }
    return {};
  };
  const wait = client.waitFor.bind(client);
  client.waitFor = async (expression, label, timeoutMs) => {
    c.waits.push({ label, timeoutMs }); return wait(expression, label, timeoutMs);
  };
  return { c, client, async select() {
    try { await actual.observeScheduleTeamSelection(client, teamName); }
    catch (error) {
      // Preserve the original error identity while retaining first-delivery facts in RED output.
      error.finiteDelivery = { hovers: c.hovers, presses: c.presses, releases: c.releases, selected: c.selected };
      throw error;
    }
  } };
}

test('actual schedule click prepares hover and distinct render samples before its sole press after delayed layout', async () => {
  const h = actualScheduleClick({ delayedLayout: true });
  await h.select();
  assert.equal(h.c.selected, teamName); assert.equal(h.c.presses, 1); assert.equal(h.c.releases, 1);
  assert.equal(h.c.hovers, 2, 'a moved original target is hovered at its new measured position before pressing');
  assert.ok(h.c.hoverFrames >= 2, 'two different render opportunities follow the final hover');
  assert.equal(h.c.scrolls, 1); assert.equal(h.c.uiMutations, 0);
  assert.equal(h.c.referenceReleases, 1); assert.equal(h.c.handles.size, 0);
  assert.equal(h.c.waits.at(-1).timeoutMs, 45_000, 'the original exact-team saved-prompt oracle is unchanged');
  const snapshot = JSON.parse(h.c.writes.at(-1)).snapshot;
  assert.equal(snapshot.before.geometry.y, 371); assert.equal(snapshot.after.state.triggerTextMatches, true);
  assert.ok(snapshot.events.every(row => row.targetInOption)); assert.equal(snapshot.cleanupComplete, true);
  const press = h.c.calls.findIndex(row => row.method === 'Input.dispatchMouseEvent' && row.params.type === 'mousePressed');
  assert.ok(h.c.calls.slice(press).every(row => row.method !== 'Runtime.callFunctionOn' && row.params.type !== 'mouseMoved'));
});

test('actual click retains the post-final-sample 28px wrong-row failure without another input', async () => {
  const h = actualScheduleClick({ beforeFinal(c) {
    c.placementRows = [c.option]; c.popup.querySelectorAll = () => c.placementRows;
    c.foreign.attributes.role = 'option';
    c.foreign.getBoundingClientRect = () => ({ left: 130, top: 249, width: 753, height: 28 });
  }, afterFinal(c) { c.rect.top += 28; c.placementRows = [c.foreign, c.option]; } });
  await assert.rejects(h.select(), /Timed out waiting for saved prompt acknowledgement for the exact fixture team visible before Save/);
  assert.equal(h.c.presses, 1); assert.equal(h.c.releases, 1); assert.equal(h.c.hovers, 1);
  assert.equal(h.c.frames, 3); assert.equal(h.c.finalReads, 1); assert.equal(h.c.uiMutations, 0);
  assert.equal(h.c.waits.at(-1).timeoutMs, 45_000);
  const snapshot = JSON.parse(h.c.writes.at(-1)).snapshot, event = snapshot.events[0];
  assert.equal(snapshot.before.geometry.top, 249); assert.equal(event.trusted, true);
  assert.deepEqual(event.layout.intended.box, [130, 277, 753, 44]);
  assert.deepEqual(event.layout.target.box, [130, 249, 753, 28]);
  assert.equal(event.targetInOption, false); assert.equal(event.layout.target.inPopup, true);
  assert.equal(event.layout.intended.id, snapshot.before.placement.rows[0].id);
  assert.equal(snapshot.finished, 'failure'); assert.equal(snapshot.after.state.triggerTextMatches, false);
  const press = h.c.calls.findIndex(row => row.params.type === 'mousePressed');
  assert.ok(h.c.calls.slice(press).every(row => row.method !== 'Runtime.callFunctionOn' && row.params.type !== 'mouseMoved'));
  assert.equal(h.c.referenceReleases, 1); assert.equal(h.c.handles.size, 0);
  assert.equal(snapshot.cleanupComplete, true); assert.equal(h.c.listeners.length, 0);
});

test('schedule preparation refuses replacement of its original node, popup or dialog owner after hover', async () => {
  for (const key of ['option', 'popup', 'dialog', 'trigger']) {
    const h = actualScheduleClick({ afterHover(c) { c[key] = { ...c[key], isConnected: true }; } });
    await assert.rejects(h.select(), /Original schedule option or owner changed/);
    assert.equal(h.c.presses, 0); assert.equal(h.c.releases, 0);
    assert.equal(h.c.referenceReleases, 1); assert.equal(h.c.handles.size, 0);
  }
});

test('schedule final sample refuses geometry or owner mutation instead of rehovering or clicking', async () => {
  for (const [stage, mutate] of [
    ['geometry-equality', c => { c.rect.top += 1; }],
    ['owner-before-geometry', c => { c.popup = { ...c.popup }; }],
  ]) {
    const h = actualScheduleClick({ beforeFinal: mutate });
    await assert.rejects(h.select(), /Original schedule option (geometry|or owner) changed/);
    assert.equal(h.c.finalReads, 1); assert.equal(h.c.hovers, 1);
    assert.equal(h.c.presses, 0); assert.equal(h.c.releases, 0); assert.equal(h.c.referenceReleases, 1);
    assert.equal(h.c.frames, 3); assert.equal(h.c.uiMutations, 0);
    const snapshot = JSON.parse(h.c.writes.at(-1)).snapshot;
    assert.equal(snapshot.setup, 'refused-before-press'); assert.equal(snapshot.finished, 'failure');
    assert.equal(snapshot.refusal.stage, stage); assert.deepEqual(snapshot.events, []);
    assert.deepEqual(snapshot.refusal.expected, { x: 506.5, y: 271, left: 130, top: 249, width: 753, height: 44 });
    if (stage === 'geometry-equality') {
      assert.deepEqual(snapshot.refusal.current, { x: 506.5, y: 272, left: 130, top: 250, width: 753, height: 44 });
      assert.equal(snapshot.refusal.point.stage, 'ready');
      assert.deepEqual(snapshot.refusal.point.box, [130, 250, 753, 44]);
      assert.equal(snapshot.refusal.point.hitInOption, true);
      assert.deepEqual(h.c.finalPointReads, { boxes: 1, hits: 1, animations: 3 });
    } else {
      assert.equal(snapshot.refusal.current, null); assert.equal(snapshot.refusal.point.stage, 'not-read');
      assert.deepEqual(h.c.finalPointReads, { boxes: 0, hits: 0, animations: 0 });
    }
    assert.equal(snapshot.cleanupComplete, true); assert.equal(h.c.listeners.length, 0);
  }
});

test('final schedule refusal retains failed animation, hit and bounds facts without another DOM sample', async () => {
  for (const [stage, mutate, reads] of [
    ['availability', c => { c.option.disabled = true; }, { boxes: 0, hits: 0, animations: 0 }],
    ['animation', c => { c.animation = true; }, { boxes: 0, hits: 0, animations: 1 }],
    ['geometry-admission', c => { c.blockedHit = true; }, { boxes: 1, hits: 1, animations: 3 }],
    ['geometry-admission', c => { c.rect.top = 1_000_001; }, { boxes: 1, hits: 1, animations: 3 }],
  ]) {
    const h = actualScheduleClick({ beforeFinal(c) {
      c.option.textContent = teamName + ' PRIVATE option content'; mutate(c);
    } });
    await assert.rejects(h.select(), /Original schedule option geometry changed before press/);
    const snapshot = JSON.parse(h.c.writes.at(-1)).snapshot;
    assert.equal(snapshot.refusal.stage, 'geometry-equality');
    assert.equal(snapshot.refusal.current, null); assert.equal(snapshot.refusal.point.stage, stage);
    assert.deepEqual(h.c.finalPointReads, reads);
    if (h.c.blockedHit) assert.equal(snapshot.refusal.point.hitInOption, false);
    if (h.c.rect.top > 1_000_000) assert.deepEqual(snapshot.refusal.point.box, [130, null, 753, 44]);
    assert.equal(h.c.frames, 3); assert.equal(h.c.finalReads, 1); assert.equal(h.c.hovers, 1);
    assert.equal(h.c.presses, 0); assert.equal(h.c.releases, 0); assert.equal(h.c.uiMutations, 0);
    assert.equal(h.c.referenceReleases, 1); assert.equal(h.c.handles.size, 0); assert.equal(h.c.listeners.length, 0);
    const raw = JSON.stringify(snapshot);
    assert.equal(raw.includes('PRIVATE'), false); assert.ok(raw.length < 2048);
  }
});

test('schedule preparation preserves its original absolute deadline across hover, frame and final awaits', async () => {
  for (const boundary of ['afterHover', 'onFrame', 'afterFinal']) for (const elapsed of [30_000, 30_001]) {
    const h = actualScheduleClick({ [boundary](c) { c.now = elapsed; } });
    await assert.rejects(h.select(), error => error === h.c.clickError && /E2E click target deadline/.test(error.message));
    assert.equal(h.c.clicks, 1); assert.ok(h.c.clickCalls.length > 0);
    assert.equal(h.c.presses, 0); assert.equal(h.c.releases, 0);
    assert.equal(h.c.referenceReleases, 1); assert.equal(h.c.handles.size, 0);
    // Check the real click's entire interval, including its bounded reference cleanup.
    for (const row of h.c.clickCalls) {
      if (row.method === 'Runtime.releaseObject') assert.equal(row.timeoutMs, Math.max(0, 30_000 - row.at));
      else assert.ok(row.timeoutMs > 0 && row.timeoutMs <= 30_000 - row.at, 'no new per-command preparation budget');
    }
    // The original observer reads its passive evidence after the click has already refused.
    const afterClick = h.c.calls.slice(h.c.clickCalls.length);
    assert.equal(afterClick.length, 1); assert.equal(afterClick[0].method, 'Runtime.evaluate');
    assert.match(afterClick[0].params.expression, /window\.__teamsScheduleOptionObservation\?\.read\(/);
    assert.equal(afterClick[0].at, elapsed); assert.equal(afterClick[0].timeoutMs, 30_000);
  }
});

test('a blocked render opportunity uses only the remaining original command budget and releases its reference', async () => {
  const error = new Error('TEST CDP frame timed out');
  const h = actualScheduleClick({ frameTimeout: error });
  await assert.rejects(h.select(), value => value === error);
  assert.equal(h.c.now, 30_000); assert.equal(h.c.presses, 0); assert.equal(h.c.hovers, 0);
  assert.equal(h.c.referenceReleases, 1); assert.equal(h.c.handles.size, 0);
});

test('hover and uncertain press failures retain their original error without input replay or cleanup replacement', async () => {
  for (const phase of ['hoverError', 'pressError']) {
    const original = new Error('TEST original ' + phase);
    const h = actualScheduleClick({ [phase]: original, releaseError: new Error('TEST reference release failure') });
    await assert.rejects(h.select(), value => value === original);
    assert.equal(h.c.presses, phase === 'pressError' ? 1 : 0); assert.equal(h.c.releases, 0);
    assert.equal(h.c.hovers, 1); assert.equal(h.c.referenceReleases, 1); assert.equal(h.c.handles.size, 0);
    assert.equal(h.c.uiMutations, 0);
  }
});

function actualOrganizationCreationWait({ publishedAt = Infinity, editorClosedAt = 0, wrongEntry = false } = {}) {
  const source = readFileSync(new URL('./teams-create-page-desktop.mjs', import.meta.url), 'utf8');
  const classStart = source.indexOf('class CdpClient {');
  const classEnd = source.indexOf('\nasync function waitForProcessGroupExit(', classStart);
  const label = source.indexOf("'organization team saved and editor closed'");
  const waitStart = source.lastIndexOf('    await cdp.waitFor(', label);
  const waitEnd = source.indexOf('\n    const structure =', label);
  assert.ok(classStart > 0 && classEnd > classStart && waitStart > classEnd && waitEnd > label);
  const state = { now: 0, reads: 0, timeouts: [] }, orgTeamName = 'org-team-e2e-observed';
  const teamByName = { 'org-team-e2e-foreign': { teamName: 'org-team-e2e-foreign' } };
  if (wrongEntry) teamByName[orgTeamName] = { teamName: 'org-team-e2e-foreign' };
  const document = { querySelector: () => state.now < editorClosedAt ? {} : null };
  const window = { __agentTeamsDevStore: { getState: () => ({ teamByName }) } };
  const { CdpClient, wait } = runInNewContext(
    `${source.slice(classStart, classEnd)}\n({ CdpClient, wait: async (cdp, orgTeamName) => { ${source.slice(waitStart, waitEnd)} } })`,
    { Date: { now: () => state.now }, setTimeout(callback, ms) {
      state.now += ms; queueMicrotask(callback); return 1;
    }, clearTimeout() {} }
  );
  const cdp = new CdpClient({ on() {} });
  cdp.evaluate = async expression => {
    state.reads++;
    if (state.now >= publishedAt) teamByName[orgTeamName] = { teamName: orgTeamName };
    return runInNewContext(expression, { document, window });
  };
  const originalWait = cdp.waitFor.bind(cdp);
  cdp.waitFor = (expression, waitLabel, timeoutMs) => {
    state.timeouts.push(timeoutMs); return originalWait(expression, waitLabel, timeoutMs);
  };
  return { state, wait: () => wait(cdp, orgTeamName) };
}

test('original organization Create waits for its delayed exact team-list projection before Schedules', async () => {
  const h = actualOrganizationCreationWait({ editorClosedAt: 80, publishedAt: 240, wrongEntry: true });
  await h.wait();
  assert.equal(h.state.now, 240, 'closed editor alone must not admit Schedules before the created row is published');
  assert.equal(h.state.reads, 4);
  assert.deepEqual(h.state.timeouts, [45_000], 'hydration shares the original Create completion budget');
});

test('organization Create does not accept a missing or mismatched projection, or an editor still open', async () => {
  for (const options of [{}, { wrongEntry: true }, { publishedAt: 0, editorClosedAt: Infinity }]) {
    const h = actualOrganizationCreationWait(options);
    await assert.rejects(h.wait(), /Timed out waiting for organization team saved and editor closed/);
    assert.ok(h.state.now >= 45_000 && h.state.now < 45_080);
    assert.deepEqual(h.state.timeouts, [45_000]);
  }
});
