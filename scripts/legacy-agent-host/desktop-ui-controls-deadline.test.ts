import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';

import { createDesktopUiControls, desktopAnimationFramesExpression } from './desktop-ui-controls.ts';

type Frame = { settlesAt: number; value: unknown; animationFrames?: true };
const offeredValue = { kind: 'TEST-read-value' };
const point = { x: 100, y: 100 };

async function withReadFixture(
  t: TestContext,
  frames: readonly Frame[],
  body: (fixture: {
    ui: ReturnType<typeof createDesktopUiControls>;
    expression: string;
    label: string;
    reads: string[];
    guards: number[];
    predicates: unknown[];
    ticks: number[];
    steps: Record<string, unknown>[];
    sends: { method: string; params?: Record<string, unknown> }[];
    read(timeoutMs?: number): Promise<unknown>;
  }) => Promise<void>
): Promise<void> {
  const expression = 'TEST_originalReadOnlyDeadlineTarget()';
  const label = 'TEST original generic read deadline';
  const reads: string[] = [], guards: number[] = [], predicates: unknown[] = [];
  const ticks: number[] = [], steps: Record<string, unknown>[] = [];
  const sends: { method: string; params?: Record<string, unknown> }[] = [];
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const originalSetTimeout = globalThis.setTimeout;
  try {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    t.mock.method(globalThis, 'setTimeout', (
      callback: (...args: unknown[]) => void,
      delay = 1,
      ...args: unknown[]
    ) => {
      ticks.push(delay);
      // Preserve the real original polling wait. Only the observed Date is controlled.
      const handle = originalSetTimeout(() => {
        pendingTimers.delete(handle);
        t.mock.timers.setTime(Date.now() + delay);
        callback(...args);
      }, delay);
      pendingTimers.add(handle);
      return handle;
    });
    const ui = createDesktopUiControls({
      async evaluate(actual: string) {
        const frame = frames[reads.length];
        assert.ok(frame, 'no read after the finite original observations');
        assert.equal(actual, frame.animationFrames ? desktopAnimationFramesExpression(30_000 - Date.now()) : expression,
          'only the original read or its explicitly requested remaining-budget frame observation is allowed');
        reads.push(actual);
        assert.ok(frame.settlesAt >= Date.now(), 'the fixture clock never moves backward');
        t.mock.timers.setTime(frame.settlesAt);
        return frame.value;
      },
      async send(method, params) { sends.push({ method, params }); return {}; },
    }, {
      assertOwnedRenderer() { guards.push(Date.now()); },
      step(value) { steps.push(value); },
    });
    const fixture = {
      ui, expression, label, reads, guards, predicates, ticks, steps, sends,
      read: (timeoutMs?: number) => ui.waitRead(expression, label, timeoutMs, value => {
        predicates.push(value);
        return Boolean(value);
      }),
    };
    await body(fixture);
  } finally {
    const pending = pendingTimers.size;
    t.mock.restoreAll();
    t.mock.timers.reset();
    assert.equal(pending, 0, 'every original polling timer settled before fixture release');
  }
}

const lateCases = [
  {
    title: 'generic UI read refuses its first fulfilled value exactly at the original deadline',
    frames: [{ settlesAt: 30_000, value: offeredValue }],
    predicates: [], ticks: [],
  },
  {
    title: 'generic UI read refuses its first fulfilled value after the original deadline',
    frames: [{ settlesAt: 30_001, value: offeredValue }],
    predicates: [], ticks: [],
  },
  {
    title: 'generic UI read refuses a later fulfilled value exactly at the original deadline',
    frames: [{ settlesAt: 0, value: false }, { settlesAt: 30_000, value: offeredValue }],
    predicates: [false], ticks: [100],
  },
  {
    title: 'generic UI read refuses a later fulfilled value after the original deadline',
    frames: [{ settlesAt: 0, value: false }, { settlesAt: 30_001, value: offeredValue }],
    predicates: [false], ticks: [100],
  },
  {
    title: 'generic UI read does not admit or poll again after a late false observation',
    frames: [{ settlesAt: 30_000, value: false }],
    predicates: [], ticks: [],
  },
] as const;

