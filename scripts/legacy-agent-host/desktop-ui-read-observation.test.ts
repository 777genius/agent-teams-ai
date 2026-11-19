import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import { createDesktopOriginalActionReadTiming } from './desktop-ui-read-observation.ts';

test('opt-in read timing separates original owner and evaluate costs without retaining values', async (t) => {
  let wall = 1000, mono = 10, reads = 0;
  t.mock.method(Date, 'now', () => wall);
  const logs: unknown[] = [], order: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => logs.push(args));
  const offered = { privateValue: 'PRIVATE_RESULT' };
  const trace = createDesktopOriginalActionReadTiming(() => mono);
  const ui = createDesktopUiControls({
    async evaluate() {
      order.push('evaluate'); wall += 7; mono += 7;
      return ++reads === 1 ? false : offered;
    },
    async send() { throw new Error('No input belongs to a read'); },
  }, { assertOwnedRenderer() { order.push('owner'); wall += 3; mono += 3; }, step() { assert.fail('No new step'); } });
  const value = await ui.waitRead('PRIVATE_EXPRESSION', 'PRIVATE_LABEL', 1000, Boolean, undefined,
    'initial', trace.openTeam.reads.initial);
  assert.equal(value, offered);
  assert.deepEqual(order, ['owner', 'evaluate', 'owner', 'evaluate']);
  assert.deepEqual(logs, []);
  const phase = trace.data.actions[0].reads[0];
  assert.equal(phase.waitCalls, 1);
  assert.equal(phase.firstDeadlineMs, 2000);
  assert.equal(phase.lastDeadlineMs, 2000);
  assert.equal(phase.firstCheckAtMs, 1000);
  assert.equal(phase.lastCheckAtMs, 1020);
  assert.equal(phase.firstCheckMonoMs, 10);
  assert.equal(phase.lastCheckMonoMs, 30);
  assert.deepEqual(phase.owner, { started: 2, resolved: 2, firstStartMs: 10, lastStartMs: 20,
    lastEndMs: 23, totalMs: 6, maxMs: 3 });
  assert.deepEqual(phase.evaluate, { started: 2, resolved: 2, firstStartMs: 13, lastStartMs: 23,
    lastEndMs: 30, totalMs: 14, maxMs: 7 });
  assert.equal(JSON.stringify(trace.data).includes('PRIVATE'), false);
  assert.equal(trace.data.actions[1].reads[0].waitCalls, 0);
});

test('opt-in owner exhaustion still performs the original read and rejects its late value untouched', async (t) => {
  let wall = 0, mono = 0, clockChecks = 0, inspections = 0, predicates = 0;
  t.mock.method(Date, 'now', () => { clockChecks++; return wall; });
  const rows: string[] = [], order: string[] = [];
  t.mock.method(console, 'log', (row: string) => rows.push(row));
  const late = Object.defineProperties({}, {
    x: { get() { inspections++; throw new Error('PRIVATE_LATE_VALUE'); } },
    toJSON: { get() { inspections++; throw new Error('PRIVATE_SERIALIZATION'); } },
  });
  const trace = createDesktopOriginalActionReadTiming(() => mono);
  const ui = createDesktopUiControls({
    async evaluate() { order.push('evaluate'); mono += 5; return late; },
    async send() { assert.fail('No input after deadline'); },
  }, { assertOwnedRenderer() { order.push('owner'); wall = 10; mono = 10; }, step() { assert.fail('No new step'); } });
  await assert.rejects(ui.waitRead('PRIVATE_EXPRESSION', 'original target', 10,
    () => { predicates++; return true; }, undefined, 'initial', trace.openTeam.reads.initial),
  /UI read timed out: original target; no mutation retry/);
  assert.deepEqual(order, ['owner', 'evaluate']);
  assert.equal(clockChecks, 3);
  assert.equal(inspections, 0);
  assert.equal(predicates, 0);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0]!), { kind: 'TEST_DESKTOP_READ_WAIT', read: {
    phase: 'initial', boundary: 'evaluate', cutoff: 'after-evaluate', firstCheckAtMs: 0, lastCheckAtMs: 10,
    ownerStarted: 1, ownerResolved: 1, preparationStarted: 0, preparationResolved: 0,
    readsStarted: 1, readsResolved: 1, postReadLate: 1, contextRetries: 0, deadlineMs: 10,
  } });
  assert.equal(trace.data.actions[0].reads[0].evaluate.resolved, 1);
  assert.equal(JSON.stringify(trace.data).includes('PRIVATE'), false);
});

