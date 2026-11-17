import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createDesktopUiControls } from './desktop-ui-controls.ts';

type Frame = { settlesAt: number; value: unknown };
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
        assert.equal(actual, expression, 'the exact original read expression is retained');
        const frame = frames[reads.length];
        assert.ok(frame, 'no read after the finite original observations');
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
