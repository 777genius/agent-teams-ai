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
  const timeoutMs = 90_000;
  let outcome = 'count_unavailable';
  let connected = null;
  while (performance.now() - started < timeoutMs) {
    let view;
    try {
      view = await evaluate(`(() => ({
        dashboard: Boolean(document.querySelector('[data-testid="dashboard-manage-providers"]')?.getClientRects().length),
        settings: Boolean(document.querySelector('[data-testid="provider-settings-page"]')?.getClientRects().length),
        count: document.querySelector('[data-testid="dashboard-opencode-provider-count"]')?.textContent || '',
      }))()`);
    } catch {
      // The renderer can replace its execution context while navigating.
      // Retry only inside the original wall-clock budget, then write failure evidence.
    }
    if (view?.settings) {
      outcome = 'settings_opened_before_dashboard_proof';
      break;
    }
    if (view?.dashboard && hasOneVisibleOpenCodeConnection(view.count)) {
      outcome = 'passed';
      connected = 1;
      break;
    }
    const remaining = timeoutMs - (performance.now() - started);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(500, remaining)));
  }
  const elapsedMs = Math.round(performance.now() - started);
  await writeFile(path.join(root, 'cold-dashboard.json'), JSON.stringify({
    schemaVersion: 1,
    platform: process.platform,
    result: outcome,
    connected,
    elapsedMs,
    settingsVisited: false,
    liveAccounts: false,
    modelInferenceTested: false,
  }, null, 2));
  assert.equal(outcome, 'passed', 'Cold Dashboard did not show verified OpenCode connection count');
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(root, 'cold-dashboard.png'), Buffer.from(screenshot.data, 'base64'));
  return { connected, elapsedMs };
}

/** Display proof is a numeric value, never Unknown, a spinner or an inferred zero. */
export function hasExactVisibleOpenCodeCount(text, expected) {
  if (typeof text !== 'string' || !text.trim().startsWith('OpenCode') ||
      !Number.isSafeInteger(expected) || expected < 0) return false;
  const values = text.match(/[0-9]+/g);
  return values?.length === 1 && values[0] === String(expected);
}

/**
 * Read-only connected identities; neither models nor native launch readiness.
 * Reject partial, error-bearing, malformed, duplicate and unfiltered responses.
 */
export function verifyCompleteConnectedSourceSummary(response, expected) {
  assert.equal(response?.schemaVersion, 1, 'Invalid provider response schema');
  assert.equal(response.runtimeId, 'opencode');
  assert(!response.error, 'Provider count summary failed');
  const directory = response.directory;
  assert.equal(directory?.runtimeId, 'opencode');
  assert.equal(directory.filter, 'connected');
  assert.equal(directory.query, null);
  assert.equal(directory.cursor, null);
  assert.equal(directory.nextCursor, null, 'Truncated connected summary');
  assert(Number.isSafeInteger(directory.totalCount) && directory.totalCount >= 0);
  assert.equal(directory.totalCount, directory.returnedCount);
  assert.equal(directory.totalCount, directory.entries?.length);
  assert(Array.isArray(directory.diagnostics));
  assert(!directory.diagnostics.some((item) =>
    typeof item !== 'string' || /timed?\s*out|timeout|partial|incomplete|probe failed|unavailable/i.test(item)
  ), 'Incomplete or unavailable connected summary');
  const ids = directory.entries.map((entry) => {
    assert.equal(entry?.state, 'connected', 'Nonconnected source in filtered summary');
    assert(typeof entry.providerId === 'string' && entry.providerId.trim());
    const id = entry.providerId.trim().toLowerCase();
    assert.notEqual(id, 'opencode', 'Aggregate host is not a connection');
    return id;
  });
  assert.equal(new Set(ids).size, ids.length, 'Duplicate provider identity');
  assert.equal(ids.length, expected, 'V2 connected source count mismatch');
  return ids.length;
}

/**
 * Close only the verified provider dialog. An asynchronous provider panel may
 * ignore one click during a UI transition, so retry only after rechecking that
 * the same dialog's close button is enabled and hit-testable. A persistently
 * blocked or unclosed dialog still fails the E2E.
 */