for (const scenario of lateCases) {
  test(scenario.title, { timeout: 5000 }, async t => {
    await withReadFixture(t, scenario.frames, async f => {
      await assert.rejects(f.read(), {
        message: 'UI read timed out: ' + f.label + '; no mutation retry',
      });
      assert.equal(f.reads.length, scenario.frames.length);
      assert.equal(f.guards.length, scenario.frames.length);
      assert.deepEqual(f.predicates, scenario.predicates, 'late values never enter readiness');
      assert.deepEqual(f.ticks, scenario.ticks, 'no extra polling after a late fulfilled read');
      assert.deepEqual(f.steps, []);
      assert.deepEqual(f.sends, []);
    });
  });
}

test('generic UI read preserves a timely first value and its exact identity', { timeout: 5000 }, async t => {
  await withReadFixture(t, [{ settlesAt: 29_999, value: offeredValue }], async f => {
    assert.equal(await f.read(), offeredValue);
    assert.equal(f.reads.length, 1);
    assert.equal(f.guards.length, 1);
    assert.deepEqual(f.predicates, [offeredValue]);
    assert.deepEqual(f.ticks, []);
    assert.deepEqual(f.steps, []);
    assert.deepEqual(f.sends, []);
  });
});

test('generic UI read preserves its original cadence and a timely later value', { timeout: 5000 }, async t => {
  await withReadFixture(t, [
    { settlesAt: 0, value: false }, { settlesAt: 101, value: offeredValue },
  ], async f => {
    assert.equal(await f.read(), offeredValue);
    assert.equal(f.reads.length, 2);
    assert.equal(f.guards.length, 2);
    assert.deepEqual(f.predicates, [false, offeredValue]);
    assert.deepEqual(f.ticks, [100]);
    assert.deepEqual(f.steps, []);
    assert.deepEqual(f.sends, []);
  });
});

test('generic UI read honors a supplied budget at its strict boundary', { timeout: 5000 }, async t => {
  for (const settlesAt of [72, 73]) {
    await withReadFixture(t, [{ settlesAt, value: offeredValue }], async f => {
      if (settlesAt === 72) assert.equal(await f.read(73), offeredValue);
      else await assert.rejects(f.read(73), {
        message: 'UI read timed out: ' + f.label + '; no mutation retry',
      });
      assert.equal(f.reads.length, 1);
      assert.equal(f.guards.length, 1);
      assert.deepEqual(f.predicates, settlesAt === 72 ? [offeredValue] : []);
      assert.deepEqual(f.ticks, []);
      assert.deepEqual(f.steps, []);
      assert.deepEqual(f.sends, []);
    });
  }
});

test('generic UI hover refuses a third stable point arriving at the original deadline', { timeout: 5000 }, async t => {
  await withReadFixture(t, [
    { settlesAt: 0, value: point },
    { settlesAt: 100, value: point },
    { settlesAt: 30_000, value: point },
  ], async f => {
    await assert.rejects(f.ui.hoverExpression(f.expression, f.label), {
      message: 'UI read timed out: ' + f.label + '; no mutation retry',
    });
    assert.equal(f.reads.length, 3);
    assert.equal(f.guards.length, 3);
    assert.deepEqual(f.ticks, [100, 100]);
    assert.deepEqual(f.steps, []);
    assert.deepEqual(f.sends, []);
  });
});

test('generic UI hover preserves one movement after three timely stable points', { timeout: 5000 }, async t => {
  await withReadFixture(t, [
    { settlesAt: 0, value: point },
    { settlesAt: 100, value: point },
    { settlesAt: 29_999, value: point },
  ], async f => {
    await f.ui.hoverExpression(f.expression, f.label);
    assert.equal(f.reads.length, 3);
    assert.equal(f.guards.length, 4, 'the original post-read ownership check remains');
    assert.deepEqual(f.ticks, [100, 100]);
    assert.deepEqual(f.steps, [{ action: 'mouseMoved', label: f.label, target: point }]);
    assert.equal(f.steps[0]!.target, point);
    assert.deepEqual(f.sends, [{
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseMoved', x: 100, y: 100 },
    }]);
  });
});

const readyClickFrames: readonly Frame[] = [
  { settlesAt: 0, value: point },
  { settlesAt: 0, value: point },
  { settlesAt: 100, value: point },
  { settlesAt: 200, value: point },
];

