import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { fileDigest } from './desktop-backend-fixture.ts';
import { openOriginalCreateForm } from './desktop-create-config-ui-smoke.ts';
import { verifyDesktopEmulatedManagementFixture } from './desktop-emulated-management-fixture.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import { readDesktopCodexInitialAccount } from './desktop-codex-account-proof.ts';
import { runDesktopCodexLoginUiProof } from './desktop-codex-login-ui-proof.ts';
import type { prepareDesktopEmulatedManagementFixture } from './desktop-emulated-management-fixture.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const json = async (path: string) => record(JSON.parse(await readFile(path, 'utf8')));

/** Actual renderer inputs and canonical readback; the captured Node peer owns all provider replies. */
export async function runDesktopEmulatedManagementUi(
  cdp: UiCdpPort,
  options: {
    fixture: Awaited<ReturnType<typeof prepareDesktopEmulatedManagementFixture>>;
    evidence: Record<string, unknown>;
    assertOwnedRenderer(): void;
  },
) {
  const { fixture } = options;
  const screenshot = async (name: string) => {
    const capture = record(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
    assert.equal(typeof capture.data, 'string');
    const path = join(fixture.root, name);
    await writeFile(path, Buffer.from(String(capture.data), 'base64'), { mode: 0o600, flag: 'wx' });
    return { path, sha256: await fileDigest(path) };
  };
  if (fixture.emulatedManagement.kind === 'codex-login') {
    options.evidence.scope = 'Original Electron Codex Settings controls through preload/Main/Host/D and a pinned finite stdio peer: browser/device login, link/code copy, TEST opener, dialog reopen and original cancellation';
    await readDesktopCodexInitialAccount(cdp, options);
    await runDesktopCodexLoginUiProof(cdp, { ...options, execution: 'finite-protocol-peer' });
    const proof = record(options.evidence.codexLoginUi);
    proof.fixturePins = await verifyDesktopEmulatedManagementFixture(fixture);
    proof.finalScreenshot = await screenshot('ui-emulated-codex-login-cancelled.png');
    proof.visualReview = 'original signed-out screenshot retained for independent inspection';
    return;
  }
  const steps: Record<string, unknown>[] = [];
  const proof: Record<string, unknown> = { status: 'INCOMPLETE', steps,
    scope: 'Original Create model and effort selection, save-only Host persistence, renderer reload and Settings credential controls using the pinned TEST HTTP peer',
    excluded: ['native provider execution', 'vendor authentication', 'team launch', 'release qualification'] };
  options.evidence.emulatedManagementUiProof = proof;
  const ui = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer,
    step: value => steps.push({ monotonicMs: Math.round(performance.now()), ...value }) });
  const peerLog = async () => (await readFile(join(fixture.emulatedManagement.peerRoot, 'native-effects.ndjson'), 'utf8'))
    .trim().split('\n').filter(Boolean).map(line => record(JSON.parse(line)));
  const waitOriginal = async <T>(read: () => Promise<T>, ready: (value: T) => boolean, deadline: number, label: string) => {
    for (;;) {
      assert.ok(performance.now() < deadline, label + '; original action is never repeated');
      const value = await read();
      assert.ok(performance.now() < deadline, label + '; original observation exceeded its deadline');
      if (ready(value)) return value;
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  };
  const teamName = 'test-emulated-model-effort';
  const page = '[data-testid="create-team-page"]';
  await openOriginalCreateForm(cdp, ui, join(fixture.root, 'workspace'), teamName);
  await ui.scrollTo(`${page} #launch-team`, 'original immediate-launch checkbox');
  assert.equal(await cdp.evaluate(`document.querySelector('${page} #launch-team')?.getAttribute('data-state')`), 'checked');
  await ui.click(`${page} #launch-team`, 'select original save-only Create');
  await ui.waitRead(`document.querySelector('${page} #launch-team')?.getAttribute('data-state')==='unchecked'`, 'save-only selected');
  const lead = `${page} button[aria-label*=" provider,"]`;
  await ui.scrollTo(lead, 'original lead model selector');
  await ui.click(lead, 'expand original lead model selector');
  const provider = `${page} [data-testid="team-model-selector-provider-nav-opencode"]`;
  await ui.scrollTo(provider, 'original OpenCode provider tab');
  await ui.click(provider, 'select original OpenCode provider tab');
  const source = `${page} [data-testid="team-model-selector-provider-nav-local-models"]`;
  await ui.scrollTo(source, 'original configured local model sources');
  await ui.click(source, 'select original configured local model sources');
  const model = `${page} [data-testid="team-model-selector-model-option"][aria-label^="TEST-model"]`;
  await ui.waitRead(`(()=>{const rows=[...document.querySelectorAll(${desktopJsLiteral(model)})];return rows.length===1&&rows[0].getAttribute('aria-disabled')!=='true'})()`, 'one selectable captured TEST model');
  await ui.scrollTo(model, 'original TEST model option');
  await ui.click(model, 'select original TEST model option');
  const effortRead = `(()=>{const selected=document.querySelector('${page} #lead-effort');return selected?{selected:selected.textContent.trim(),options:[...selected.parentElement.querySelectorAll('button')].map(e=>({label:e.textContent.trim(),disabled:e.disabled}))}:null})()`;
  await ui.waitRead(`Boolean(document.querySelector('${page} #lead-effort'))`, 'original effort controls');
  assert.deepEqual(record(await cdp.evaluate(effortRead)).options,
    ['Default', 'Low', 'High'].map(label => ({ label, disabled: false })));
  await ui.scrollTo(`${page} #lead-effort`, 'original captured effort choices');
  await ui.click(`${page} div:has(> #lead-effort) > button`, 'select High through original effort control', 'High');
  await ui.waitRead(`document.querySelector('${page} #lead-effort')?.textContent.trim()==='High'`, 'High remains selected');
  proof.selectionScreenshot = await screenshot('ui-emulated-model-effort-selected.png');
  await ui.scrollTo(`${page} button`, 'original save-only Create action', 'Create');
  await ui.click(`${page} button`, 'save original model and effort once', 'Create');
  await ui.waitRead(`!document.querySelector('${page} #team-name')`, 'original Create closes after save', 60_000);
  const ownerPath = join(fixture.root, 'hoststore/teams', teamName, '.host-owner/state.json');
  const owner = await json(ownerPath);
  const saved = record(owner.savedSettings);
  assert.equal(saved.providerId, 'opencode'); assert.equal(saved.model, 'TEST-api/TEST-model');
  assert.equal(saved.effort, 'high'); assert.equal(saved.cwd, join(fixture.root, 'workspace'));
  assert.deepEqual(owner.runtimeCaptures ?? [], [], 'save-only never allocates a Runtime');
  const registryDirectory = join(fixture.root, 'hoststore/.host-team-registry/records');
  const registry = await Promise.all((await readdir(registryDirectory)).filter(name => /^[a-f0-9]{64}\.json$/u.test(name))
    .map(name => json(join(registryDirectory, name))));
  assert.equal(registry.length, 1); assert.equal(registry[0]!.phase, 'published');
  assert.equal(record(registry[0]!.record).teamName, teamName);
  proof.savedSelection = { providerId: saved.providerId, model: saved.model, effort: saved.effort };
  proof.creationReceipt = registry[0];
  const before = await cdp.evaluate('performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(`performance.timeOrigin!==${JSON.stringify(before)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`, 'new renderer after real reload');
  await ui.observeInput();
  await ui.waitRead('Boolean(document.querySelector(\'button[aria-label="More actions"]\'))', 'reloaded application menu');
  await ui.click('button[aria-label="More actions"]', 'open reloaded application menu');
  await ui.click('button', 'reopen original Teams list', 'Teams');
  await ui.waitRead(`document.body.innerText.includes(${desktopJsLiteral(teamName)})`, 'saved Team visible after reload');
  assert.deepEqual(await json(ownerPath), owner, 'reload preserves the original saved model and effort');
  assert.equal((await readdir(registryDirectory)).filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).length, 1);
  proof.reloadedScreenshot = await screenshot('ui-emulated-model-effort-reloaded.png');
  proof.selectionRetainedAfterReload = true;

  await ui.click('button[aria-label="More actions"]', 'open original Settings menu');
  await ui.click('button', 'open original Settings', 'Settings');
  await ui.scrollTo('[data-testid="settings-nav-providers"]', 'original Providers settings');
  await ui.click('[data-testid="settings-nav-providers"]', 'open original Providers settings');
  await ui.waitRead('Boolean(document.querySelector(\'[data-testid="provider-settings-page"]\'))', 'original Providers page');
  const expand = '[role="button"][aria-label="Expand provider details"]';
  if (await cdp.evaluate(`Boolean(document.querySelector(${desktopJsLiteral(expand)}))`)) {
    await ui.scrollTo(expand, 'original provider details');
    await ui.click(expand, 'expand original provider details');
  }
  await ui.scrollTo('[data-testid="runtime-manage-opencode"]', 'original OpenCode settings action');
  await ui.click('[data-testid="runtime-manage-opencode"]', 'open original OpenCode settings');
  await ui.waitRead('Boolean(document.querySelector(\'[data-testid="runtime-provider-tab-providers"]\'))', 'original provider directory tab');
  await ui.click('[data-testid="runtime-provider-tab-providers"]', 'show original provider directory');
  const apiRow = '[data-testid="runtime-provider-directory-row-TEST-api"]';
  await ui.scrollTo(`${apiRow} button`, 'original API key connection', 'Connect');
  await ui.click(`${apiRow} button`, 'open original API key form', 'Connect');
  await ui.waitRead(`Boolean(document.querySelector('${apiRow} form input[type="password"]'))`, 'original secret input');
  await ui.click(`${apiRow} form input[type="password"]`, 'focus original API key input');
  await cdp.send('Input.insertText', { text: 'TEST-api-key' });
  await ui.click(`${apiRow} form button[type="submit"]`, 'save TEST API key through original form');
  await ui.waitRead(`!document.querySelector('${apiRow} form')&&document.querySelector('${apiRow}')?.textContent.includes('Connected')`, 'original connected result');
  const authPath = join(fixture.emulatedManagement.peerRoot, 'data/opencode/auth.json');
  assert.deepEqual(await json(authPath), { 'TEST-api': { type: 'api', key: 'TEST-api-key' } });
  assert.equal(await cdp.evaluate('document.body.innerText.includes("TEST-api-key")'), false);
  proof.connectedScreenshot = await screenshot('ui-emulated-provider-connected.png');
  await ui.scrollTo(`${apiRow} button`, 'original saved credential removal', 'Remove saved credentials');
  await ui.click(`${apiRow} button`, 'remove TEST API key through original action', 'Remove saved credentials');
  await ui.waitRead(`(()=>{const buttons=[...document.querySelectorAll('${apiRow} button')];return buttons.some(e=>e.textContent.trim()==='Connect'&&!e.disabled)&&!buttons.some(e=>e.textContent.trim()==='Remove saved credentials'&&!e.disabled)})()`, 'original credential removal settles');
  assert.deepEqual(await json(authPath), {});
  const oauthRow = '[data-testid="runtime-provider-directory-row-TEST-oauth-code"]';
  await ui.scrollTo(`${oauthRow} button`, 'original OAuth connection', 'Connect');
  await ui.click(`${oauthRow} button`, 'open original OAuth form', 'Connect');
  await ui.waitRead(`Boolean(document.querySelector('${oauthRow} form button[type="submit"]'))`, 'original OAuth submit');
  const commandsDirectory = join(fixture.root, 'hoststore/management-commands');
  const oauthCommands = async () => (await Promise.all((await readdir(commandsDirectory)).filter(name => name.endsWith('.json'))
    .map(name => json(join(commandsDirectory, name))))).filter(row => row.kind === 'oauth');
  const openedRecords = async () => (await readFile(join(fixture.root, 'ui-emulated-external-open.ndjson'), 'utf8')
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    })).trim().split('\n').filter(Boolean).map(line => record(JSON.parse(line)));
  const openingDeadline = performance.now() + 30_000;
  await ui.click(`${oauthRow} form button[type="submit"]`, 'start TEST OAuth through original form');
  await ui.waitRead(`Boolean(document.querySelector('${oauthRow} input[aria-label="Authorization code"]'))`, 'original waiting-for-code UI', Math.max(1, openingDeadline - performance.now()));
  const pendingOAuth = await waitOriginal(async () => {
    const oauth = await oauthCommands(), opened = await openedRecords();
    assert.ok(oauth.length <= 1, 'At most one original OAuth command');
    assert.ok(opened.length <= 1, 'At most one original TEST browser dispatch');
    return { oauth, opened };
  }, value => value.oauth.length === 1 && value.opened.length === 1, openingDeadline, 'original OAuth browser dispatch');
  const originalOAuth = pendingOAuth.oauth[0]!;
  assert.equal(typeof originalOAuth.commandId, 'string');
  assert.equal(originalOAuth.phase, 'waiting-for-code'); assert.equal(originalOAuth.resourceHeld, true);
  assert.deepEqual(pendingOAuth.opened, [{ accepted: true, peerOnly: true }]);
  proof.oauthWaitingScreenshot = await screenshot('ui-emulated-oauth-waiting.png');
  const cancellationDeadline = performance.now() + 30_000;
  await ui.click(`${oauthRow} form button`, 'cancel original pending OAuth once', 'Cancel');
  await ui.waitRead(`!document.querySelector('${oauthRow} form')`, 'original OAuth form closes', Math.max(1, cancellationDeadline - performance.now()));
  const oauth = await waitOriginal(async () => {
    const current = await oauthCommands();
    assert.equal(current.length, 1);
    assert.equal(current[0]!.commandId, originalOAuth.commandId, 'Observe the original OAuth cancellation only');
    return current;
  }, value => value[0]!.phase === 'cancelled' && value[0]!.resourceHeld === false, cancellationDeadline, 'original OAuth cancellation settles');
  assert.deepEqual(await json(authPath), {}, 'cancelled OAuth never writes a credential');
  assert.equal(oauth.length, 1); assert.equal(oauth[0]!.phase, 'cancelled');
  assert.equal(oauth[0]!.resourceHeld, false);
  const effects = await peerLog();
  assert.equal(effects.filter(row => row.event === 'authorize').length, 1);
  assert.equal(effects.filter(row => row.event === 'credential-written' && row.providerId === 'TEST-api').length, 1);
  assert.equal(effects.filter(row => row.event === 'credential-forgotten' && row.providerId === 'TEST-api').length, 1);
  assert.equal(effects.filter(row => row.event === 'credential-written' && row.providerId === 'TEST-oauth-code').length, 0);
  const opened = await openedRecords();
  assert.deepEqual(opened, [{ accepted: true, peerOnly: true }]);
  proof.credentialEffects = effects.filter(row => ['authorize', 'credential-written', 'credential-forgotten'].includes(String(row.event)));
  proof.oauthCancellation = { phase: oauth[0]!.phase, resourceHeld: false, credentialAbsent: true, testOpenerCount: opened.length };
  const autoRow = '[data-testid="runtime-provider-directory-row-TEST-oauth-auto"]';
  const device = autoRow + ' [data-testid="runtime-provider-oauth-device-code"]';
  await ui.scrollTo(autoRow + ' button', 'original automatic OAuth connection', 'Connect');
  await ui.click(autoRow + ' button', 'open original automatic OAuth form', 'Connect');
  await ui.waitRead('Boolean(document.querySelector(' +
    desktopJsLiteral(autoRow + ' form button[type="submit"]') + '))', 'original automatic OAuth submit');
  const autoOpeningDeadline = performance.now() + 30_000;
  const autoRemaining = () => {
    const value = Math.floor(autoOpeningDeadline - performance.now());
    assert.ok(value > 0, 'original automatic OAuth observation deadline remains current');
    return value;
  };
  await ui.click(autoRow + ' form button[type="submit"]', 'start one original automatic OAuth');
  const automatic = await waitOriginal(async () => {
    const current = await oauthCommands(), currentOpened = await openedRecords();
    assert.ok(current.length <= 2, 'exactly the original manual and automatic OAuth commands');
    assert.ok(currentOpened.length <= 2, 'one TEST opener per original OAuth operation');
    const previous = current.find(row => row.commandId === originalOAuth.commandId);
    assert.ok(previous); assert.equal(previous.phase, 'cancelled'); assert.equal(previous.resourceHeld, false);
    const selected = current.filter(row => row.providerId === 'TEST-oauth-auto');
    assert.ok(selected.length <= 1, 'one original automatic OAuth command');
    return { command: selected[0], opened: currentOpened };
  }, value => value.command?.phase === 'completing' && value.command.resourceHeld === true &&
    value.opened.length === 2, autoOpeningDeadline, 'original automatic callback remains pending');
  const originalAuto = automatic.command!;
  assert.equal(typeof originalAuto.commandId, 'string');
  assert.notEqual(originalAuto.commandId, originalOAuth.commandId);
  assert.equal(originalAuto.completionMethod, 'auto');
  assert.equal(originalAuto.completionCommandId, originalAuto.commandId + ':auto');
  await ui.waitRead('(() => { const rows=[...document.querySelectorAll(' + desktopJsLiteral(device) +
    ')]; return rows.length===1 && rows[0].querySelector(".font-mono")?.textContent.trim()==="A7F0-835A"; })()',
    'original device code from the pending native callback', autoRemaining());
  const display = record(await cdp.evaluate('(() => { const row=document.querySelector(' +
    desktopJsLiteral(autoRow) + '); if(!row)return null; const buttons=[...row.querySelectorAll("form button")]' +
    '.filter(button=>button.textContent.trim()==="Cancel"); return {' +
    'privateTextAbsent:!row.textContent.includes("TEST-private"),' +
    'privateLinkAbsent:!row.querySelector("[data-testid=runtime-provider-oauth-authorization-link]"),' +
    'cancelEnabled:buttons.length===1&&!buttons[0].disabled }; })()'));
  assert.deepEqual(display, { privateTextAbsent: true, privateLinkAbsent: true, cancelEnabled: true });
  const autoBeforeCancel = (await peerLog()).filter(row => row.providerId === 'TEST-oauth-auto');
  assert.deepEqual(autoBeforeCancel.map(row => row.event), ['authorize', 'callback-start']);
  const copy = device + ' button[title]';
  await ui.scrollTo(copy, 'original device-code copy control');
  await ui.click(copy, 'copy original pending device code');
  await ui.waitRead('Boolean(document.querySelector(' + desktopJsLiteral(copy + ' svg.lucide-check') + '))',
    'original clipboard write acknowledged', autoRemaining());
  assert.ok(performance.now() < autoOpeningDeadline, 'copy acknowledges within the original observation deadline');
  proof.oauthDeviceWaitingScreenshot = await screenshot('ui-emulated-oauth-device-waiting.png');
  const autoCancellationDeadline = performance.now() + 30_000;
  await ui.click(autoRow + ' form button', 'cancel the original pending automatic OAuth', 'Cancel');
  await ui.waitRead('!document.querySelector(' + desktopJsLiteral(autoRow + ' form') + ')',
    'original automatic OAuth form closes', Math.max(1, autoCancellationDeadline - performance.now()));
  const finalOAuth = await waitOriginal(async () => {
    const current = await oauthCommands();
    assert.equal(current.length, 2);
    const previous = current.find(row => row.commandId === originalOAuth.commandId);
    assert.ok(previous); assert.equal(previous.phase, 'cancelled'); assert.equal(previous.resourceHeld, false);
    const selected = current.find(row => row.commandId === originalAuto.commandId);
    assert.ok(selected);
    assert.equal(selected.fingerprint, originalAuto.fingerprint);
    assert.equal(selected.completionCommandId, originalAuto.completionCommandId);
    return current;
  }, value => value.every(row => row.phase === 'cancelled' && row.resourceHeld === false),
    autoCancellationDeadline, 'same original automatic OAuth releases before completion');
  const finalEffects = await peerLog(), finalOpened = await openedRecords();
  assert.deepEqual(finalOpened, [{ accepted: true, peerOnly: true }, { accepted: true, peerOnly: true }]);
  assert.equal(finalEffects.filter(row => row.event === 'authorize').length, 2);
  assert.deepEqual(finalEffects.filter(row => row.providerId === 'TEST-oauth-auto').map(row => row.event),
    ['authorize', 'callback-start']);
  assert.equal(finalEffects.filter(row => row.event === 'credential-written' &&
    (row.providerId === 'TEST-oauth-code' || row.providerId === 'TEST-oauth-auto')).length, 0);
  assert.deepEqual(await json(authPath), {});
  for (const forbidden of ['TEST-private', 'A7F0-835A', 'authorizationUrl'])
    assert.equal(JSON.stringify(finalOAuth).includes(forbidden), false, 'private authorization stays out of Host receipts');
  proof.oauthDeviceCancellation = { phaseBeforeCancel: 'completing', phase: 'cancelled',
    resourceHeld: false, credentialAbsent: true, deviceCodeRendered: true, copyAcknowledged: true,
    ...display, testOpenerCount: finalOpened.length, authorizeCount: 1, callbackCount: 1 };

  proof.finalScreenshot = await screenshot('ui-emulated-management-final.png');
  proof.fixturePins = await verifyDesktopEmulatedManagementFixture(fixture);
  await writeFile(join(fixture.root, 'ui-emulated-management-effects.json'), JSON.stringify({ effects: finalEffects, oauth: finalOAuth }, null, 2), { mode: 0o600, flag: 'wx' });
  proof.status = 'PASS';
  proof.visualReview = 'original screenshots retained for independent inspection';
}
