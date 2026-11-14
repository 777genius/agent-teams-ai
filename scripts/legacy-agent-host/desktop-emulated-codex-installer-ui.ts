import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { readDesktopEmulatedCodexInstallation, readDesktopEmulatedCodexInstallerLog, verifyDesktopEmulatedCodexInstaller } from './desktop-emulated-codex-installer-fixture.ts';
import { json, jsonDigest, record, rows } from './desktop-resume-records.ts';
import { desktopJsLiteral as literal } from './desktop-ui-controls.ts';
import type { prepareDesktopEmulatedRuntimeFixture } from './desktop-emulated-runtime-fixture.ts';
import type { createDesktopUiControls, UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;
const array = (value: unknown) => { assert.ok(Array.isArray(value)); return value.map(record); };

/** Existing model-picker Update controls invoke the stock installer and Host source publication. */
export async function runDesktopEmulatedCodexInstallerUi(cdp: UiCdpPort, options: {
  fixture: Awaited<ReturnType<typeof prepareDesktopEmulatedRuntimeFixture>>;
  ui: ReturnType<typeof createDesktopUiControls>; assertOwnedRenderer(): void;
  assertPriorRuntime(phase: string): Promise<void>;
}) {
  const { fixture, ui } = options, selected = fixture.emulatedRuntime.installer;
  assert.ok(selected); assert.equal(fixture.emulatedRuntime.variant, 'installer');
  assert.equal(fixture.emulatedRuntime.provider, 'codex');
  const proof: Row = { status: 'INCOMPLETE', nativeQualification: false,
    scope: 'One original Update from TEST A0.162 to TEST B0.169 through stock package download/extraction/version check, manifest and Host publication while A stays alive' };
  const screenshot = async (name: string) => {
    const image = record(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
    assert.equal(typeof image.data, 'string'); const path = join(fixture.root, `ui-emulated-selection-installer-${name}.png`);
    await writeFile(path, Buffer.from(String(image.data), 'base64'), { mode: 0o600, flag: 'wx' });
    return { path, sha256: await fileDigest(path) };
  };
  const indexPath = join(fixture.root, 'hoststore/runtime-sources/index.json');
  const indexBytes = () => readFile(indexPath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  const readStatus = async () => {
    options.assertOwnedRenderer();
    return record(await cdp.evaluate('window.electronAPI.codexRuntime.getStatus()'));
  };
  const sourceBeforeRead = await indexBytes();
  assert.equal(await readDesktopEmulatedCodexInstallation(selected), undefined);
  const initial = await readStatus();
  assert.equal(initial.state, 'ready'); assert.equal(initial.installed, true); assert.equal(initial.source, 'captured-host');
  assert.equal(initial.version, selected.binaryVersionA); assert.equal(initial.latestVersion, selected.binaryVersionB);
  assert.equal(initial.updateAvailable, true); assert.equal(initial.binaryPath, undefined);
  assert.match(String(initial.sourceRevision), /^[a-f0-9]{64}$/u);
  assert.deepEqual(await indexBytes(), sourceBeforeRead, 'GET measures the seed and never publishes a source');
  assert.equal(await readDesktopEmulatedCodexInstallation(selected), undefined);
  const registryBefore = await readDesktopEmulatedCodexInstallerLog(selected.registryLog);
  assert.equal(registryBefore.filter(row => row.event === 'armed').length, 1);
  assert.ok(registryBefore.some(row => row.event === 'response' && row.kind === 'latest'));
  assert.equal(registryBefore.some(row => row.kind === 'platform' || row.kind === 'tarball'), false);
  const invocationsBefore = await readDesktopEmulatedCodexInstallerLog(selected.invocationLog);
  assert.ok(invocationsBefore.some(row => row.kind === 'version' && row.executable === selected.executable.path && row.version === selected.binaryVersionA));
  const notice = '[data-testid="codex-runtime-update-notice"]';
  await ui.waitRead(`document.querySelector(${literal(notice)})?.textContent.includes(${literal(selected.binaryVersionA)})&&document.querySelector(${literal(notice)})?.textContent.includes(${literal(selected.binaryVersionB)})`, 'original measured A to B Update notice');
  await ui.scrollTo(`${notice} button`, 'original Codex Update notice');
  await ui.click(`${notice} button`, 'open original Codex Update dialog');
  const updateLabel = await ui.waitRead(`(()=>{const rows=[...document.querySelectorAll('[role="dialog"] button')].filter(e=>e.textContent.trim().startsWith('Update ')&&e.textContent.includes(${literal(selected.binaryVersionA)})&&e.textContent.includes(${literal(selected.binaryVersionB)}));return rows.length===1&&!rows[0].disabled?rows[0].textContent.trim():null})()`, 'original measured Update action');
  assert.equal(typeof updateLabel, 'string'); proof.beforeScreenshot = await screenshot('before');
  await options.assertPriorRuntime('before-original-installer-update');
  await ui.scrollTo('[role="dialog"] button', 'original Codex Update submit', String(updateLabel));
  await ui.click('[role="dialog"] button', 'install original Codex package exactly once', String(updateLabel));
  await ui.waitRead(`document.querySelector('[role="dialog"]')?.textContent.includes('Codex is ready for new launches.')&&document.querySelector('[role="dialog"] [role="progressbar"]')?.getAttribute('aria-valuenow')==='100'`, 'original installation and Host publication ready', 90_000);
  const installed = await readDesktopEmulatedCodexInstallation(selected); assert.ok(installed);
  const current = record(await cdp.evaluate('window.__agentTeamsDevStore.getState().codexRuntimeStatus'));
  assert.equal(current.state, 'ready'); assert.equal(current.source, 'app-managed'); assert.equal(current.installed, true);
  assert.equal(current.version, selected.binaryVersionB); assert.equal(current.updateAvailable, false); assert.equal(current.binaryPath, undefined);
  assert.equal(record(current.progress).phase, 'ready'); assert.notEqual(current.sourceRevision, initial.sourceRevision);
  const index = await json(indexPath), { digest: indexDigest, ...indexBody } = index;
  assert.equal(indexDigest, jsonDigest(indexBody)); assert.equal(array(index.records).length, 1); assert.equal(array(index.current).length, 1);
  const publication = array(index.records)[0]!, candidate = record(publication.candidate);
  assert.equal(publication.previousRevision, initial.sourceRevision); assert.equal(publication.revision, current.sourceRevision);
  assert.equal(candidate.sourceKind, 'app-managed'); assert.deepEqual(candidate.executable, installed.executable);
  assert.deepEqual(record(candidate.nativeCli).executable, installed.executable); assert.equal(record(candidate.nativeCli).version, selected.binaryVersionB);
  const commands = (await rows(join(fixture.root, 'hoststore/management-commands'))).filter(row => row.kind === 'runtime.source');
  assert.equal(commands.length, 1); assert.equal(commands[0]!.phase, 'published');
  assert.equal(commands[0]!.commandId, publication.commandId); assert.equal(commands[0]!.revision, publication.revision);
  const registry = await readDesktopEmulatedCodexInstallerLog(selected.registryLog);
  assert.equal(registry.filter(row => row.event === 'armed').length, 1);
  const platform = registry.filter(row => row.event === 'response' && row.kind === 'platform');
  const download = registry.filter(row => row.event === 'response' && row.kind === 'tarball');
  assert.equal(platform.length, 1); assert.equal(download.length, 1); assert.ok(Number(download[0]!.sequence) > Number(platform[0]!.sequence));
  assert.equal(download[0]!.sha256, selected.tarball.sha256);
  const invocations = await readDesktopEmulatedCodexInstallerLog(selected.invocationLog);
  assert.ok(invocations.some(row => row.kind === 'version' && row.version === selected.binaryVersionB && String(row.executable).startsWith(dirnameOfManifest(selected.manifestPath) + '/installing-')),
    'the stock installer really executed staged TEST B before publishing the manifest');
  assert.ok(invocations.some(row => row.kind === 'version' && row.version === selected.binaryVersionB && row.executable === installed.executable.path),
    'Main and Host verify the exact immutable installed TEST B');
  await options.assertPriorRuntime('after-original-installer-ready');
  const publishedBytes = await indexBytes(), manifestDigest = installed.manifestSha256;
  const readback = await readStatus();
  assert.equal(readback.sourceRevision, current.sourceRevision); assert.equal(readback.version, selected.binaryVersionB);
  assert.equal(readback.source, 'app-managed'); assert.equal(readback.binaryPath, undefined);
  assert.deepEqual(await indexBytes(), publishedBytes); assert.equal(await fileDigest(selected.manifestPath), manifestDigest);
  proof.readyScreenshot = await screenshot('ready');
  await ui.click('[role="dialog"] button', 'close original completed Update dialog', 'Close');
  await ui.waitRead(`!document.querySelector('[role="dialog"]')`, 'original Update completed dialog closes');
  Object.assign(proof, { status: 'PASS', initialStatus: initial, installedStatus: current, readbackStatus: readback,
    installed, publication, command: commands[0], sourceWrites: 1, updateClicks: 1, downloads: 1,
    initialGetSourceWrites: 0, finalGetSourceWrites: 0, originalRuntimeRetained: true, registry, invocations,
    fixturePins: await verifyDesktopEmulatedCodexInstaller(selected) });
  return proof;
}

function dirnameOfManifest(path: string): string {
  assert.ok(path.endsWith('/current.json')); return path.slice(0, -'/current.json'.length);
}

/** Settings uses the same stock Update dialog; after B, its provider row and Manage panel read B without another acquisition. */
export async function readDesktopEmulatedCodexInstallerSettingsUi(cdp: UiCdpPort, options: {
  fixture: Awaited<ReturnType<typeof prepareDesktopEmulatedRuntimeFixture>>;
  ui: ReturnType<typeof createDesktopUiControls>; expectedStatus: Row;
  assertOwnedRenderer(): void; assertPriorRuntime(phase: string): Promise<void>;
}) {
  const { fixture, ui, expectedStatus } = options, selected = fixture.emulatedRuntime.installer;
  assert.ok(selected); assert.equal(fixture.emulatedRuntime.variant, 'installer');
  const installed = await readDesktopEmulatedCodexInstallation(selected); assert.ok(installed);
  const indexPath = join(fixture.root, 'hoststore/runtime-sources/index.json'), originalIndex = await readFile(indexPath);
  const screenshot = async (name: string) => {
    const image = record(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
    assert.equal(typeof image.data, 'string'); const path = join(fixture.root, `ui-emulated-selection-installer-settings-${name}.png`);
    await writeFile(path, Buffer.from(String(image.data), 'base64'), { mode: 0o600, flag: 'wx' });
    return { path, sha256: await fileDigest(path) };
  };
  await options.assertPriorRuntime('before-original-installer-settings');
  await ui.click('button[aria-label="More actions"]', 'open original Settings menu after Update');
  await ui.click('button', 'open original Settings after Update', 'Settings');
  await ui.scrollTo('[data-testid="settings-nav-providers"]', 'original Providers settings after Update');
  await ui.click('[data-testid="settings-nav-providers"]', 'open original Providers settings after Update');
  const page = '[data-testid="provider-settings-page"]', manage = `${page} [data-testid="runtime-manage-codex"]`;
  await ui.waitRead(`Boolean(document.querySelector(${literal(page)})?.getClientRects().length)`, 'visible original Providers page');
  const expand = `${page} [role="button"][aria-label="Expand provider details"]`;
  if (await cdp.evaluate(`Boolean(document.querySelector(${literal(expand)}))`)) {
    await ui.scrollTo(expand, 'original provider details after Update'); await ui.click(expand, 'expand original provider details after Update');
  }
  const provider = record(await ui.waitRead(`(()=>{const button=document.querySelector(${literal(manage)}),row=button?.parentElement?.parentElement;
    return button&&!button.disabled&&row?.textContent.includes('ChatGPT account ready')?
      {ready:true,actions:[...row.querySelectorAll('button')].map(e=>e.textContent.trim())}:null})()`, 'original Settings Codex provider is ready after Update'));
  assert.ok(Array.isArray(provider.actions));
  assert.equal(provider.actions.some(value => /^(?:Install|Update|Retry install)(?:\s|$)/u.test(String(value))), false);
  const pageScreenshot = await screenshot('page');
  await ui.scrollTo(manage, 'original Codex Manage after Update'); await ui.click(manage, 'open original Codex Manage after Update');
  await ui.waitRead(`(()=>{const dialog=document.querySelector('[role="dialog"]');return dialog?.textContent.includes('TEST@example.invalid')&&
    dialog.textContent.includes('App-server: healthy')&&[...dialog.querySelectorAll('[role="tab"][aria-selected="true"]')].some(e=>e.textContent.trim()==='Codex')})()`, 'original Settings Codex account and runtime healthy');
  assert.equal(await cdp.evaluate(`[...document.querySelectorAll('[role="dialog"] button')].some(e=>/^(?:Install|Update|Retry install)(?:\\s|$)/u.test(e.textContent.trim()))`), false);
  options.assertOwnedRenderer();
  const status = record(await cdp.evaluate('window.electronAPI.codexRuntime.getStatus()'));
  assert.equal(status.state, 'ready'); assert.equal(status.installed, true); assert.equal(status.source, 'app-managed');
  assert.equal(status.version, selected.binaryVersionB); assert.equal(status.sourceRevision, expectedStatus.sourceRevision);
  assert.equal(status.updateAvailable, false); assert.equal(status.binaryPath, undefined);
  assert.deepEqual(await readFile(indexPath), originalIndex);
  assert.equal(await fileDigest(selected.manifestPath), installed.manifestSha256);
  const registry = await readDesktopEmulatedCodexInstallerLog(selected.registryLog);
  assert.equal(registry.filter(row => row.event === 'response' && row.kind === 'platform').length, 1);
  assert.equal(registry.filter(row => row.event === 'response' && row.kind === 'tarball').length, 1);
  await options.assertPriorRuntime('after-original-installer-settings');
  const dialogScreenshot = await screenshot('dialog');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await ui.waitRead(`!document.querySelector('[role="dialog"]')`, 'close original Settings Codex Manage');
  return { status: 'PASS', scope: 'Settings Providers and Codex Manage show the healthy installed runtime; exact version is read through original getStatus',
    visibleVersionClaimed: false, providerReady: true, accountHealthy: true, manageOpened: true, installActionAbsent: true,
    finalStatus: status, sourceWrites: 0, extraDownloads: 0, originalRuntimesRetained: true, pageScreenshot, dialogScreenshot };
}