test('opt-in frame observation uses two actual callbacks and releases its deadline timer', async () => {
  const frames = new Map<number, () => void>(), timers = new Map<number, () => void>();
  let id = 0, settled = false;
  const pending = runInNewContext(desktopAnimationFramesExpression(1234), {
    document: { visibilityState: 'visible' },
    requestAnimationFrame(callback: () => void) { const next = ++id; frames.set(next, callback); return next; },
    cancelAnimationFrame(key: number) { frames.delete(key); },
    setTimeout(callback: () => void, delay: number) { assert.equal(delay, 1234); const next = ++id; timers.set(next, callback); return next; },
    clearTimeout(key: number) { timers.delete(key); },
  }) as Promise<boolean>;
  void pending.then(() => { settled = true; });
  const tick = () => {
    assert.equal(frames.size, 1);
    const [key, callback] = [...frames][0]!;
    frames.delete(key); callback();
  };
  tick();
  await Promise.resolve();
  assert.equal(settled, false, 'one callback cannot stand in for the two-frame observation');
  assert.equal(timers.size, 1);
  tick();
  assert.equal(await pending, true);
  assert.equal(frames.size, 0);
  assert.equal(timers.size, 0);
});

test('frame observation timeout cancels its original pending callback without accepting a late frame', async () => {
  const frames = new Map<number, () => void>(), timers = new Map<number, () => void>();
  let id = 0;
  const pending = runInNewContext(desktopAnimationFramesExpression(50), {
    document: { visibilityState: 'visible' },
    requestAnimationFrame(callback: () => void) { const next = ++id; frames.set(next, callback); return next; },
    cancelAnimationFrame(key: number) { frames.delete(key); },
    setTimeout(callback: () => void, delay: number) { assert.equal(delay, 50); const next = ++id; timers.set(next, callback); return next; },
    clearTimeout(key: number) { timers.delete(key); },
  }) as Promise<boolean>;
  const late = [...frames.values()][0]!;
  [...timers.values()][0]!();
  assert.equal(await pending, false);
  late();
  assert.equal(frames.size, 0);
  assert.equal(timers.size, 0);
});

test('frame observation refuses a hidden renderer before scheduling callbacks', async () => {
  const refused = () => assert.fail('Hidden renderer cannot schedule frame or timer work');
  assert.equal(await runInNewContext(desktopAnimationFramesExpression(50), {
    document: { visibilityState: 'hidden' }, requestAnimationFrame: refused,
    cancelAnimationFrame: refused, setTimeout: refused, clearTimeout: refused,
  }), false);
});

test('opt-in renderer frames precede the original final target lookup and exactly one click', { timeout: 5000 }, async t => {
  await withReadFixture(t, [
    ...readyClickFrames,
    { settlesAt: 250, value: true, animationFrames: true },
    { settlesAt: 251, value: point },
  ], async f => {
    await f.ui.clickExpression(f.expression, f.label, undefined, undefined, { waitForRenderFrames: true });
    assert.equal(f.reads.length, 6);
    assert.equal(f.reads.at(-1), f.expression, 'fresh original owner/geometry/hit lookup follows the frame observation');
    assert.equal(f.steps.filter(row => row.observation === 'two original renderer frames before final target read').length, 1);
    assert.deepEqual(f.sends.filter(command => ['mousePressed', 'mouseReleased'].includes(String(command.params?.type))).map(command => command.params), [
      { type: 'mousePressed', x: 100, y: 100, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 100, y: 100, button: 'left', clickCount: 1 },
    ]);
  });
});

for (const settlesAt of [30_000, 30_001]) {
  test(`opt-in frame result at ${settlesAt} cannot extend the original target deadline`, { timeout: 5000 }, async t => {
    await withReadFixture(t, [...readyClickFrames, { settlesAt, value: true, animationFrames: true }], async f => {
      await assert.rejects(f.ui.clickExpression(f.expression, f.label, undefined, undefined, { waitForRenderFrames: true }), /UI read timed out/);
      assert.equal(f.reads.length, 5, 'late frames do not admit one more target read');
      assert.equal(f.sends.some(command => command.params?.type === 'mousePressed'), false);
      assert.equal(f.sends.some(command => command.params?.type === 'mouseReleased'), false);
    });
  });
}

