import { createContext, Script } from 'node:vm';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { matrixPluginName } from '../../scripts/e2e/uap-management-plugin-fixture';
import { assertPluginMatrixReview } from '../../scripts/e2e/uap-management-plugin-matrix';

import type { DesktopCdp, UiWait } from '../../scripts/e2e/uap-management-ui';
import type { ExtensionClient } from '../../src/features/extension-management/contracts';

// Run the actual fixed CDP declaration against DOM rows with the same attributes
// as ManagementPlanDialog; do not replace count results or the review assertion.
function rendererCdp(): DesktopCdp {
  const realm = createContext({ document, HTMLElement });
  return {
    send: async (method, params = {}) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'matrix-review' } };
      if (method === 'Runtime.releaseObject') return {};
      expect(method).toBe('Runtime.callFunctionOn');
      expect(params.objectId).toBe('matrix-review');
      const args = JSON.parse(JSON.stringify(params.arguments)) as { value: unknown }[];
      // Only the checked-in helper declaration is compiled; selectors remain data.
      // eslint-disable-next-line sonarjs/code-eval
      const dispatcher = new Script(`(${String(params.functionDeclaration)})`).runInContext(realm, {
        timeout: 1000,
      }) as (...values: unknown[]) => Promise<unknown>;
      return { result: { value: await dispatcher(...args.map((argument) => argument.value)) } };
    },
    screenshot: () => Promise.resolve(),
    close: () => Promise.resolve(),
    on: () => {},
  };
}

const waitOnce: UiWait = async (observe) => {
  const value = await observe();
  if (!value) throw new Error('The fixture review must be visible');
  return value;
};
type Row = { target: string; action: string; alias?: string };
const clients: ExtensionClient[] = ['claude', 'codex', 'opencode'];
const removalRows: Row[] = [
  { target: 'claude', action: 'remove' },
  { target: 'codex', action: 'unchanged' },
  { target: 'opencode', action: 'unchanged' },
];

function renderReview(rows: readonly Row[]) {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  for (const row of rows) {
    const element = document.createElement('div');
    element.dataset.testid = 'uap-plan-action';
    element.dataset.targetId = row.target;
    element.dataset.action = row.action;
    element.textContent = `${row.action} ${row.alias ?? matrixPluginName}`;
    dialog.append(element);
  }
  const apply = document.createElement('button');
  apply.textContent = 'Apply changes';
  dialog.append(apply);
  document.body.append(dialog);
  return { cdp: rendererCdp(), wait: waitOnce };
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.spyOn(HTMLElement.prototype, 'checkVisibility').mockReturnValue(true);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('plugin matrix exact review targets', () => {
  it.each(['install', 'update'])('requires all three %s mutations', async (action) => {
    const f = renderReview(clients.map((target) => ({ target, action })));
    await expect(assertPluginMatrixReview(f, action, clients)).resolves.toBeUndefined();
  });

  it('accepts the observed Claude removal with exactly two unchanged siblings', async () => {
    const f = renderReview(removalRows);
    await expect(
      assertPluginMatrixReview(f, 'remove', ['claude'], ['codex', 'opencode'])
    ).resolves.toBeUndefined();
  });

  it('retains only the remaining sibling after the first removal', async () => {
    const f = renderReview([
      { target: 'codex', action: 'remove' },
      { target: 'opencode', action: 'unchanged' },
    ]);
    await expect(
      assertPluginMatrixReview(f, 'remove', ['codex'], ['opencode'])
    ).resolves.toBeUndefined();
  });

  it('requires just the final removal when no siblings remain', async () => {
    const f = renderReview([{ target: 'opencode', action: 'remove' }]);
    await expect(assertPluginMatrixReview(f, 'remove', ['opencode'])).resolves.toBeUndefined();
  });

  it.each([
    ['an extra sibling mutation', [...removalRows, { target: 'codex', action: 'remove' }]],
    ['a mutated sibling', [removalRows[0], { target: 'codex', action: 'update' }, removalRows[2]]],
    ['a missing selected target', removalRows.slice(1)],
    ['a missing unchanged sibling', removalRows.slice(0, 2)],
    ['a duplicate unchanged sibling', [...removalRows, removalRows[1]]],
    ['an unrequested target', [...removalRows, { target: 'cursor', action: 'unchanged' }]],
    [
      'a different plugin alias',
      [{ ...removalRows[0], alias: 'another-plugin' }, ...removalRows.slice(1)],
    ],
  ] satisfies [string, Row[]][])('rejects %s', async (_label, rows) => {
    const f = renderReview(rows);
    await expect(
      assertPluginMatrixReview(f, 'remove', ['claude'], ['codex', 'opencode'])
    ).rejects.toThrow();
  });
});
