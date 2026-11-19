import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createProviderLaunchAuthorityMarker, PROVIDER_LAUNCH_AUTHORITY_MARKER_ATTRIBUTE,
  PROVIDER_LAUNCH_AUTHORITY_MARKER_LIMIT, UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER
} from '../../src/shared/utils/providerLaunchAuthorityMarker.ts';

import { createDesktopUiControls, desktopAnimationFramesExpression } from './desktop-ui-controls.ts';

type Frame = { settlesAt: number; value: unknown; animationFrames?: true };
const offeredValue = { kind: 'TEST-read-value' };
const point = { x: 100, y: 100 };

for (const mode of ['loading', 'offline', 'other-team', 'missing-store', 'store-throws',
  'response-accessor', 'malformed-fields', 'different-label', 'late'] as const) {
  test('original unavailable Launch target retains bounded hydration facts: ' + mode,
    { timeout: 5000 }, async t => {
      const reports = readWaitReports(t), sends: string[] = [], ticks: number[] = [];
      let reads = 0, owners = 0, samples = 0, responseGetterReads = 0, steps = 0;
      const label = mode === 'different-label' ? 'other Launch action' : 'open original Launch dialog';
      try {
        t.mock.timers.enable({ apis: ['Date'], now: 0 });
        t.mock.method(globalThis, 'setTimeout', (done: () => void, delay: number) => {
          ticks.push(delay); t.mock.timers.setTime(Date.now() + delay); done();
          return {} as ReturnType<typeof setTimeout>;
        });
        const ui = createDesktopUiControls({
          async evaluate(expression) {
            assert.equal(++reads, 1, 'diagnostics add no CDP lookup');
            const value = runInNewContext(expression, {
              document: { querySelectorAll(selector: string) {
                assert.equal(selector, 'button'); return [];
              } },
              window: mode === 'missing-store' ? {} : { __agentTeamsDevStore: {
                getState() {
                  samples++;
                  if (mode === 'store-throws') throw new Error('PRIVATE-observer-failure');
                  return { selectedTeamName: 'PRIVATE-original-team', selectedTeamLoading: mode === 'loading',
                    selectedTeamData: mode === 'loading' ? null : {
                      teamName: mode === 'other-team' ? 'PRIVATE-other-team' : 'PRIVATE-original-team',
                      isAlive: mode === 'other-team',
                    }, selectedTeamError: null };
                },
              } },
            }) as Record<string, unknown>;
            if (mode === 'response-accessor') Object.defineProperty(value, 'launchFacts', {
              get() { responseGetterReads++; throw new Error('PRIVATE-response-accessor'); },
            });
            if (mode === 'malformed-fields') value.launchFacts = {
              launchStoreAvailable: true, launchTeamLoading: 'PRIVATE',
              launchTeamDataPresent: 1, launchTeamDataMatches: null,
              launchTeamAlive: false, launchTeamErrorPresent: {}, privateExtra: 'PRIVATE',
            };
            t.mock.timers.setTime(mode === 'late' ? 30_000 : 29_900);
            return value;
          },
          async send(method, params) { sends.push(String(params?.type ?? method)); return {}; },
        }, { assertOwnedRenderer() { owners++; }, step() { steps++; } });
        let failure: Error | undefined;
        await assert.rejects(ui.click('button', label, 'Launch'), error => {
          assert.ok(error instanceof Error); failure = error; return true;
        });
        assert.ok(failure);
        if (mode === 'late') {
          assert.equal(failure.message, 'UI read timed out: ' + label + '; no mutation retry');
          assert.deepEqual(ticks, [], 'late observations do not enter the predicate or poll again');
        } else {
          const facts = JSON.parse(failure.message.split('facts=')[1]!) as Record<string, unknown>;
          const original = Object.fromEntries(Object.entries(facts).filter(([key]) => !key.startsWith('launch')));
          assert.deepEqual(original, { matches: 0, disabled: false, ariaDisabled: false,
            pointerEventsNone: false, centerInViewport: false, hitPresent: false });
          const hydration = Object.fromEntries(Object.entries(facts).filter(([key]) => key.startsWith('launch')));
          const unavailable = ['store-throws', 'response-accessor', 'different-label'].includes(mode);
          assert.deepEqual(hydration, unavailable ? {} : mode === 'missing-store'
            ? { launchStoreAvailable: false } : mode === 'malformed-fields'
              ? { launchStoreAvailable: true, launchTeamAlive: false }
              : { launchStoreAvailable: true, launchTeamLoading: mode === 'loading',
                launchTeamDataPresent: mode !== 'loading', launchTeamErrorPresent: false,
                ...(mode === 'loading' ? {} : { launchTeamDataMatches: mode !== 'other-team',
                  launchTeamAlive: mode === 'other-team' }) });
          assert.ok(failure.cause instanceof Error);
          assert.equal(failure.cause.message, 'UI read timed out: ' + label + '; no mutation retry');
          assert.deepEqual(ticks, [100], 'original cadence spends the original deadline');
          assert.doesNotMatch(JSON.stringify(facts), /PRIVATE/);
        }
        assert.equal(reads, 1); assert.equal(owners, 1); assert.equal(steps, 0);
        assert.equal(samples, mode === 'missing-store' || mode === 'different-label' ? 0 : 1);
        assert.equal(responseGetterReads, 0, 'only own data properties cross the closed projection');
        assert.deepEqual(sends, ['Page.bringToFront'], 'unavailable target never dispatches input');
        assert.doesNotMatch(reports.output.join(''), /PRIVATE/);
      } finally { t.mock.restoreAll(); t.mock.timers.reset(); }
    });
}