test('failed frame observation cannot dispatch the original click or retry the barrier', { timeout: 5000 }, async t => {
  await withReadFixture(t, [...readyClickFrames, { settlesAt: 250, value: false, animationFrames: true }], async f => {
    await assert.rejects(f.ui.clickExpression(f.expression, f.label, undefined, undefined, { waitForRenderFrames: true }), /render frames did not settle/);
    assert.equal(f.reads.length, 5);
    assert.equal(f.sends.some(command => command.params?.type === 'mousePressed'), false);
  });
});

test('a target that becomes unavailable after render frames still refuses before any click', { timeout: 5000 }, async t => {
  await withReadFixture(t, [...readyClickFrames,
    { settlesAt: 250, value: true, animationFrames: true },
    { settlesAt: 251, value: { unavailableTarget: true } },
  ], async f => {
    await assert.rejects(f.ui.clickExpression(f.expression, f.label, undefined, undefined, { waitForRenderFrames: true }), /Original UI target unavailable/);
    assert.equal(f.reads.length, 6);
    assert.equal(f.sends.some(command => command.params?.type === 'mousePressed'), false);
  });
});

test('renderer revocation during its frame observation refuses before the final read and click', { timeout: 5000 }, async () => {
  const refusal = new Error('TEST original frame owner revoked'), expression = 'TEST-original-frame-target';
  let current = true, reads = 0;
  const sends: { method: string; params?: Record<string, unknown> }[] = [];
  const ui = createDesktopUiControls({
    async evaluate(actual) {
      reads++;
      if (actual === expression) return point;
      assert.ok(actual.startsWith('new Promise(resolve => {'));
      current = false;
      return true;
    },
    async send(method, params) { sends.push({ method, params }); return {}; },
  }, { assertOwnedRenderer() { if (!current) throw refusal; }, step() {} });
  await assert.rejects(ui.clickExpression(expression, 'TEST frame owner', undefined, undefined, { waitForRenderFrames: true }), error => error === refusal);
  assert.equal(reads, 5);
  assert.equal(sends.some(command => command.params?.type === 'mousePressed'), false);
});

test('original final click waits passively for the same pending owner without repeating input', { timeout: 5000 }, async t => {
  await withReadFixture(t, [
    ...readyClickFrames,
    { settlesAt: 200, value: null },
    { settlesAt: 300, value: point },
  ], async f => {
    await f.ui.clickExpression(f.expression, f.label, undefined, undefined, { waitForFinalReadiness: true });
    assert.equal(f.reads.length, 6, 'only the same exact expression is read after pending ownership');
    assert.deepEqual(f.ticks, [100, 100, 100], 'one final passive poll uses the existing cadence');
    assert.deepEqual(f.sends, [
      { method: 'Page.bringToFront', params: undefined },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 100, y: 100 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 100, y: 100, button: 'left', clickCount: 1 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 100, y: 100, button: 'left', clickCount: 1 } },
    ], 'one original hover and one original press/release');
    assert.equal(f.steps.filter(step => step.action === 'mouseClick').length, 1);
  });
});

for (const late of [30_000, 30_001]) {
  test(`original final pending owner refuses a ready result at ${late} without extending its first-read deadline`, { timeout: 5000 }, async t => {
    await withReadFixture(t, [
      ...readyClickFrames,
      { settlesAt: 200, value: null },
      { settlesAt: late, value: point },
    ], async f => {
      await assert.rejects(f.ui.clickExpression(f.expression, f.label, undefined, undefined, { waitForFinalReadiness: true }), {
        message: 'UI read timed out: ' + f.label + ' final target; no mutation retry',
      });
      assert.equal(f.reads.length, 6, 'no extra lookup after the late original response');
      assert.deepEqual(f.ticks, [100, 100, 100]);
      assert.equal(f.sends.some(command => command.params?.type === 'mousePressed'), false);
      assert.equal(f.sends.some(command => command.params?.type === 'mouseReleased'), false);
      assert.equal(f.steps.some(step => step.action === 'mouseClick'), false);
    });
  });
}