export async function closeProviderManageDialog(evaluate, click, provider, options = {}) {
  const { pollMs = 250, maxPolls = 80, retryAfterPolls = 8, maxClicks = 3 } = options;
  const closeControl = "document.querySelector('[role=\"dialog\"][data-state=\"open\"] button.absolute.right-3.top-3')";
  let foundReadyClose = false;
  let clickCount = 0;
  let nextClickPoll = 0;
  for (let poll = 0; poll < maxPolls; poll++) {
    const state = await evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"][data-state="open"]');
      if (!dialog) return 'closed';
      const selected = dialog.querySelector('[role="tab"][data-state="active"]')?.id || '';
      if (!selected.endsWith(${JSON.stringify('-trigger-' + provider)})) return 'wrong-provider';
      const button = ${closeControl};
      if (!button?.isConnected || button.disabled || !button.getClientRects().length) return 'blocked';
      button.scrollIntoView({block:'nearest'});
      const r = button.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === button || button.contains(hit) ? 'ready' : 'blocked';
    })()`);
    if (state === 'closed') return;
    assert.notEqual(state, 'wrong-provider', 'Manage ' + provider + ' changed dialog during close');
    if (state === 'ready') {
      foundReadyClose = true;
      if (poll >= nextClickPoll && clickCount < maxClicks) {
        await click(closeControl);
        clickCount++;
        nextClickPoll = poll + retryAfterPolls;
      }
    }
    if (pollMs > 0) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  assert(foundReadyClose, 'Manage ' + provider + ' dialog close control obstructed');
  assert.fail('Manage ' + provider + ' dialog did not close');
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
    await closeProviderManageDialog(
      evaluate, (control) => clickControl(evaluate, send, control), provider
    );
    reportStage(provider + ':done');
    verified.push(provider);
  }
  return verified;
}

export async function verifyRealRuntimeElectron({ root, data, evaluate, send, coldDashboard }) {
  assert(data.realRuntime === true, 'Real runtime E2E must not use the fixture shim');
  // Settings has no collapsing shell; the Dashboard keeps its independent preference.
  let inlineLayout = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    inlineLayout = await evaluate(`(() => {
      const page = document.querySelector('[data-testid="provider-settings-page"]');
      const banner = page?.querySelector('[data-testid="provider-status-banner"]');
      const header = banner?.querySelector('[data-testid="provider-status-banner-header"]');
      const quickConnect = page?.querySelector('section[aria-labelledby="provider-quick-connect-title"]');
      if (!banner || !header || !quickConnect || !header.getClientRects().length ||
          !quickConnect.getClientRects().length) return null;
      return {
        inline: !banner.classList.contains('rounded-lg'),
        background: getComputedStyle(banner).backgroundColor,
        headerBorderBottom: getComputedStyle(header).borderBottomWidth,
        quickConnectBorderTop: getComputedStyle(quickConnect).borderTopWidth,
        headerInteractive: header.matches('[role="button"], [aria-expanded]'),
        collapseButtons: banner.querySelectorAll(
          '[aria-label="Collapse provider details"], [aria-label="Expand provider details"]'
        ).length,
        visibleProviderRows: [...banner.querySelectorAll('div.grid.border-b')].filter(
          row => row.getClientRects().length && row.textContent.includes('Anthropic')
        ).length,
      };
    })()`);
    if (inlineLayout?.visibleProviderRows) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(inlineLayout?.inline, 'Settings provider banner retained the Dashboard card shell');
  assert.match(inlineLayout.background, /^(?:rgba\(0, 0, 0, 0\)|transparent)$/,
    'Settings provider background differs from its parent surface');
  assert.equal(inlineLayout.headerBorderBottom, '0px',
    'Settings provider header duplicated the Quick Connect divider');
  assert.equal(inlineLayout.quickConnectBorderTop, '1px',
    'Settings Quick Connect section divider missing');
  assert.equal(inlineLayout.headerInteractive, false, 'Settings header must not be collapsible');
  assert.equal(inlineLayout.collapseButtons, 0, 'Settings retained collapse affordances');
  assert(inlineLayout.visibleProviderRows > 0, 'Settings provider details are not visible');

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
    inlineSettingsLayout: { passed: true, visibleProviderRows: inlineLayout.visibleProviderRows },
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
      message.includes('dialog close control obstructed') ? 'dialog_close_control_obstructed' :
      message.includes('dialog did not close') ? 'dialog_close_failed' :
      message.includes('Required desktop control unavailable') ? 'desktop_click_unavailable' :
      'other';
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
    throw error;
  }
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  console.log('Real pinned CLI → Electron IPC → provider header: PASS (synthetic connected=1)');
}