test('opt-in clock failure cannot replace an original owner refusal or add a reporting clock read', async (t) => {
  let wallReads = 0, monoReads = 0;
  t.mock.method(Date, 'now', () => { wallReads++; return 0; });
  t.mock.method(console, 'log', () => undefined);
  const original = new Error('PRIVATE_OWNER_REFUSAL');
  const trace = createDesktopOriginalActionReadTiming(() => { monoReads++; throw new Error('PRIVATE_CLOCK'); });
  const ui = createDesktopUiControls({ async evaluate() { assert.fail('Owner refused'); },
    async send() { assert.fail('Owner refused'); } },
  { assertOwnedRenderer() { throw original; }, step() { assert.fail('No new step'); } });
  await assert.rejects(ui.waitRead('PRIVATE_EXPRESSION', 'owner', 10, Boolean, undefined,
    'initial', trace.openLaunch.reads.initial), (error) => error === original);
  assert.equal(wallReads, 2);
  assert.equal(monoReads, 1);
  assert.equal(trace.data.actions[1].reads[0].overflow, true);
  assert.equal(JSON.stringify(trace.data).includes('PRIVATE'), false);
});

test('a failed recorder write cannot replace an original transport refusal', async (t) => {
  t.mock.method(Date, 'now', () => 0);
  t.mock.method(console, 'log', () => undefined);
  const original = new Error('PRIVATE_TRANSPORT_REFUSAL');
  const trace = createDesktopOriginalActionReadTiming(() => 1);
  Object.freeze(trace.data.actions[0].reads[0].owner);
  const ui = createDesktopUiControls({ async evaluate() { throw original; },
    async send() { assert.fail('No input'); } }, { assertOwnedRenderer() {}, step() { assert.fail('No step'); } });
  await assert.rejects(ui.waitRead('PRIVATE_EXPRESSION', 'transport', 10, Boolean, undefined,
    'initial', trace.openTeam.reads.initial), (error) => error === original);
  assert.equal(trace.data.actions[0].reads[0].overflow, true);
  assert.equal(trace.data.actions[0].reads[0].evaluate.started, 1);
  assert.equal(trace.data.actions[0].reads[0].evaluate.resolved, 0);
});

test('opt-in action spans keep the original sends, owner/read order, steps and microtasks', async (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const perform = async (enabled: boolean) => {
    let mono = 0, clockCalls = 0;
    const trace = createDesktopOriginalActionReadTiming(() => { clockCalls++; return mono; });
    const order: unknown[] = [], steps: unknown[] = [];
    const ui = createDesktopUiControls({
      async evaluate(expression) { order.push(['read', expression]); mono += 7; return { x: 10, y: 20 }; },
      async send(method, params) {
        order.push(['send', method, params]);
        mono += method === 'Page.bringToFront' ? 4 : params?.type === 'mouseMoved' ? 6 : params?.type === 'mousePressed' ? 8 : 10;
        queueMicrotask(() => order.push(['send microtask', method, params?.type]));
      },
    }, { assertOwnedRenderer() { order.push(['owner']); mono += 3; }, step(value) { steps.push(value); } });
    await ui.clickExpression('PRIVATE_TARGET()', 'PRIVATE_ACTION', undefined, undefined, undefined,
      enabled ? trace.openLaunch : undefined);
    return { trace, order, steps, clockCalls };
  };
  const before = await perform(false), after = await perform(true);
  assert.equal(before.clockCalls, 0);
  assert.deepEqual(after.order, before.order);
  assert.deepEqual(after.steps, before.steps);
  const action = after.trace.data.actions[1];
  assert.equal(action.originalDeadlineMs, 31000);
  assert.equal(action.deadlineRecordedMonoMs, 4);
  assert.equal(action.bringToFront.totalMs, 4);
  assert.equal(action.postInitialOwner.totalMs, 3);
  assert.equal(action.hoverDispatch.totalMs, 6);
  assert.equal(action.pressDispatch.totalMs, 8);
  assert.equal(action.releaseDispatch.totalMs, 10);
  assert.deepEqual(action.reads.map((phase) => phase.waitCalls), [1, 1, 2]);
  assert.equal(JSON.stringify(after.trace.data).includes('PRIVATE'), false);
});