test('original final pending owner stops at its remaining deadline without one more lookup', { timeout: 5000 }, async t => {
  await withReadFixture(t, [
    ...readyClickFrames,
    { settlesAt: 29_950, value: null },
  ], async f => {
    await assert.rejects(f.ui.clickExpression(f.expression, f.label, undefined, undefined, { waitForFinalReadiness: true }), {
      message: 'UI read timed out: ' + f.label + ' final target; no mutation retry',
    });
    assert.equal(f.reads.length, 5);
    assert.deepEqual(f.ticks, [100, 100, 50], 'only the remaining original budget can be consumed');
    assert.equal(f.sends.some(command => command.params?.type === 'mousePressed'), false);
    assert.equal(f.steps.some(step => step.action === 'mouseClick'), false);
  });
});

test('original click does not reset its first-read deadline for a later stability phase', { timeout: 5000 }, async t => {
  await withReadFixture(t, [
    { settlesAt: 29_800, value: point },
    { settlesAt: 29_800, value: point },
    { settlesAt: 29_900, value: point },
  ], async f => {
    await assert.rejects(f.ui.clickExpression(f.expression, f.label), /UI read timed out/);
    assert.equal(f.reads.length, 3, 'no second stable lookup after the initial absolute deadline');
    assert.equal(f.sends.some(command => command.params?.type === 'mousePressed'), false);
  });
});

test('original final pending owner cannot poll after its captured renderer is revoked', { timeout: 5000 }, async t => {
  const refusal = new Error('TEST original renderer ownership revoked');
  let reads = 0, current = true;
  const sends: { method: string; params?: Record<string, unknown> }[] = [];
  const expression = 'TEST_originalOwnerAndHitTestedTarget()';
  const ui = createDesktopUiControls({
    async evaluate(actual) {
      assert.equal(actual, expression);
      reads++;
      if (reads === 5) { current = false; return null; }
      assert.ok(reads < 5, 'no replacement target is observed');
      return point;
    },
    async send(method, params) { sends.push({ method, params }); return {}; },
  }, {
    assertOwnedRenderer() { if (!current) throw refusal; },
    step() {},
  });
  await assert.rejects(ui.clickExpression(expression, 'TEST original revoked owner', undefined, undefined,
    { waitForFinalReadiness: true }), error => error === refusal);
  assert.equal(reads, 5);
  assert.equal(sends.some(command => command.params?.type === 'mousePressed'), false);
  assert.equal(sends.some(command => command.params?.type === 'mouseReleased'), false);
  t.mock.restoreAll();
});

function readWaitReports(t: TestContext): { output: string[]; reads(): Record<string, unknown>[] } {
  const output: string[] = [];
  t.mock.method(console, 'log', (value: unknown) => { output.push(String(value)); });
  return { output, reads: () => output.map(value => JSON.parse(value) as Record<string, unknown>)
    .filter(value => value.kind === 'TEST_DESKTOP_READ_WAIT')
    .map(value => value.read as Record<string, unknown>) };
}

test('after-hover diagnostics retain the original late-read cutoff without another input', { timeout: 5000 }, async t => {
  const reports = readWaitReports(t);
  await withReadFixture(t, [
    { settlesAt: 0, value: point }, { settlesAt: 30_000, value: point },
  ], async f => {
    await assert.rejects(f.ui.clickExpression(f.expression, f.label), {
      message: 'UI read timed out: ' + f.label + ' after pointer enter; no mutation retry',
    });
    assert.equal(f.reads.length, 2);
    assert.equal(f.guards.length, 3);
    assert.deepEqual(f.ticks, []);
    assert.deepEqual(f.sends.map(row => row.params?.type ?? row.method), ['Page.bringToFront', 'mouseMoved']);
    assert.deepEqual(reports.reads(), [{
      phase: 'after-hover', boundary: 'evaluate', cutoff: 'after-evaluate',
      firstCheckAtMs: 0, lastCheckAtMs: 30_000,
      ownerStarted: 1, ownerResolved: 1, preparationStarted: 0, preparationResolved: 0,
      readsStarted: 1, readsResolved: 1, postReadLate: 1, contextRetries: 0, deadlineMs: 30_000,
    }]);
    assert.ok(!reports.output.join('').includes(f.label));
    assert.ok(!reports.output.join('').includes(f.expression));
  });
});

