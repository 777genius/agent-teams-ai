import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { parseManagedPreferences } from '../../src/features/runtime-provider-management/core/domain/managedProviderPreferences.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { replace } from './desktop-mixed-dialog-settings.ts';
import { verifyDesktopV2ManagementFixture } from './desktop-opencode-v2-management-fixture.ts';
import { desktopV2ProviderId, desktopV2RejectedKey, desktopV2SelectedKey } from './desktop-opencode-v2-management-model.ts';
import { assertDesktopV2ManagementSourceHistory, bindDesktopV2ManagementReceipt, captureDesktopV2ManagementAuthority,
  readDesktopV2ManagementCommands, readDesktopV2ManagementJson } from './desktop-opencode-v2-management-records.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';

import type { DesktopV2ManagementFixture } from './desktop-opencode-v2-management-fixture.ts';
import type { DesktopV2ManagementModel, DesktopV2ManagementStep } from './desktop-opencode-v2-management-model.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
async function privateJson(path: string, optional = false): Promise<Record<string, unknown> | null> {
  try {
    const info = await stat(path);
    assert.ok(info.isFile() && info.size <= 2 * 1024 * 1024);
    return record(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Existing Settings inputs reach Main and the actual captured V2 engine. No IPC mutation shortcut. */
export async function runDesktopV2ManagementUi(cdp: UiCdpPort, options: {
  fixture: DesktopV2ManagementFixture;
  model: DesktopV2ManagementModel;
  evidence: Record<string, unknown>;
  assertOwnedRenderer(): void;
  observeNative(step?: DesktopV2ManagementStep): Promise<void>;
}) {
  const { fixture, model } = options, root = fixture.root;
  const authority = captureDesktopV2ManagementAuthority(root,
    readTeamHostProfile(fixture.profilePath, fixture.pins.profileSha256), await privateJson(fixture.descriptorPath));
  const steps: Record<string, unknown>[] = [], effects: Record<string, unknown>[] = [];
  const proof: Record<string, unknown> = { status: 'INCOMPLETE', steps, effects,
    scope: 'Original Electron V2 API-key rejection/replacement, model test, global/project defaults, inheritance and renderer reload',
    excluded: ['Claude/Codex execution', 'vendor authentication/inference', 'native V2 OAuth/forget', 'release qualification'] };
  options.evidence.opencodeV2ManagementUiProof = proof;
  const ui = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer,
    step: value => steps.push({ monotonicMs: Math.round(performance.now()), ...value }) });
  const screenshot = async (name: string) => {
    const captured = record(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
    assert.equal(typeof captured.data, 'string');
    const path = join(root, name);
    await writeFile(path, Buffer.from(captured.data as string, 'base64'), { mode: 0o600, flag: 'wx' });
    return { path, sha256: await fileDigest(path) };
  };
  const commands = () => readDesktopV2ManagementCommands(root);
  const preferencePaths = [join(root, 'preferences/global/global-runtime-preferences.json'),
    join(root, 'preferences/workspace/agent-teams-runtime-preferences.json'),
    join(root, 'preferences/workspace-other/agent-teams-runtime-preferences.json')];
  const preferences = () => Promise.all(preferencePaths.map(async path => {
    const value = await privateJson(path, true);
    return value ? { sha256: await fileDigest(path), value: parseManagedPreferences(value) } : null;
  }));
  const modelA = desktopV2ProviderId + '/TEST-model', modelB = desktopV2ProviderId + '/TEST-project-model';
  assert.deepEqual(await preferences(), [null, null, null]);
  assert.equal(await privateJson(fixture.v2Management.authPath, true), null);
  model.setProbeObserver(async step => { options.assertOwnedRenderer(); await options.observeNative(step); });
  const originalStep = async (step: DesktopV2ManagementStep, selector: string, label: string) => {
    options.assertOwnedRenderer(); await options.observeNative();
    const before = new Set((await commands()).map(row => row.commandId));
    model.begin(step);
    await ui.scrollTo(selector, label); await ui.click(selector, label);
    // The original effect is never resent. Default intents also join their existing saving presentation.
    const deadline = Date.now() + 250_000;
    let receipt: Awaited<ReturnType<typeof commands>>[number] | undefined;
    do {
      options.assertOwnedRenderer();
      const observed = await commands();
      assert.ok(observed.every(row => ['runtime.source', 'credential.set', 'model.probe'].includes(row.kind)));
      const current = observed.filter(row => !before.has(row.commandId) && row.kind !== 'runtime.source');
      assert.ok(current.length <= 1, 'one original command per Settings intent');
      const selected = current[0];
      if (selected && !selected.resourceHeld && (selected.phase === 'completed' ||
          selected.kind === 'credential.set' && selected.phase === 'held' && selected.terminalRejection === true)) {
        let intentComplete = true;
        if (step === 'global-default' || step === 'project-default') {
          assert.ok(Date.now() < deadline, 'original default intent remains within its deadline');
          const modelId = step === 'global-default' ? modelA : modelB;
          const row = dialog + ' [data-testid=' + JSON.stringify('runtime-provider-model-row-' + modelId) + ']';
          options.assertOwnedRenderer();
          intentComplete = await cdp.evaluate('(() => { const rows=[...document.querySelectorAll(' +
            desktopJsLiteral(row) + ')]; if(rows.length!==1)return false;' +
            'const buttons=[...rows[0].querySelectorAll("button[aria-pressed]")]; if(buttons.length!==1)return false;' +
            'const button=buttons[0], rect=button.getBoundingClientRect();' +
            'return rect.width>0&&rect.height>0&&button.getAttribute("aria-pressed")==="true"&&' +
            '!button.querySelector(":scope > svg.animate-spin"); })()') === true;
          options.assertOwnedRenderer();
          assert.ok(Date.now() < deadline, 'original default intent completes before its deadline');
        }
        if (intentComplete) { receipt = selected; break; }
      }
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.ok(receipt, 'original V2 Settings command settled before its deadline');
    const selectedSource = bindDesktopV2ManagementReceipt(authority, await commands(), receipt, step);
    assert.equal(receipt.providerId, desktopV2ProviderId);
    if (step === 'reject-key') {
      assert.equal(receipt.kind, 'credential.set'); assert.equal(receipt.phase, 'held');
      if (receipt.kind !== 'credential.set') throw new Error('Original credential receipt unavailable');
      assert.equal(receipt.terminalRejection, true);
      assert.equal(receipt.openCodeV2?.phase, 'probe-completed');
      assert.equal(receipt.openCodeV2.verification?.ok, false);
    } else {
      assert.equal(receipt.phase, 'completed');
      if (step === 'connect-key') assert.equal(receipt.kind, 'credential.set');
      else {
        assert.equal(receipt.kind, 'model.probe');
        if (receipt.kind !== 'model.probe') throw new Error('Original model receipt unavailable');
        assert.equal(receipt.ok, true);
        assert.equal(receipt.modelId, step === 'global-default' ? modelA : modelB);
      }
    }
    model.finish(step); await options.observeNative();
    effects.push({ step, commandId: receipt.commandId, kind: receipt.kind, phase: receipt.phase,
      resourceHeld: receipt.resourceHeld, source: selectedSource.evidence });
  };
  const dialog = '[role="dialog"]';
  const directoryRow = `${dialog} [data-testid="runtime-provider-directory-row-${desktopV2ProviderId}"]`;
  const modelsTab = async () => {
    const selector = `${dialog} [role="tab"][id$="-trigger-models"]`;
    await ui.scrollTo(selector, 'original Models tab'); await ui.click(selector, 'original Models tab');
    let last: Record<string, boolean> | null = null;
    try {
      await ui.waitRead(`(() => ({
        inheritanceCard: Boolean(document.querySelector('${dialog} [data-testid="opencode-default-inheritance"]')),
        modelsTabActive: document.querySelector(${desktopJsLiteral(selector)})?.getAttribute('data-state') === 'active',
        modelsTabDisabled: Boolean(document.querySelector(${desktopJsLiteral(selector)})?.matches(':disabled')),
        refreshSpinner: Boolean(document.querySelector('${dialog} button.mb-1 .animate-spin')),
        legacyModelsPanel: Boolean(document.querySelector('${dialog} [data-testid="runtime-provider-legacy-models"]')),
        projectContextSelector: Boolean(document.querySelector('${dialog} [data-testid="runtime-provider-project-context-trigger"]')),
        publicError: Boolean(document.querySelector('${dialog} [data-testid="runtime-provider-error"]')),
        publicWarning: Boolean(document.querySelector('${dialog} [data-testid="runtime-provider-warning"]'))
      }))()`, 'original default inheritance', 30_000, value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const observed = (key: string) => Object.getOwnPropertyDescriptor(value, key)?.value === true;
        last = {
          inheritanceCard: observed('inheritanceCard'), modelsTabActive: observed('modelsTabActive'),
          modelsTabDisabled: observed('modelsTabDisabled'), refreshSpinner: observed('refreshSpinner'),
          legacyModelsPanel: observed('legacyModelsPanel'), projectContextSelector: observed('projectContextSelector'),
          publicError: observed('publicError'), publicWarning: observed('publicWarning'),
        };
        return last.inheritanceCard === true;
      });
    } catch (error) {
      proof.modelsTabFailure = last;
      try {
        console.error(JSON.stringify({ kind: 'TEST_V2_MANAGEMENT_MODELS_WAIT_FAILURE', observation: last }));
      } catch { /* Retain the original failed wait, including its original deadline. */ }
      throw error;
    }
  };
  const selectProject = async (name: 'workspace' | 'workspace-other') => {
    const selector = `${dialog} [data-testid="runtime-provider-project-context-trigger"]`;
    await ui.scrollTo(selector, 'original project context'); await ui.click(selector, 'original project context');
    await ui.click('[role="option"]', 'select original TEST project', name);
    await ui.waitRead(`document.querySelector(${desktopJsLiteral(selector)})?.textContent.trim()===${desktopJsLiteral(name)}`, 'selected project retained');
  };
  const defaultId = (type: 'base' | 'project', value: string, project: 'workspace' | 'workspace-other' = 'workspace') => ui.waitRead(
    `(() => {
      const cards = document.querySelectorAll('${dialog} [data-testid="opencode-default-inheritance"]');
      if (cards.length !== 1) return false;
      const labels = ${desktopJsLiteral(type === 'base' ? ['Change: Default model']
        : ['Use another model: This project: ' + project, 'Change: This project: ' + project])};
      const controls = [...cards[0].querySelectorAll('button')].filter(control => labels.includes(control.getAttribute('aria-label')));
      if (controls.length !== 1) return false;
      const row = ${type === 'base' ? 'controls[0].parentElement' : 'controls[0].parentElement?.parentElement'};
      if (!row || !cards[0].contains(row)) return false;
      const text = row.firstElementChild;
      const headline = text?.querySelectorAll(':scope > div.mt-1.break-all.text-sm.font-medium');
      const ids = text?.querySelectorAll(':scope > [data-testid="opencode-default-${type}-model-id"]');
      if (headline?.length !== 1 || !ids || ids.length > 1) return false;
      const displayed = ids.length === 1 ? ids[0] : headline[0];
      return displayed.textContent?.trim() === ${desktopJsLiteral(value)};
    })()`,
    'original ' + type + ' default');
  const openSettings = async () => {
    await ui.waitRead('Boolean(document.querySelector(\'button[aria-label="More actions"]\'))', 'original application menu');
    await ui.click('button[aria-label="More actions"]', 'original Settings menu');
    await ui.click('button', 'original Settings', 'Settings');
    await ui.click('[data-testid="settings-nav-providers"]', 'original Providers settings');
    const manage = '[data-testid="provider-settings-page"] [data-testid="runtime-manage-opencode"]';
    await ui.scrollTo(manage, 'original OpenCode Manage'); await ui.click(manage, 'original OpenCode Manage');
    await ui.waitRead(`Boolean(document.querySelector('${dialog} [data-testid="runtime-provider-tab-providers"]'))`, 'original OpenCode settings ready', 150_000);
  };
  await ui.observeInput(); await openSettings();
  await ui.click(`${dialog} [data-testid="runtime-provider-tab-providers"]`, 'original provider directory');
  await ui.scrollTo(`${directoryRow} button`, 'original API key Connect', 'Connect');
  await ui.click(`${directoryRow} button`, 'open original API key form', 'Connect');
  const input = `${directoryRow} form input[type="password"]`;
  await ui.waitRead(`Boolean(document.querySelector(${desktopJsLiteral(input)}))`, 'original API key input', 150_000);
  await replace(cdp, ui, input, desktopV2RejectedKey, 'rejected TEST key');
  await originalStep('reject-key', `${directoryRow} form button[type="submit"]`, 'submit rejected TEST key once');
  await ui.waitRead(`(() => {
    const error = document.querySelector('[data-testid="runtime-provider-setup-submit-error"]');
    return Boolean(error) && !/The new credential was not kept|the new credential is removed|the previous connection is restored/i.test(error.textContent ?? '');
  })()`, 'original key rejection visible');
  assert.deepEqual(await privateJson(fixture.v2Management.authPath), { [desktopV2ProviderId]: { type: 'api', key: desktopV2RejectedKey } });
  proof.rejectionScreenshot = await screenshot('ui-v2-management-rejected-key.png');
  await replace(cdp, ui, input, desktopV2SelectedKey, 'replacement TEST key');
  await originalStep('connect-key', `${directoryRow} form button[type="submit"]`, 'submit replacement TEST key once');
  await ui.waitRead(`!document.querySelector('${directoryRow} form')&&document.querySelector('${directoryRow}')?.textContent.includes('Connected')`, 'original successful connection visible', 150_000);
  assert.deepEqual(await privateJson(fixture.v2Management.authPath), { [desktopV2ProviderId]: { type: 'api', key: desktopV2SelectedKey } });
  const authSha256 = await fileDigest(fixture.v2Management.authPath);
  assert.equal(await cdp.evaluate(`document.body.innerText.includes(${desktopJsLiteral(desktopV2SelectedKey)})`), false);
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('${directoryRow} input[aria-label="Authorization code"]'))`), false);
  proof.connectedScreenshot = await screenshot('ui-v2-management-connected.png');
  model.assertPassive(2);
  await modelsTab(); await selectProject('workspace');
  const choose = async (scope: 'global' | 'project') => {
    const label = scope === 'global' ? 'Change: Default model' : 'Use another model: This project: workspace';
    const control = `${dialog} button[aria-label=${JSON.stringify(label)}]`;
    await ui.scrollTo(control, label); await ui.click(control, label);
    const header = `${dialog} [data-testid="runtime-provider-directory-row-${desktopV2ProviderId}-header"]`;
    const content = `${dialog} [data-testid="runtime-provider-directory-row-${desktopV2ProviderId}-content"]`;
    if (!await cdp.evaluate(`Boolean(document.querySelector(${desktopJsLiteral(content)}))`)) {
      await ui.scrollTo(header, 'original configured provider'); await ui.click(header, 'expand original configured provider');
    }
    const selected = scope === 'global' ? modelA : modelB;
    await originalStep(scope === 'global' ? 'global-default' : 'project-default',
      `${dialog} [data-testid=${JSON.stringify('runtime-provider-model-row-' + selected)}] button[aria-label=${JSON.stringify('Select: ' + selected.split('/')[1] + ': Test this model successfully before using it.')}]`,
      'select original ' + scope + ' default once');
  };
  await choose('global'); await modelsTab(); await defaultId('base', modelA); await defaultId('project', modelA);
  const global = (await preferences())[0]!;
  assert.equal(global.value.defaultModelId, modelA);
  await choose('project');
  await originalStep('project-test', `${dialog} [data-testid=${JSON.stringify('runtime-provider-model-test-' + modelB)}]`, 'Test original project model once');
  await ui.waitRead(`document.querySelector('${dialog} [data-testid="runtime-provider-model-result-${modelB}"]')?.getAttribute('data-result-status')==='success'`, 'original model result visibly succeeded');
  await modelsTab(); await defaultId('project', modelB);
  const overridden = await preferences();
  assert.equal(overridden[0]!.sha256, global.sha256); assert.equal(overridden[1]!.value.defaultModelId, modelB); assert.equal(overridden[2], null);
  proof.projectScreenshot = await screenshot('ui-v2-management-project-override.png');
  await selectProject('workspace-other'); await defaultId('project', modelA, 'workspace-other');
  assert.equal((await preferences())[2], null);
  await selectProject('workspace'); await defaultId('project', modelB);
  const clear = `${dialog} button[aria-label="Use default: This project: workspace"]`;
  await ui.scrollTo(clear, 'original clear project override'); await ui.click(clear, 'clear original project override once');
  await defaultId('project', modelA);
  const finalPreferences = await preferences();
  assert.equal(finalPreferences[0]!.sha256, global.sha256); assert.equal(finalPreferences[1]!.value.defaultModelId, null); assert.equal(finalPreferences[2], null);
  model.assertComplete();
  proof.inheritanceScreenshot = await screenshot('ui-v2-management-inherited.png');
  const priorEpoch = await cdp.evaluate('performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(`performance.timeOrigin!==${desktopJsLiteral(priorEpoch)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`, 'actual renderer reload');
  await ui.observeInput(); await openSettings(); await modelsTab(); await selectProject('workspace');
  await defaultId('base', modelA); await defaultId('project', modelA);
  model.assertComplete(); assert.deepEqual(await preferences(), finalPreferences);
  assert.equal(await fileDigest(fixture.v2Management.authPath), authSha256, 'passive settings reload never mutates credentials');
  const finalCommands = await commands();
  const intents = finalCommands.filter(row => row.kind !== 'runtime.source');
  assert.equal(intents.length, 5); assert.ok(finalCommands.every(row => !row.resourceHeld));
  assert.deepEqual(intents.map(row => row.commandId).sort(), effects.map(row => row.commandId).sort());
  const sourceIndexPath = join(root, 'hoststore/runtime-sources/index.json');
  proof.sourcePublications = assertDesktopV2ManagementSourceHistory(authority, finalCommands,
    await readDesktopV2ManagementJson(sourceIndexPath, 8 * 1024 * 1024), true);
  proof.sourceIndexSha256 = await fileDigest(sourceIndexPath);
  proof.fixturePins = await verifyDesktopV2ManagementFixture(fixture);
  proof.modelRequests = model.requests;
  proof.preferences = finalPreferences.map((value, index) => ({ scope: ['global', 'project', 'other'][index], sha256: value?.sha256 ?? null,
    defaultModelId: value?.value.defaultModelId ?? null }));
  proof.credentials = { authSha256, rejectedKeyRetainedUntilExplicitReplacement: true, successfulReplacementVerified: true };
  proof.reloadedScreenshot = await screenshot('ui-v2-management-reloaded.png');
  await options.observeNative();
  proof.visualReview = 'original screenshots retained for independent inspection';
  proof.status = 'PASS';
}