test('an original uncertain press is never replayed and retains no acknowledgment', async (t) => {
  t.mock.method(Date, 'now', () => 0);
  const original = new Error('PRIVATE_PRESS_REFUSAL'), sends: unknown[] = [];
  let mono = 0;
  const trace = createDesktopOriginalActionReadTiming(() => mono++);
  const ui = createDesktopUiControls({
    async evaluate() { return { x: 10, y: 20 }; },
    async send(method, params) { sends.push(params?.type ?? method); if (params?.type === 'mousePressed') throw original; },
  }, { assertOwnedRenderer() {}, step() {} });
  await assert.rejects(ui.clickExpression('PRIVATE_TARGET()', 'press', undefined, undefined, undefined,
    trace.openLaunch), (error) => error === original);
  assert.deepEqual(sends, ['Page.bringToFront', 'mouseMoved', 'mousePressed']);
  assert.equal(trace.data.actions[1].pressDispatch.started, 1);
  assert.equal(trace.data.actions[1].pressDispatch.resolved, 0);
  assert.equal(trace.data.actions[1].releaseDispatch.started, 0);
});

test('fixed slots saturate counters and preserve the compact and pretty receipt limits', () => {
  let mono = 0;
  const trace = createDesktopOriginalActionReadTiming(() => mono++);
  for (const controller of [trace.openTeam, trace.openLaunch]) {
    for (const operation of ['bringToFront', 'postInitialOwner', 'hoverDispatch', 'pressDispatch', 'releaseDispatch'] as const) {
      for (let index = 0; index < 4097; index++) { controller.start(operation); controller.end(operation); }
    }
    for (const phase of ['initial', 'after-hover', 'stable'] as const) {
      const reader = controller.reads[phase];
      reader.begin(1000);
      for (const operation of ['owner', 'evaluate'] as const) {
        for (let index = 0; index < 4097; index++) { reader.start(operation); reader.end(operation); }
      }
      for (let index = 0; index < 4097; index++) reader.begin(1000);
    }
  }
  assert.equal(trace.data.actions.length, 2);
  for (const action of trace.data.actions) {
    assert.equal(action.reads.length, 3);
    assert.equal(action.overflow, true);
    assert.equal(action.bringToFront.started, 4096);
    for (const phase of action.reads) {
      assert.equal(phase.waitCalls, 4096);
      assert.equal(phase.owner.started, 4096);
      assert.equal(phase.owner.resolved, 4096);
      assert.equal(phase.overflow, true);
    }
  }
  const before = mono;
  trace.openTeam.start('bringToFront'); trace.openTeam.reads.initial.check(1000);
  assert.equal(mono, before, 'a saturated slot stops collecting detail');
  const maximum = JSON.parse(JSON.stringify(trace.data)) as Record<string, unknown>;
  const widen = (value: Record<string, unknown>): void => {
    for (const [key, entry] of Object.entries(value)) {
      if (Array.isArray(entry)) entry.forEach((item) => widen(item as Record<string, unknown>));
      else if (entry && typeof entry === 'object') widen(entry as Record<string, unknown>);
      else if (key !== 'schemaVersion' && (entry === null || typeof entry === 'number'))
        value[key] = ['started', 'resolved', 'waitCalls'].includes(key) ? 4096 : Number.MAX_SAFE_INTEGER;
    }
  };
  widen(maximum);
  assert.ok(Buffer.byteLength(JSON.stringify(maximum)) <= 8192);
  assert.ok(Buffer.byteLength(JSON.stringify(maximum, null, 2)) <= 16384);
});

test('unavailable clocks and duration saturation remain finite and observational', () => {
  for (const value of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const trace = createDesktopOriginalActionReadTiming(() => value);
    trace.openTeam.start('bringToFront');
    assert.equal(trace.data.actions[0].overflow, true);
    assert.equal(trace.data.actions[0].bringToFront.started, 0);
  }
  let mono = 0;
  const trace = createDesktopOriginalActionReadTiming(() => mono);
  trace.data.actions[0].bringToFront.totalMs = Number.MAX_SAFE_INTEGER - 1;
  trace.openTeam.start('bringToFront'); mono = 2; trace.openTeam.end('bringToFront');
  assert.equal(trace.data.actions[0].bringToFront.totalMs, Number.MAX_SAFE_INTEGER);
  assert.equal(trace.data.actions[0].overflow, true);
  const retained = JSON.stringify(trace.data);
  trace.openTeam.start('bringToFront'); trace.openTeam.end('bringToFront');
  assert.equal(JSON.stringify(trace.data), retained);
});