test('ready original Launch target does not sample hydration or replace the following owner refusal',
  { timeout: 5000 }, async t => {
    const refusal = new Error('TEST original owner refusal'), sends: string[] = [];
    let samples = 0, reads = 0, owners = 0;
    const button = { textContent: 'Launch', tagName: 'BUTTON',
      getBoundingClientRect() { return { x: 20, y: 20, width: 100, height: 40 }; },
      matches() { return false; }, closest() { return null; }, getAnimations() { return []; } };
    try {
      t.mock.timers.enable({ apis: ['Date'], now: 0 });
      const ui = createDesktopUiControls({
        async evaluate(expression) {
          reads++;
          return runInNewContext(expression, {
            document: { querySelectorAll() { return [button]; }, elementFromPoint() { return button; } },
            window: { __agentTeamsDevStore: { getState() {
              samples++; throw new Error('PRIVATE-observer-must-not-run');
            } } },
          });
        },
        async send(method) { sends.push(method); return {}; },
      }, { assertOwnedRenderer() { if (++owners === 2) throw refusal; },
        step() { assert.fail('original owner refusal precedes hover'); } });
      await assert.rejects(ui.click('button', 'open original Launch dialog', 'Launch'), error => error === refusal);
      assert.equal(samples, 0); assert.equal(reads, 1); assert.equal(owners, 2);
      assert.deepEqual(sends, ['Page.bringToFront']);
    } finally { t.mock.restoreAll(); t.mock.timers.reset(); }
  });

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
  }) => Promise<void>,
  onOwner?: (completedReads: number) => void
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
      assertOwnedRenderer() { guards.push(Date.now()); onOwner?.(reads.length); },
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
    { settlesAt: 252, value: point },
  ], async f => {
    await f.ui.clickExpression(f.expression, f.label, undefined, undefined, { waitForRenderFrames: true });
    assert.equal(f.reads.length, 7);
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
        if (query === '#create-team-launch-authority-blocker') return [];
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
        createAuthorityMarker: UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER,
      } : mode === 'different-label' ? {} : { createAuthorityMarker: UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER });
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

