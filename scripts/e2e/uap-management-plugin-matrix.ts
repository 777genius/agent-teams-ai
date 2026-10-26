import assert from 'node:assert/strict';
import path from 'node:path';

import { observeMatrixNative, removeMatrixCodexNative } from './uap-management-plugin-evidence';
import {
  matrixArchivePath,
  matrixPluginName,
  matrixVersion,
} from './uap-management-plugin-fixture';
import { callUi, inspectElement, selectTab } from './uap-management-ui';

import type {
  ExtensionClient,
  ManagementEnvironment,
} from '../../src/features/extension-management/contracts';
import type {
  MatrixNativeContext,
  MatrixNativeObservation,
} from './uap-management-plugin-evidence';
import type { createPluginMatrixFixture } from './uap-management-plugin-fixture';
import type { DesktopCdp, UiLocator, UiWait } from './uap-management-ui';

const clients: ExtensionClient[] = ['claude', 'codex', 'opencode'];
const labels = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
const panel: UiLocator = { selector: '[data-testid=uap-plugin]' };
const row: UiLocator = {
  selector: '[data-testid=uap-installed-entry]',
  within: panel,
  textIncludes: [matrixPluginName],
};
const button = (name: string, within?: UiLocator): UiLocator => ({
  selector: 'button',
  name,
  within,
});
type Click = (locator: UiLocator) => Promise<void>;

export async function selectInstallationTargets(
  cdp: DesktopCdp,
  wait: UiWait,
  click: Click,
  root: UiLocator,
  selected: readonly ExtensionClient[]
) {
  for (const id of clients) {
    const control: UiLocator = {
      selector: '[data-testid=uap-install-target]',
      within: root,
      attributes: { 'data-target-id': id },
    };
    const wanted = selected.includes(id);
    await wait(
      async () => {
        const state = await inspectElement(cdp, control);
        return state?.visible && (!wanted || !state.disabled) ? state : null;
      },
      `${id} installation target control${wanted ? ' available through the actual native profile' : ''}`
    );
    const checked = () =>
      callUi<number>(cdp, 'count', [
        { ...control, attributes: { ...control.attributes, 'aria-checked': 'true' } },
      ]);
    if (Boolean(await checked()) !== wanted) await click(control);
    await wait(
      async () => Boolean(await checked()) === wanted,
      `${id} installation target selection`
    );
  }
  assert.equal(
    await callUi<number>(cdp, 'count', [
      { selector: '[data-testid=uap-install-target][aria-checked=true]', within: root },
    ]),
    selected.length
  );
}

interface MatrixOptions extends MatrixNativeContext {
  source: string;
  shots: string;
  cdp: DesktopCdp;
  wait: UiWait;
  evidence: Record<string, unknown>;
  fixture: Awaited<ReturnType<typeof createPluginMatrixFixture>>;
  click: Click;
  fill(selector: string, value: string): Promise<void>;
  selectAgent(root: UiLocator, label: string): Promise<void>;
  reviewAndApply(root: UiLocator): Promise<void>;
  screenshot(file: string): Promise<void>;
  environment(): Promise<ManagementEnvironment>;
}