test('after-hover exhaustion reports zero new reads and cannot reset the original deadline', { timeout: 5000 }, async t => {
  const reports = readWaitReports(t), sends: string[] = [];
  let reads = 0, owners = 0;
  try {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const ui = createDesktopUiControls({
      async evaluate() { reads++; return point; },
      async send(method, params) {
        sends.push(String(params?.type ?? method));
        if (params?.type === 'mouseMoved') t.mock.timers.setTime(30_000);
        return {};
      },
    }, { assertOwnedRenderer() { owners++; }, step() {} });
    await assert.rejects(ui.clickExpression('PRIVATE-expression', 'PRIVATE-label'), /after pointer enter; no mutation retry/);
    assert.equal(reads, 1); assert.equal(owners, 2);
    assert.deepEqual(sends, ['Page.bringToFront', 'mouseMoved']);
    assert.equal(reports.reads().length, 1);
    const row = reports.reads()[0]!;
    assert.equal(row.phase, 'after-hover'); assert.equal(row.cutoff, 'loop');
    assert.equal(row.readsStarted, 0); assert.equal(row.readsResolved, 0);
    assert.equal(row.firstCheckAtMs, 30_000); assert.equal(row.lastCheckAtMs, 30_000);
    assert.equal(row.deadlineMs, 30_000);
    assert.doesNotMatch(reports.output.join(''), /PRIVATE/);
  } finally { t.mock.restoreAll(); t.mock.timers.reset(); }
});

test('read diagnostics distinguish the existing context retry from a late fulfilled observation', { timeout: 5000 }, async t => {
  const reports = readWaitReports(t), order: string[] = [], ticks: number[] = [];
  let reads = 0, predicates = 0;
  try {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    t.mock.method(globalThis, 'setTimeout', (done: () => void, delay: number) => {
      ticks.push(delay); t.mock.timers.setTime(Date.now() + delay); done();
      return {} as ReturnType<typeof setTimeout>;
    });
    const ui = createDesktopUiControls({
      async evaluate() {
        order.push('read'); reads++;
        if (reads === 1) throw new Error('Execution context was destroyed PRIVATE-message');
        t.mock.timers.setTime(30_000); return { value: 'PRIVATE-returned-value' };
      },
      async send() { assert.fail('passive read cannot dispatch'); },
    }, { assertOwnedRenderer() { order.push('owner'); }, step() { assert.fail('passive read has no action'); } });
    await assert.rejects(ui.waitRead('PRIVATE-expression', 'PRIVATE-label', 30_000, () => {
      predicates++; return true;
    }), /UI read timed out/);
    assert.deepEqual(order, ['owner', 'read', 'owner', 'read']);
    assert.deepEqual(ticks, [100]); assert.equal(predicates, 0);
    const row = reports.reads()[0]!;
    assert.equal(reports.reads().length, 1); assert.equal(row.contextRetries, 1);
    assert.equal(row.readsStarted, 2); assert.equal(row.readsResolved, 1); assert.equal(row.postReadLate, 1);
    assert.equal(row.cutoff, 'after-evaluate'); assert.equal(row.lastCheckAtMs, 30_000);
    assert.doesNotMatch(reports.output.join(''), /PRIVATE/);
  } finally { t.mock.restoreAll(); t.mock.timers.reset(); }
});

for (const boundary of ['owner', 'preparation', 'evaluate'] as const) {
  test('throwing diagnostic output preserves the exact original ' + boundary + ' refusal', { timeout: 5000 }, async t => {
    const refusal = new Error('PRIVATE-original-' + boundary), order: string[] = [];
    let reports = 0;
    try {
      t.mock.timers.enable({ apis: ['Date'], now: 0 });
      t.mock.method(console, 'log', () => { reports++; throw new Error('PRIVATE-diagnostic-output'); });
      const ui = createDesktopUiControls({
        async evaluate() { order.push('read'); throw refusal; },
        async send() { assert.fail('refused read cannot dispatch'); },
      }, {
        assertOwnedRenderer() { order.push('owner'); if (boundary === 'owner') throw refusal; },
        step() { assert.fail('refused read has no action'); },
      });
      const beforeRead = async () => { order.push('prepare'); if (boundary === 'preparation') throw refusal; };
      await assert.rejects(ui.waitRead('PRIVATE-expression', 'PRIVATE-label', 30_000, Boolean,
        boundary === 'preparation' ? { deadline: 30_000, beforeRead } : undefined), error => error === refusal);
      assert.equal(reports, 1);
      assert.deepEqual(order, boundary === 'owner' ? ['owner'] :
        boundary === 'preparation' ? ['owner', 'prepare'] : ['owner', 'read']);
    } finally { t.mock.restoreAll(); t.mock.timers.reset(); }
  });
}

