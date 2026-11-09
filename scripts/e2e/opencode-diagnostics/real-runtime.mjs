// Genuine pinned runtime + controlled synthetic auth only. No live providers or inference.
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';


const SYNTHETIC_KEY = 'TEST-nonsecret-local-catalog-only';
const PROVIDER = 'deepinfra';

export async function prepareRealRuntimeFixture(data, repositoryRoot) {
  assert(data.root && path.basename(data.root).startsWith('opencode-diagnostics-e2e-'));
  const lock = JSON.parse(await readFile(path.join(repositoryRoot, 'runtime.lock.json'), 'utf8'));
  const asset = lock.assets[process.platform + '-' + process.arch];
  assert(asset, 'Pinned real runtime unavailable for this platform');
  const version = (await readFile(path.join(repositoryRoot, 'resources/runtime/VERSION'), 'utf8')).trim();
  assert.equal(version, lock.version, 'Staged runtime does not match the release pin');
  const runtime = path.join(repositoryRoot, 'resources/runtime', asset.binaryName);
  const opencode = process.env.REAL_OPENCODE_TEST_BINARY;
  assert(opencode && path.isAbsolute(opencode), 'Native real OpenCode binary required');
  assert(statSync(runtime, { throwIfNoEntry: false })?.isFile(), 'Pinned real runtime missing');
  assert(statSync(opencode, { throwIfNoEntry: false })?.isFile(), 'Native real OpenCode missing');
  data.realRuntime = true;
  data.runtimePin = lock.version;
  data.orchestrator = runtime;
  data.opencode = opencode;
  data.home = path.join(data.root, 'TEST-home');
  for (const dir of [data.home, data.userData, data.bin, data.temp]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  if (process.platform === 'win32') {
    // The HOME subtree contains test auth.json. Enforce a private Windows DACL.
    const { protectWindowsTestDirectory } = await import('../opencode-native-test-auth.ts');
    await protectWindowsTestDirectory(data.home);
  }
  const configDirectory = path.join(data.home, '.config/opencode');
  const authDirectory = path.join(data.home, '.local/share/opencode');
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await mkdir(authDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(configDirectory, 'opencode.jsonc'), JSON.stringify({
    plugin: [],
    provider: {
      [PROVIDER]: {
        options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: '{env:DEEPINFRA_API_KEY}' },
        models: { 'TEST-local-catalog-model': {
          name: 'TEST catalog model', limit: { context: 8192, output: 1024 },
        } },
      },
    },
  }), { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(authDirectory, 'auth.json'), JSON.stringify({
    [PROVIDER]: { type: 'api', key: SYNTHETIC_KEY },
  }), { flag: 'wx', mode: 0o600 });

  // The same app-owned install manifest used by the existing diagnostic E2E.
  // It points to a real V1 binary instead of the CLI fixture shim.
  data.openCodeManifest = path.join(data.userData, 'data/runtimes/opencode/current.json');
  await mkdir(path.dirname(data.openCodeManifest), { recursive: true });
  await writeFile(data.openCodeManifest, JSON.stringify({
    schemaVersion: 1,
    version: '1.18.31',
    platformPackage: 'native-v1-test',
    binaryPath: opencode,
    integrity: 'disposable-fixture',
    installedAt: new Date().toISOString(),
  }), { flag: 'wx' });
}

export function realRuntimeEnvironment(data) {
  assert(data.realRuntime === true);
  return {
    DEEPINFRA_API_KEY: SYNTHETIC_KEY,
    CLAUDE_MULTIMODEL_DATA_HOME: path.join(data.home, 'runtime-data'),
    CLAUDE_MULTIMODEL_CACHE_HOME: path.join(data.home, 'runtime-cache'),
    CLAUDE_CONFIG_DIR: path.join(data.home, '.claude'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
  };
}

/** Strictly display-only verification. Never authorize launch from a count. */
export function verifyRealProviderCountResponse(directory) {
  assert(directory && directory.runtimeId === 'opencode', 'Wrong provider directory runtime');
  assert.equal(directory.filter, 'connected');
  assert.equal(directory.query, null);
  assert.equal(directory.cursor, null);
  assert.equal(directory.nextCursor, null, 'Connected summary is incomplete');
  assert(Number.isSafeInteger(directory.totalCount), 'Invalid connected count');
  assert.equal(directory.totalCount, directory.returnedCount);
  assert.equal(directory.returnedCount, directory.entries?.length);
  assert(Array.isArray(directory.diagnostics));
  assert(!directory.diagnostics.some(message =>
    /timed?\s*out|timeout|partial|incomplete|probe failed|unavailable/i.test(message)
  ), 'Partial connected directory');
  const identities = directory.entries.map(entry => {
    assert.equal(entry.state, 'connected', 'Unconnected entry in filtered summary');
    return entry.providerId.toLowerCase().trim();
  });
  assert.equal(new Set(identities).size, identities.length, 'Duplicate provider identity');
  assert.deepEqual(identities, [PROVIDER], 'Synthetic test connection not reflected through IPC');
  return identities.length;
}

/** The exact OpenCode count element has one numeric count in every locale. */
export function hasOneVisibleOpenCodeConnection(text) {
  if (typeof text !== 'string' || !text.trim().startsWith('OpenCode')) return false;
  const numericTokens = text.match(/[0-9]+/g);
  return numericTokens?.length === 1 && numericTokens[0] === '1';
}

/**
 * Qualify the initial Dashboard before visiting Settings. The old E2E only
 * proved a count after Settings had already populated the directory cache.
 */
export async function verifyColdDashboardConnectedCount({ root, evaluate, send }) {
  const started = performance.now();
  let outcome = 'count_unavailable';
  let result = null;
  try {
    for (let attempt = 0; attempt < 180; attempt++) {
      const view = await evaluate(`(() => ({
        dashboard: Boolean(document.querySelector('[data-testid="dashboard-manage-providers"]')?.getClientRects().length),
        settings: Boolean(document.querySelector('[data-testid="provider-settings-page"]')?.getClientRects().length),
        count: document.querySelector('[data-testid="dashboard-opencode-provider-count"]')?.textContent || '',
      }))()`);
      if (view.settings) {
        outcome = 'settings_opened_before_dashboard_proof';
        break;
      }
      if (view.dashboard && hasOneVisibleOpenCodeConnection(view.count)) {
        outcome = 'passed';
        result = { connected: 1, elapsedMs: Math.round(performance.now() - started) };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await writeFile(path.join(root, 'cold-dashboard.json'), JSON.stringify({
      schemaVersion: 1,
      platform: process.platform,
      result: outcome,
      connected: result?.connected ?? null,
      elapsedMs: Math.round(performance.now() - started),
      settingsVisited: false,
      liveAccounts: false,
      modelInferenceTested: false,
    }, null, 2));
    assert.equal(outcome, 'passed', 'Cold Dashboard did not show verified OpenCode connection count');
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(root, 'cold-dashboard.png'), Buffer.from(screenshot.data, 'base64'));
    return result;
  } catch (error) {
    throw error;
  }
}

/**
 * Read-only desktop regression: each Settings → Providers Manage action opens
 * its own provider panel and closes without changing credentials.
 */
export async function verifyProviderManageDialogs(evaluate, send, reportStage = () => {}) {
  // Load only for real Electron verification: packaged candidate tests stub catalog.mjs.
  const { clickControl } = await import('./catalog.mjs');
  const verified = [];
  for (const provider of ['anthropic', 'codex', 'opencode']) {
    reportStage(provider + ':control');
    const control = "document.querySelector('[data-testid=\"runtime-manage-" + provider + "\"]')";
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      ready = await evaluate("(() => { const button = " + control +
        "; if (!button || button.disabled || !button.getClientRects().length) return false;" +
        " button.scrollIntoView({block:'center',inline:'nearest'});" +
        " const r=button.getBoundingClientRect();" +
        " const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);" +
        " return hit===button || button.contains(hit); })()");
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(ready, 'Settings Manage control missing or disabled: ' + provider);
    reportStage(provider + ':click');
    await clickControl(evaluate, send, control);
    reportStage(provider + ':panel');
    let selected = '';
    for (let attempt = 0; attempt < 80; attempt++) {
      selected = await evaluate("(() => {" +
        " const dialog = document.querySelector('[role=\"dialog\"][data-state=\"open\"]');" +
        " return dialog?.querySelector('[role=\"tab\"][data-state=\"active\"]')?.id || '';" +
        "})()");
      if (selected.endsWith('-trigger-' + provider)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(selected.endsWith('-trigger-' + provider),
      'Manage ' + provider + ' opened a different provider tab: ' + selected);
    reportStage(provider + ':content');
    const contentSelector = provider === 'anthropic'
      ? '[data-testid="connection-method-compatible"]'
      : provider === 'codex'
        ? '[data-testid="codex-custom-provider-panel"]'
        : '[data-testid="runtime-provider-tab-providers"]';
    let contentVisible = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      contentVisible = await evaluate("(() => {" +
        " const dialog = document.querySelector('[role=\"dialog\"][data-state=\"open\"]');" +
        " const marker = dialog?.querySelector(" + JSON.stringify(contentSelector) + ");" +
        " return Boolean(marker && marker.getClientRects().length); })()");
      if (contentVisible) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(contentVisible, 'Manage ' + provider + ' settings panel content missing');
    reportStage(provider + ':close');
    await clickControl(evaluate, send,
      "document.querySelector('[role=\"dialog\"][data-state=\"open\"] button.absolute.right-3.top-3')");
    let closed = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      closed = await evaluate(
        "document.querySelector('[role=\"dialog\"]') === null"
      );
      if (closed) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(closed, 'Manage ' + provider + ' dialog did not close');
    reportStage(provider + ':done');
    verified.push(provider);
  }
  return verified;
}

export async function verifyRealRuntimeElectron({ root, data, evaluate, send, coldDashboard }) {
  assert(data.realRuntime === true, 'Real runtime E2E must not use the fixture shim');
  let header = '';
  const headerStarted = performance.now();
  for (let attempt = 0; attempt < 120; attempt++) {
    header = await evaluate(
      "document.querySelector('[data-testid=\"dashboard-opencode-provider-count\"]')?.textContent || ''"
    );
    if (hasOneVisibleOpenCodeConnection(header)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert(hasOneVisibleOpenCodeConnection(header),
    'Real runtime connected count was not shown in the Settings header');
  const headerReadyMs = Math.round(performance.now() - headerStarted);

  // This invokes Electron preload → IPC → main CLI client → genuine published
  // runtime. It cannot be fulfilled by a seeded React fixture.
  const ipcStarted = performance.now();
  const observed = await evaluate('(async () => {' +
    'const bridge = window.electronAPI?.runtimeProviderManagement;' +
    'if (!bridge?.loadProviderDirectory) return { missingBridge: true };' +
    'const result = await bridge.loadProviderDirectory({' +
      'runtimeId: "opencode", summary: true, projectPath: null, query: null,' +
      'filter: "connected", limit: 100, cursor: null, refresh: false });' +
    'return { error: result?.error?.code || null, directory: result?.directory || null };' +
  '})()');
  const ipcElapsedMs = Math.round(performance.now() - ipcStarted);
  assert(!observed?.missingBridge, 'Runtime provider preload bridge unavailable');
  assert.equal(observed.error, null, 'Genuine runtime IPC directory request failed');
  const count = verifyRealProviderCountResponse(observed.directory);
  // Keep sanitized failure evidence even if an individual Manage control fails.
  const receiptPath = path.join(root, 'real-connection.json');
  const receipt = {
    schemaVersion: 1,
    platform: process.platform,
    runtimePin: data.runtimePin,
    testOnlyCredential: true,
    liveAccounts: false,
    realElectronIpc: true,
    connected: count,
    headerConnected: 1,
    coldDashboardConnected: coldDashboard?.connected ?? null,
    coldDashboardReadyMs: coldDashboard?.elapsedMs ?? null,
    headerReadyMs,
    ipcElapsedMs,
    fullCatalogReconciled: false,
    modelInferenceTested: false,
    manageStage: 'starting',
    manageResult: 'pending',
    manageDialogsVerified: [],
  };
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  assert(typeof screenshot.data === 'string');
  await writeFile(path.join(root, 'real-connection.png'),
    Buffer.from(screenshot.data, 'base64'));
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  let manageStage = 'starting';
  try {
    receipt.manageDialogsVerified = await verifyProviderManageDialogs(evaluate, send,
      (stage) => { manageStage = stage; });
    receipt.manageStage = 'completed';
    receipt.manageResult = 'passed';
  } catch (error) {
    receipt.manageStage = manageStage;
    receipt.manageResult = 'failed';
    const message = error instanceof Error ? error.message : '';
    receipt.manageFailureCategory =
      message.includes('Manage control missing') ? 'control_unavailable' :
      message.includes('different provider tab') ? 'wrong_provider_tab' :
      message.includes('settings panel content missing') ? 'provider_content_missing' :
      message.includes('dialog did not close') ? 'dialog_close_failed' :
      message.includes('Required desktop control unavailable') ? 'desktop_click_unavailable' :
      'other';
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
    throw error;
  }
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  console.log('Real pinned CLI → Electron IPC → provider header: PASS (synthetic connected=1)');
}