for (const mode of ['valid', 'malformed', 'oversized', 'missing', 'duplicate', 'dom-throws',
  'transport-accessor', 'different-label', 'enabled'] as const) {
  test('original Create target retains closed notice marker without changing admission: ' + mode,
    { timeout: 5000 }, async t => {
      const reports = readWaitReports(t), sends: string[] = [], ticks: number[] = [];
      let reads = 0, owners = 0, markerQueries = 0, attributeReads = 0, privateReads = 0;
      const selector = '[data-testid="create-team-page"] button';
      const label = mode === 'different-label' ? 'other Create action' :
        'Create and Launch original solo source exactly once';
      const marker = createProviderLaunchAuthorityMarker(
        [{ providerId: 'anthropic', providerStatus: {
          providerId: 'anthropic', supported: true, authenticated: false,
          verificationState: 'unknown', statusCheckOutcome: 'pending',
          statusCheckErrorCode: 'partial_response', modelCatalogRefreshState: 'loading',
          capabilities: { teamLaunch: false }, modelCatalog: null,
        } }],
        [{ providerId: 'anthropic', status: 'checking' }], { anthropic: true }
      );
      assert.notEqual(marker, UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER);
      const notice = {
        getAttribute(name: string) {
          attributeReads++; assert.equal(name, PROVIDER_LAUNCH_AUTHORITY_MARKER_ATTRIBUTE);
          if (mode === 'dom-throws') throw new Error('PRIVATE-marker-DOM');
          return mode === 'malformed' ? '{"v":1,"path":"PRIVATE"}' :
            mode === 'oversized' ? 'x'.repeat(PROVIDER_LAUNCH_AUTHORITY_MARKER_LIMIT + 1) : marker;
        },
      };
      const page = {
        querySelector(query: string) {
          if (query === '#launch-team') return { getAttribute() { return 'checked'; } };
          assert.equal(query, '#create-team-launch-authority-blocker');
          return mode === 'missing' ? null : notice;
        },
        querySelectorAll(query: string) {
          if (query === '#create-team-launch-authority-blocker') {
            markerQueries++;
            return mode === 'missing' ? [] : mode === 'duplicate' ? [notice, notice] : [notice];
          }
          assert.ok(query === '[role="alert"]' || query === '[aria-invalid="true"]');
          return [];
        },
      };
      const control = {
        textContent: 'Create', tagName: 'BUTTON',
        getBoundingClientRect() { return { x: 20, y: 20, width: 100, height: 40 }; },
        matches(query: string) { assert.equal(query, ':disabled'); return mode !== 'enabled'; },
        getAttribute(name: string) {
          if (name === 'aria-disabled') return null;
          assert.equal(name, 'aria-describedby'); return 'create-team-launch-authority-blocker';
        },
        closest(query: string) {
          if (query === '[role="dialog"]') return null;
          assert.equal(query, '[data-testid="create-team-page"]'); return page;
        },
        querySelector(query: string) { assert.equal(query, 'svg.animate-spin'); return null; },
        getAnimations() { return []; },
        contains() { return false; },
      };
      for (const value of [page, notice, control]) {
        for (const key of ['value', 'validationMessage', 'innerHTML', 'canSkipPreflight', 'readiness']) {
          Object.defineProperty(value, key, { get() { privateReads++; throw new Error('PRIVATE-field'); } });
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
            assert.ok(reads <= (mode === 'enabled' ? 5 : 1), 'only original target reads');
            const value = runInNewContext(expression, {
              document: {
                querySelectorAll(query: string) {
                  if (query === selector) return [control];
                  assert.equal(query, '[data-testid="create-team-page"]'); return [page];
                },
                elementFromPoint() { return control; },
              },
              getComputedStyle() { return { pointerEvents: mode === 'enabled' ? 'auto' : 'none' }; },
              innerWidth: 1600, innerHeight: 1000,
            }) as Record<string, unknown>;
            if (mode === 'transport-accessor') {
              const facts = value.createFacts;
              assert.ok(facts && typeof facts === 'object');
              Object.defineProperty(facts, 'createAuthorityMarker', {
                get() { privateReads++; throw new Error('PRIVATE-marker-transport'); },
              });
            }
            if (mode !== 'enabled') t.mock.timers.setTime(29_900);
            return value;
          },
          async send(method, params) { sends.push(String(params?.type ?? method)); return {}; },
        }, { assertOwnedRenderer() { owners++; }, step() {} });
        if (mode === 'enabled') {
          await ui.click(selector, label, 'Create');
          assert.equal(reads, 5);
          assert.deepEqual(sends, ['Page.bringToFront', 'mouseMoved', 'mousePressed', 'mouseReleased']);
          assert.deepEqual(ticks, [100, 100]);
          assert.equal(markerQueries, 0, 'a ready target does not read failure-only marker data');
          assert.equal(attributeReads, 0);
          assert.deepEqual(reports.output, []);
        } else {
          let failure: Error | undefined;
          await assert.rejects(ui.click(selector, label, 'Create'), error => {
            assert.ok(error instanceof Error); failure = error; return true;
          });
          assert.ok(failure);
          assert.ok(failure.cause instanceof Error);
          assert.equal(failure.cause.message, 'UI read timed out: ' + label + '; no mutation retry');
          const facts = JSON.parse(failure.message.split('facts=')[1]!) as Record<string, unknown>;
          assert.equal(facts.disabled, true);
          assert.equal(facts.createAuthorityMarker, mode === 'different-label' ? undefined :
            mode === 'valid' ? marker : UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER);
          assert.equal(reads, 1); assert.equal(owners, 1);
          assert.deepEqual(sends, ['Page.bringToFront']);
          assert.deepEqual(ticks, [100]);
          assert.equal(markerQueries, mode === 'different-label' ? 0 : 1);
          assert.equal(attributeReads, ['missing', 'duplicate', 'different-label'].includes(mode) ? 0 : 1);
          assert.equal(reports.reads()[0]!.phase, 'initial');
          assert.equal(reports.reads()[0]!.cutoff, 'loop');
          assert.equal(reports.reads()[0]!.deadlineMs, 30_000);
          assert.equal(reports.reads()[0]!.readsStarted, 1);
          assert.equal(reports.reads()[0]!.readsResolved, 1);
          assert.equal(reports.reads()[0]!.postReadLate, 0);
          assert.doesNotMatch(JSON.stringify(facts), /PRIVATE/);
        }
        assert.equal(privateReads, 0);
        assert.doesNotMatch(reports.output.join(''), /PRIVATE/);
      } finally { t.mock.restoreAll(); t.mock.timers.reset(); }
    });
}