test('preparation reaching the original cutoff is observed without a DOM request or replacement budget', { timeout: 5000 }, async t => {
  const reports = readWaitReports(t), order: string[] = [];
  try {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const ui = createDesktopUiControls({
      async evaluate() { assert.fail('late preparation cannot read DOM'); },
      async send() { assert.fail('late preparation cannot dispatch'); },
    }, { assertOwnedRenderer() { order.push('owner'); }, step() {} });
    await assert.rejects(ui.waitRead('PRIVATE-expression', 'PRIVATE-label', 30_000, Boolean, {
      deadline: 30_000,
      async beforeRead() { order.push('prepare'); t.mock.timers.setTime(30_000); },
    }), /UI read timed out/);
    assert.deepEqual(order, ['owner', 'prepare', 'owner']);
    const row = reports.reads()[0]!;
    assert.equal(row.preparationStarted, 1); assert.equal(row.preparationResolved, 1);
    assert.equal(row.ownerStarted, 2); assert.equal(row.ownerResolved, 2); assert.equal(row.readsStarted, 0);
    assert.equal(row.cutoff, 'after-preparation'); assert.equal(row.deadlineMs, 30_000);
    assert.equal(row.lastCheckAtMs, 30_000);
  } finally { t.mock.restoreAll(); t.mock.timers.reset(); }
});

test('owner observation cost keeps the original post-read cutoff and no readiness call', { timeout: 5000 }, async t => {
  const reports = readWaitReports(t), order: string[] = [];
  try {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const ui = createDesktopUiControls({
      async evaluate() { order.push('read'); return point; },
      async send() { assert.fail('late read cannot dispatch'); },
    }, { assertOwnedRenderer() { order.push('owner'); t.mock.timers.setTime(30_000); }, step() {} });
    await assert.rejects(ui.waitRead('PRIVATE-expression', 'PRIVATE-label', 30_000, () => {
      assert.fail('the existing post-read guard refuses before readiness');
    }), /UI read timed out/);
    assert.deepEqual(order, ['owner', 'read'], 'the diagnostic adds no new owner or deadline boundary');
    const row = reports.reads()[0]!;
    assert.equal(row.readsStarted, 1); assert.equal(row.readsResolved, 1); assert.equal(row.postReadLate, 1);
    assert.equal(row.firstCheckAtMs, 0); assert.equal(row.lastCheckAtMs, 30_000);
  } finally { t.mock.restoreAll(); t.mock.timers.reset(); }
});

test('a timely original value remains identical and emits no failure diagnostic', { timeout: 5000 }, async t => {
  const reports = readWaitReports(t);
  await withReadFixture(t, [{ settlesAt: 29_999, value: offeredValue }], async f => {
    assert.equal(await f.read(), offeredValue);
    assert.equal(f.reads.length, 1); assert.equal(f.guards.length, 1);
    assert.deepEqual(f.ticks, []); assert.deepEqual(f.sends, []); assert.deepEqual(reports.output, []);
  });
});