export async function exercisePluginMatrix(f: MatrixOptions) {
  const evidence = {
    status: 'running',
    source: `${new URL(f.source).origin}${matrixArchivePath}`,
    fixture: f.fixture.provenance,
    modelSkillUse: 'not_evaluated',
    operations: {} as Record<string, string>,
    installation: {} as Record<string, MatrixNativeObservation>,
    update: {} as Record<string, MatrixNativeObservation>,
    removals: {} as Record<string, unknown>,
  };
  f.evidence.pluginClientMatrix = evidence;
  const assertReview = async (action: string, targets: readonly ExtensionClient[]) => {
    await f.wait(
      async () => (await inspectElement(f.cdp, button('Apply changes')))?.visible,
      `${action} plugin matrix review`,
      120_000
    );
    for (const targetId of targets) {
      assert.equal(
        await callUi<number>(f.cdp, 'count', [
          {
            selector: '[data-testid=uap-plan-action]',
            attributes: { 'data-target-id': targetId, 'data-action': action },
          },
        ]),
        1,
        'Every reviewed action must use the selected captured target'
      );
    }
    assert.equal(
      await callUi<number>(f.cdp, 'count', [{ selector: '[data-testid=uap-plan-action]' }]),
      targets.length,
      'A matrix review must contain exactly the requested target set'
    );
  };
  const rememberOperation = async (stage: string) => {
    const operation = await callUi<{ id: string | null; status: string | null }>(
      f.cdp,
      'operation',
      [panel]
    );
    assert(operation.id && operation.status === 'Completed');
    assert(
      !Object.values(evidence.operations).includes(operation.id),
      'Every lifecycle step must complete its own operation'
    );
    evidence.operations[stage] = operation.id;
  };
  await selectTab(f.cdp, f.wait, 'Plugins');
  await f.selectAgent(panel, labels.claude);
  await selectInstallationTargets(f.cdp, f.wait, f.click, panel, clients);
  await f.click(button('Install from source', panel));
  await f.fill('#uap-source-plugin', evidence.source);
  await f.fill('#uap-alias', matrixPluginName);
  await f.click(button('Review installation'));
  await assertReview('install', clients);
  await f.screenshot(path.join(f.shots, '22-plugin-matrix-install-review.png'));
  await f.reviewAndApply(panel);
  await rememberOperation('install');

  const entry = async (expected: readonly ExtensionClient[], revision: number) => {
    const value = (await f.environment()).entries.find((item) => item.alias === matrixPluginName);
    if (!expected.length) {
      assert(!value, 'Last targeted removal must remove the declared plugin');
      return undefined;
    }
    assert(value?.declared && value.kind === 'plugin');
    assert.equal(value.version, matrixVersion(revision));
    assert.deepEqual(value.bindings.map((binding) => binding.client).sort(), [...expected].sort());
    assert(value.bindings.every((binding) => binding.status === 'installed'));
    return value;
  };
  let current = await entry(clients, 1);
  for (const client of clients) {
    evidence.installation[client] = await observeMatrixNative(
      f,
      client,
      'installed',
      current!.bindings.find((binding) => binding.client === client),
      1
    );
  }
  await f.screenshot(path.join(f.shots, '23-plugin-matrix-installed.png'));
  f.fixture.advance();
  await f.click(button('Update', row));
  await assertReview('update', clients);
  await f.screenshot(path.join(f.shots, '24-plugin-matrix-update-review.png'));
  await f.reviewAndApply(panel);
  await rememberOperation('update');
  current = await entry(clients, 2);
  for (const client of clients) {
    const observed = await observeMatrixNative(
      f,
      client,
      'updated',
      current!.bindings.find((binding) => binding.client === client),
      2
    );
    assert.equal(
      observed.nativeIdentity,
      evidence.installation[client].nativeIdentity,
      'Update must retain native plugin identity'
    );
    assert.equal(
      observed.nativeSource,
      evidence.installation[client].nativeSource,
      'Update must retain the reviewed native target'
    );
    evidence.update[client] = observed;
  }
  await f.screenshot(path.join(f.shots, '25-plugin-matrix-updated.png'));
  const remaining = new Set(clients);
  for (const client of clients) {
    await f.selectAgent(panel, labels[client]);
    await f.click(button('Remove', row));
    let nativePrerequisite;
    if (client === 'codex') {
      const dialog: UiLocator = { selector: '[role=dialog]' };
      await f.wait(
        async () =>
          (await inspectElement(f.cdp, button('Review confirmed removal', dialog)))?.visible,
        'Codex external-removal review'
      );
      assert(
        (await inspectElement(f.cdp, button('Apply changes', dialog)))?.disabled,
        'Codex removal must remain fenced until the native prerequisite is acknowledged'
      );
      nativePrerequisite = await removeMatrixCodexNative(f, evidence.update.codex);
      await f.click({ selector: '[role=checkbox]', within: dialog });
      await f.click(button('Review confirmed removal', dialog));
    }
    await assertReview('remove', [client]);
    await f.reviewAndApply(panel);
    await rememberOperation(`remove-${client}`);
    remaining.delete(client);
    current = await entry([...remaining], 2);
    const observations: Record<string, MatrixNativeObservation> = {};
    for (const target of clients) {
      observations[target] = await observeMatrixNative(
        f,
        target,
        `after-${client}-removal`,
        current?.bindings.find((binding) => binding.client === target),
        2,
        evidence.update[target]
      );
    }
    evidence.removals[client] = {
      removedThroughUI: true,
      nativePrerequisite,
      remaining: [...remaining],
      observations,
    };
    await f.screenshot(path.join(f.shots, `26-plugin-matrix-${client}-removed.png`));
  }
  evidence.status = 'passed';
}