test('frame-gated click reacquires a target moved by the original final ownership census before one input', { timeout: 5000 }, async t => {
  const before = { x: 1045.3125, y: 163, tag: 'BUTTON' };
  const after = { x: 1045.3125, y: 85, tag: 'BUTTON' };
  const frames: Frame[] = [
    { settlesAt: 0, value: before }, { settlesAt: 0, value: before },
    { settlesAt: 100, value: before }, { settlesAt: 200, value: before },
    { settlesAt: 250, value: true, animationFrames: true },
    { settlesAt: 251, value: before }, { settlesAt: 252, value: before },
    { settlesAt: 352, value: after }, { settlesAt: 452, value: after },
    { settlesAt: 453, value: true, animationFrames: true },
    { settlesAt: 454, value: after }, { settlesAt: 455, value: after },
  ];
  let moves = 0;
  await withReadFixture(t, frames, async f => {
    await f.ui.clickExpression(f.expression, f.label, undefined, undefined, { waitForRenderFrames: true });
    assert.equal(moves, 1, 'the original owner fence is the injected layout-change boundary');
    assert.equal(f.reads.length, 12);
    assert.deepEqual(f.ticks, [100, 100, 100, 100], 'the moved target must earn two new stable samples');
    assert.deepEqual(f.sends.map(row => row.params?.type ?? row.method), [
      'Page.bringToFront', 'mouseMoved', 'mousePressed', 'mouseReleased',
    ], 'preparation never repeats the original hover or input');
    assert.deepEqual(f.sends.filter(row => row.params?.type === 'mousePressed' || row.params?.type === 'mouseReleased')
      .map(row => row.params), [
        { type: 'mousePressed', x: after.x, y: after.y, button: 'left', clickCount: 1 },
        { type: 'mouseReleased', x: after.x, y: after.y, button: 'left', clickCount: 1 },
      ]);
    assert.equal(f.steps.filter(row => row.action === 'mouseClick').length, 1);
    assert.equal(f.steps.find(row => row.action === 'mouseClick')?.target, after);
  }, completedReads => {
    if (completedReads === 6) { frames[6]!.value = after; moves++; }
  });
});