for (const mode of ['present', 'dom-throws', 'transport-getter', 'different-label'] as const) {
  test('same Create target reports only closed existing DOM facts: ' + mode, { timeout: 5000 }, async t => {
    const reports = readWaitReports(t), sends: string[] = [], ticks: number[] = [];
    let reads = 0, privateReads = 0, diagnosticQueries = 0, stepCount = 0;
    const selector = '[data-testid="create-team-page"] button';
    const label = mode === 'different-label' ? 'PRIVATE-other-create' : 'Create and Launch original solo source exactly once';
    const page = {
      querySelector(query: string) {
        if (query === '#launch-team') return { getAttribute(name: string) { assert.equal(name, 'data-state'); return 'checked'; } };
        assert.equal(query, '#create-team-launch-authority-blocker'); return {};
      },
      querySelectorAll(query: string) {
        assert.ok(query === '[role="alert"]' || query === '[aria-invalid="true"]');
        return new Array(query === '[role="alert"]' ? 40 : 2);
      },
    };
    const control = {
      textContent: 'Create',
      getBoundingClientRect() { return { x: 20, y: 20, width: 100, height: 40 }; },
      matches(query: string) { assert.equal(query, ':disabled'); return true; },
      getAttribute(name: string) {
        if (name === 'aria-disabled') return null;
        assert.equal(name, 'aria-describedby'); return 'create-team-launch-authority-blocker';
      },
      closest(query: string) {
        diagnosticQueries++; assert.equal(query, '[data-testid="create-team-page"]');
        if (mode === 'dom-throws') throw new Error('PRIVATE-DOM-refusal');
        return page;
      },
      querySelector(query: string) { assert.equal(query, 'svg.animate-spin'); return {}; },
      contains() { return false; },
    };
    for (const target of [page, control]) {
      for (const key of ['value', 'validationMessage', 'checkValidity', 'reportValidity', 'innerHTML']) {
        Object.defineProperty(target, key, { get() { privateReads++; throw new Error('PRIVATE-form-access'); } });
      }
    }
    try {
      t.mock.timers.enable({ apis: ['Date'], now: 0 });
      t.mock.method(globalThis, 'setTimeout', (done: () => void, delay: number) => {
        ticks.push(delay); t.mock.timers.setTime(Date.now() + delay); done();
        return {} as ReturnType<typeof setTimeout>;
      });
      const ui = createDesktopUiControls({
        async evaluate(expression) {
          reads++;
          assert.equal(reads, 1, 'diagnostics use only the original target lookup');
          const value = runInNewContext(expression, {
            document: {
              querySelectorAll(query: string) {
                if (query === selector) return [control];
                assert.equal(query, '[data-testid="create-team-page"]'); return [page];
              },
              elementFromPoint() { return control; },
            },
            getComputedStyle() { return { pointerEvents: 'none' }; },
            innerWidth: 1600, innerHeight: 1000,
          }) as Record<string, unknown>;
          if (mode === 'transport-getter') {
            Object.defineProperty(value, 'createFacts', {
              get() { privateReads++; throw new Error('PRIVATE-transport-getter'); },
            });
          }
          t.mock.timers.setTime(29_900);
          return value;
        },
        async send(method, params) { sends.push(String(params?.type ?? method)); return {}; },
      }, { assertOwnedRenderer() {}, step() { stepCount++; } });
      let failure: Error | undefined;
      await assert.rejects(ui.click(selector, label, 'Create'), error => {
        assert.ok(error instanceof Error); failure = error; return true;
      });
      assert.ok(failure); assert.match(failure.message, /UI target read failed:/);
      const facts = JSON.parse(failure.message.split('facts=')[1]!) as Record<string, unknown>;
      assert.deepEqual(Object.fromEntries(Object.entries(facts).filter(([key]) => !key.startsWith('create'))), {
        matches: 1, disabled: true, ariaDisabled: false, pointerEventsNone: true, centerInViewport: true, hitPresent: true,
      });
      const create = Object.fromEntries(Object.entries(facts).filter(([key]) => key.startsWith('create')));
      assert.deepEqual(create, mode === 'present' ? {
        createPageUnique: true, createLaunchChecked: true, createAuthorityDescribed: true,
        createAuthorityNoticePresent: true, createSubmittingSpinner: true,
        createAlertCount: 33, createInvalidAttributeCount: 2,
      } : {});
      assert.ok(failure.cause instanceof Error);
      assert.equal(failure.cause.message, 'UI read timed out: ' + label + '; no mutation retry');
      assert.equal(privateReads, 0, 'no private value, validity method or response getter is read');
      assert.equal(diagnosticQueries, mode === 'different-label' ? 0 : 1);
      assert.equal(reads, 1); assert.equal(stepCount, 0); assert.deepEqual(ticks, [100]);
      assert.deepEqual(sends, ['Page.bringToFront'], 'disabled original target never hovers or clicks');
      assert.doesNotMatch(JSON.stringify(facts), /PRIVATE/); assert.doesNotMatch(reports.output.join(''), /PRIVATE/);
      assert.equal(reports.reads()[0]!.phase, 'initial');
      assert.equal(reports.reads()[0]!.cutoff, 'loop'); assert.equal(reports.reads()[0]!.readsResolved, 1);
    } finally { t.mock.restoreAll(); t.mock.timers.reset(); }
  });
}
