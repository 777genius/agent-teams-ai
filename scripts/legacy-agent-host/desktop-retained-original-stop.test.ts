import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import { createDesktopUiControls } from './desktop-ui-controls.ts';

const selector = 'button[aria-label="Stop"]';
const source = ts.createSourceFile('desktop-retained-original-ui.ts',
  readFileSync(new URL('./desktop-retained-original-ui.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const calls: ts.CallExpression[] = [];
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === 'ui' && node.expression.name.text === 'click' &&
      node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === selector)
    calls.push(node);
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(calls.length, 1, 'execute the one actual retained Stop invocation, not a copied gesture');
const stop = (ui: ReturnType<typeof createDesktopUiControls>): Promise<void> =>
  runInNewContext(`(async () => { await ${calls[0]!.getText(source)}; })()`, { ui }) as Promise<void>;

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const state = { top: -33, wheels: 0, presses: 0, releases: 0, ownerCurrent: true, reveal: true };
  const commands: Record<string, unknown>[] = [], steps: Record<string, unknown>[] = [];
  const targetFacts: Record<string, unknown>[] = [];
  const hooks: { afterInput?(type: string): void } = {};
  const child = {}, refusal = new Error('TEST retained renderer ownership changed');
  const scroller = { parentElement: null, scrollHeight: 1500, clientHeight: 829,
    getBoundingClientRect: () => ({ x: 340, top: 71, bottom: 900, width: 780 }) };
  const control = { parentElement: scroller, textContent: 'Stop', tagName: 'BUTTON',
    contains: (node: unknown) => node === child, matches: () => false, getAttribute: () => null,
    closest: () => null, getAnimations: () => [],
    getBoundingClientRect: () => ({ x: 1030, y: state.top, top: state.top,
      bottom: state.top + 28, width: 60, height: 28 }) };
  const ui = createDesktopUiControls({
    async evaluate(expression: string) {
      const value = runInNewContext(expression, {
        innerWidth: 1400, innerHeight: 900,
        getComputedStyle: () => ({ overflowY: 'auto', pointerEvents: 'auto' }),
        document: { documentElement: scroller, fonts: { status: 'loaded' },
          querySelectorAll(actual: string) { assert.equal(actual, selector); return [control]; },
          elementFromPoint(x: number, y: number) {
            return x >= 1030 && x < 1090 && y >= 71 && y < 900 &&
              y >= state.top && y < state.top + 28 ? child : null;
          } },
      }) as Record<string, unknown>;
      if (expression.includes('unavailableTarget:true')) {
        targetFacts.push(value);
        // Reproduce the original refusal without spending a real 30 seconds.
        if (value.unavailableTarget === true) t.mock.timers.setTime(31_000);
      }
      return value;
    },
    async send(method: string, params: Record<string, unknown> = {}) {
      commands.push({ method, ...params });
      if (method === 'Page.bringToFront') return {};
      assert.equal(method, 'Input.dispatchMouseEvent');
      const type = String(params.type);
      if (type === 'mouseWheel') {
        state.wheels++;
        if (state.reveal) state.top -= Number(params.deltaY);
      }
      if (type === 'mousePressed') state.presses++;
      if (type === 'mouseReleased') state.releases++;
      hooks.afterInput?.(type);
      return {};
    },
  }, { assertOwnedRenderer() { if (!state.ownerCurrent) throw refusal; }, step(value) { steps.push(value); } });
  return { ui, state, commands, steps, targetFacts, hooks, refusal };
}

test('retained original Stop reveals its offscreen control before one original click', { timeout: 5000 }, async t => {
  const f = fixture(t);
  await stop(f.ui).catch(error => {
    assert.equal(f.state.presses, 0, 'an offscreen Stop must never receive a press');
    throw new Error('Actual retained Stop was not revealed; original target facts=' + JSON.stringify(f.targetFacts), { cause: error });
  });
  assert.equal(f.state.wheels, 1);
  assert.equal(f.state.presses, 1);
  assert.equal(f.state.releases, 1);
  assert.deepEqual(f.commands.filter(row => row.method === 'Input.dispatchMouseEvent').map(row => row.type),
    ['mouseWheel', 'mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(f.steps.filter(row => row.action === 'mouseClick').length, 1);
  assert.ok(f.targetFacts.length >= 5 && f.targetFacts.every(row => row.unavailableTarget !== true),
    'the original initial, hovered, stable and final target reads must all qualify the revealed control');
});

for (const change of ['owner', 'cutoff'] as const) {
  test(`retained original Stop preserves ${change} refusal after its preparation wheel`, { timeout: 5000 }, async t => {
    const f = fixture(t);
    f.hooks.afterInput = type => {
      if (type !== 'mouseWheel') return;
      if (change === 'owner') f.state.ownerCurrent = false;
      else t.mock.timers.setTime(31_000);
    };
    await assert.rejects(stop(f.ui), change === 'owner' ? error => error === f.refusal : /UI read timed out/);
    assert.equal(f.state.wheels, 1);
    assert.equal(f.state.presses, 0);
    assert.equal(f.state.releases, 0);
    assert.deepEqual(f.commands.filter(row => row.method === 'Input.dispatchMouseEvent').map(row => row.type), ['mouseWheel']);
  });
}

test('retained original Stop keeps the original finite wheel budget without a fallback click', { timeout: 5000 }, async t => {
  const f = fixture(t); f.state.reveal = false;
  await assert.rejects(stop(f.ui), /UI scroll timed out/);
  assert.equal(f.state.wheels, 12);
  assert.equal(f.state.presses, 0);
  assert.equal(f.state.releases, 0);
  assert.ok(f.commands.filter(row => row.method === 'Input.dispatchMouseEvent').every(row => row.type === 'mouseWheel'));
});