test('post-owner movement exhausts the same sixteen point samples without one press', { timeout: 5000 }, async t => {
  const frames: Frame[] = [{ settlesAt: 0, value: point }, { settlesAt: 0, value: point }];
  const moves = new Map<number, { index: number; value: { x: number; y: number } }>();
  let time = 0, current = point, moveCount = 0;
  for (let cycle = 0; cycle < 4; cycle++) {
    frames.push({ settlesAt: time += 100, value: current }, { settlesAt: time += 100, value: current },
      { settlesAt: ++time, value: true, animationFrames: true }, { settlesAt: ++time, value: current });
    const next = { x: current.x, y: current.y + 1 };
    moves.set(frames.length, { index: frames.length, value: next });
    frames.push({ settlesAt: ++time, value: current });
    current = next;
  }
  await withReadFixture(t, frames, async f => {
    await assert.rejects(f.ui.clickExpression(f.expression, f.label, undefined, undefined,
      { waitForRenderFrames: true }), /Original UI target moved after ownership check/);
    assert.equal(moveCount, 4);
    assert.equal(f.reads.length, 22, 'two initial reads, sixteen point samples and four original frame observations');
    assert.equal(f.reads.filter(expression => expression === f.expression).length - 2, 16);
    assert.deepEqual(f.ticks, Array<number>(8).fill(100));
    assert.deepEqual(f.sends.map(row => row.params?.type ?? row.method), ['Page.bringToFront', 'mouseMoved']);
    assert.equal(f.steps.some(row => row.action === 'mouseClick'), false);
  }, completedReads => {
    const move = moves.get(completedReads);
    if (move) { frames[move.index]!.value = move.value; moveCount++; }
  });
});

test('post-owner reacquisition preserves a fresh owner refusal before the original input', { timeout: 5000 }, async t => {
  const refusal = new Error('TEST owner lost during final reacquisition');
  await withReadFixture(t, [
    ...readyClickFrames, { settlesAt: 250, value: true, animationFrames: true },
    { settlesAt: 251, value: point }, { settlesAt: 252, value: point },
  ], async f => {
    await assert.rejects(f.ui.clickExpression(f.expression, f.label, undefined, undefined,
      { waitForRenderFrames: true }), error => error === refusal);
    assert.equal(f.reads.length, 7);
    assert.deepEqual(f.sends.map(row => row.params?.type ?? row.method), ['Page.bringToFront', 'mouseMoved']);
    assert.equal(f.steps.some(row => row.action === 'mouseClick'), false);
  }, completedReads => { if (completedReads === 7) throw refusal; });
});

for (const boundary of ['read', 'owner'] as const) {
  test(`post-owner reacquisition ${boundary} reaching the original deadline refuses before input`, { timeout: 5000 }, async t => {
    await withReadFixture(t, [
      ...readyClickFrames, { settlesAt: 250, value: true, animationFrames: true },
      { settlesAt: 251, value: point }, { settlesAt: boundary === 'read' ? 30_000 : 252, value: point },
    ], async f => {
      await assert.rejects(f.ui.clickExpression(f.expression, f.label, undefined, undefined,
        { waitForRenderFrames: true }), {
        message: 'UI read timed out: ' + f.label + ' final target; no mutation retry',
      });
      assert.equal(f.reads.length, 7, 'no observation after the original deadline');
      assert.deepEqual(f.ticks, [100, 100]);
      assert.deepEqual(f.sends.map(row => row.params?.type ?? row.method), ['Page.bringToFront', 'mouseMoved']);
      assert.equal(f.steps.some(row => row.action === 'mouseClick'), false);
    }, completedReads => {
      if (boundary === 'owner' && completedReads === 7) t.mock.timers.setTime(30_000);
    });
  });
}
