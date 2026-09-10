import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { clickControl, correlateReport } from './catalog.mjs';
import { runtimeProvenance, packagedEnvironment, probeOrchestratorVersion } from './packaged.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const refreshControl = `[...document.querySelectorAll('button')].find(b =>
  /re-?check.*opencode|opencode.*re-?check/i.test(b.getAttribute('title') || ''))`;
// Read the real rendered provider props. No store/API/React replacement. Retained DOM
// model badges alone cannot prove refresh completion, especially during warm runs.
export function readCommittedCatalog(document) {
  const roots = new Set();
  for (const element of document.querySelectorAll('*')) {
    const key = Object.keys(element).find((k) => k.startsWith('__reactFiber$'));
    let top = key && element[key];
    const ancestry = new Set();
    while (top?.return && !ancestry.has(top)) {
      ancestry.add(top);
      top = top.return;
    }
    if (top?.stateNode?.current) roots.add(top.stateNode);
  }
  for (const root of roots) {
    // Bailout children may retain old return pointers. Only child/sibling links
    // rooted at FiberRoot.current establish membership in the committed tree.
    const pending = [root.current],
      seen = new Set();
    while (pending.length) {
      const fiber = pending.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      const props = fiber.memoizedProps;
      const status = props?.cliStatus?.providers?.find((p) => p.providerId === 'opencode');
      if (status?.modelCatalogRefreshState)
        return {
          state: status.modelCatalogRefreshState,
          models: status.models,
          diagnostics: status.modelCatalog?.diagnostics,
        };
      pending.push(fiber.sibling, fiber.child);
    }
  }
  return null;
}
const catalogState = `(${readCommittedCatalog.toString()})(document)`;

// Test-only observation at the public preload bridge boundary, before contextBridge
// freezes it. The original call, promise, response and rejection are untouched.
// No credentials or other API methods are observed; only the armed refresh is kept.
export function observeCatalogBridge(api, host) {
  const observation = (host.__packagedCatalogObservation = {
    active: false,
    records: [],
    overflow: false,
  });
  for (const method of ['loadProviderDirectory', 'loadModels']) {
    const original = api.runtimeProviderManagement[method];
    api.runtimeProviderManagement[method] = function (...args) {
      const promise = Reflect.apply(original, this, args);
      try {
        if (observation.active) {
          if (observation.records.length >= 500) observation.overflow = true;
          else {
            const record = {
              method,
              input: JSON.parse(JSON.stringify(args[0])),
              startedAt: Date.now(),
            };
            observation.records.push(record);
            // Observe settlement on a side branch, returning the identical promise.
            promise
              .then(
                (response) => {
                  record.response = JSON.parse(JSON.stringify(response));
                  record.completedAt = Date.now();
                },
                (error) => {
                  record.error = String(error);
                  record.completedAt = Date.now();
                }
              )
              .catch(() => {
                observation.overflow = true;
              });
          }
        }
      } catch {
        observation.overflow = true;
      }
      return promise;
    };
  }
}

export function bridgeObservationLocation(source) {
  const matches = [
    ...source.matchAll(/[\w$.]+\.exposeInMainWorld\(\s*['"]electronAPI['"]\s*,\s*([\w$]+)\s*\)/g),
  ];
  assert.equal(matches.length, 1, 'Expected one public electronAPI preload exposure');
  const match = matches[0];
  const prefix = source.slice(0, match.index);
  return {
    lineNumber: prefix.split('\n').length - 1,
    columnNumber: prefix.length - prefix.lastIndexOf('\n') - 1,
    condition: `((${observeCatalogBridge.toString()})(${match[1]},globalThis),false)`,
  };
}

// Install only in the selected packaged preload; reload is required to observe the
// bridge before it is frozen. No source file or packaged artifact is rewritten.
export async function waitForPackagedPreload(preloadScripts, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (!preloadScripts.length && performance.now() < deadline) await pause(50);
  assert.equal(
    preloadScripts.length,
    1,
    `Expected one packaged preload script, found ${preloadScripts.length}`
  );
  return preloadScripts[0];
}

export function matchesPackagedPreload(source, expected) {
  if (!expected || typeof source !== 'string' || source.length > expected.length + 2048)
    return false;
  const offset = source.indexOf(expected);
  return offset >= 0 && source.indexOf(expected, offset + expected.length) === -1;
}

async function installCatalogObservation(send, preloadScripts, archivePath) {
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const packageRequire = createRequire(builderRequire.resolve('app-builder-lib'));
  const { extractFile } = packageRequire('@electron/asar');
  const expected = extractFile(
    archivePath,
    path.join('dist-electron', 'preload', 'index.js')
  ).toString('utf8');
  assert(expected.length > 0 && expected.length < 8 * 1024 * 1024, 'Invalid packaged preload size');
  await send('Debugger.enable');
  let breakpointId;
  try {
    await pause(500);
    const matches = [];
    assert(preloadScripts.length <= 30, 'Too many preload candidates');
    for (const candidate of [...preloadScripts]) {
      const { scriptSource } = await send('Debugger.getScriptSource', {
        scriptId: candidate.scriptId,
      });
      if (matchesPackagedPreload(scriptSource, expected))
        matches.push({ ...candidate, scriptSource });
    }
    assert.equal(matches.length, 1, 'Expected one script containing the exact packaged preload');
    const script = matches[0];
    const { scriptSource } = script;
    assert(
      typeof script.hash === 'string' && script.hash.length > 0,
      'Preload script hash unavailable'
    );
    const location = bridgeObservationLocation(scriptSource);
    ({ breakpointId } = await send('Debugger.setBreakpointByUrl', {
      scriptHash: script.hash,
      ...location,
    }));
    const oldCount = preloadScripts.length;
    await send('Page.reload');
    for (let i = 0; i < 120; i++) {
      const current = preloadScripts
        .slice(oldCount)
        .find((candidate) => candidate.hash === script.hash);
      if (current) {
        const result = await send('Runtime.evaluate', {
          contextId: current.executionContextId,
          expression: 'Boolean(globalThis.__packagedCatalogObservation)',
          returnByValue: true,
        });
        if (result.result?.value === true) {
          return async (expression) => {
            const value = await send('Runtime.evaluate', {
              contextId: current.executionContextId,
              expression,
              returnByValue: true,
            });
            assert(!value.exceptionDetails, 'Preload observation unavailable');
            return value.result?.value;
          };
        }
      }
      await pause(250);
    }
    throw new Error('Packaged preload completion observer did not install');
  } finally {
    if (breakpointId) await send('Debugger.removeBreakpoint', { breakpointId });
    await send('Debugger.disable');
  }
}

export function qualifyModels(response, source) {
  assert.equal(response?.schemaVersion, 1);
  assert.equal(response.runtimeId, 'opencode');
  assert(!response.error, `Model load failed for ${source}`);
  assert.equal(response.models?.runtimeId, 'opencode');
  assert.equal(response.models?.providerId, source);
  assert.equal(
    response.models?.catalogState,
    'fresh',
    'Cached/stale/unknown models do not qualify'
  );
  const models = response.models.models;
  assert(Array.isArray(models), `Invalid models for ${source}`);
  assert(
    models.every(
      (m) => m.providerId === source && typeof m.modelId === 'string' && m.modelId.trim()
    )
  );
  return models;
}

// Compatibility runtimes may paginate even limit:null. Every page remains evidence;
// fresh here describes individual API pages, not shared-generation launch authority.
export async function collectPages(load, kind, source, maxPages = 20) {
  const items = [],
    ids = new Set(),
    cursors = new Set();
  let cursor = null,
    total;
  for (let page = 0; page < maxPages; page++) {
    const response = await load(cursor, page);
    assert.equal(response?.schemaVersion, 1);
    assert.equal(response.runtimeId, 'opencode');
    assert(!response.error, `${kind} request failed`);
    const payload = response[kind];
    assert.equal(payload?.runtimeId, 'opencode');
    const batch = kind === 'models' ? qualifyModels(response, source) : payload.entries;
    assert(Array.isArray(batch));
    if (payload.cursor !== undefined)
      assert.equal(payload.cursor?.trim() || null, cursor, 'Mismatched cursor');
    if (payload.returnedCount !== undefined) assert.equal(payload.returnedCount, batch.length);
    if (payload.totalCount !== undefined) {
      assert(Number.isInteger(payload.totalCount) && payload.totalCount >= 0);
      if (total !== undefined) assert.equal(payload.totalCount, total, 'Changed total');
      total = payload.totalCount;
    }
    for (const item of batch) {
      const id =
        kind === 'models'
          ? item.modelId.startsWith(`${source}/`)
            ? item.modelId
            : `${source}/${item.modelId}`
          : item.providerId?.trim().toLowerCase();
      assert(id && !ids.has(id), 'Duplicate or missing inventory identifier');
      ids.add(id);
      items.push(item);
    }
    assert(payload.nextCursor == null || typeof payload.nextCursor === 'string');
    const next = payload.nextCursor?.trim() || null;
    if (!next) {
      if (total !== undefined) assert.equal(items.length, total, 'Incomplete inventory');
      return items;
    }
    assert(!cursors.has(next), 'Repeated cursor');
    cursors.add(next);
    cursor = next;
  }
  throw new Error('Pagination exceeded bounded page limit');
}

export async function waitForAppVersion(read, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (
        !String(error).includes("No handler registered for 'get-app-version'") ||
        Date.now() >= deadline
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export function qualifySummary(provider) {
  assert(provider?.providerId === 'opencode' && provider.supported, 'OpenCode was not detected');
  const passive =
    provider.statusCheckOutcome === 'model_only' &&
    provider.statusCheckErrorCode === 'partial_response' &&
    provider.statusMessage === 'OpenCode detected (passive)' &&
    provider.verificationState === 'unknown' &&
    provider.authenticated === false &&
    provider.capabilities?.teamLaunch === false &&
    provider.capabilities?.oneShot === false;
  assert(
    passive ||
      (!provider.statusCheckErrorCode &&
        !['error', 'offline'].includes(provider.verificationState) &&
        !['transient_error', 'pending'].includes(provider.statusCheckOutcome)),
    'OpenCode summary failed'
  );
  return {
    kind: passive ? 'passive-detection' : 'status-response',
    authenticationProven: false,
    launchReadinessProven: false,
  };
}

export function refreshSettled(observation, current) {
  return (
    !observation.overflow &&
    current?.state === 'ready' &&
    observation.records.length > 0 &&
    observation.records.every((record) => Number.isFinite(record.completedAt))
  );
}

export async function qualifyUIRefresh(records, completed) {
  assert.equal(completed?.state, 'ready');
  assert(!completed.diagnostics?.message);
  assert(records.length, 'Missing measured UI completions');
  for (const record of records) {
    assert(['loadProviderDirectory', 'loadModels'].includes(record.method));
    assert(
      record.completedAt >= record.startedAt && record.response && !record.error,
      'Missing/failed UI completion'
    );
    assert(
      record.input?.runtimeId === 'opencode' &&
        record.input.projectPath === null &&
        record.input.refresh === true &&
        record.input.query == null,
      'Non-disposable or cached UI request'
    );
  }
  const pages = async (selected, kind, source) => {
    let count = 0;
    const items = await collectPages(
      async (cursor) => {
        const record = selected[count++];
        assert(record, 'Missing UI page');
        assert.equal(record.input.cursor ?? null, cursor, 'UI request cursor mismatch');
        return record.response;
      },
      kind,
      source
    );
    assert.equal(count, selected.length, 'Extra UI pages/overlapping refreshes');
    return items;
  };
  const directory = records.filter((r) => r.method === 'loadProviderDirectory');
  assert(directory.every((r) => r.input.summary === true && r.input.filter === 'all'));
  for (const record of directory) {
    const payload = record.response.directory;
    assert(
      Number.isInteger(payload?.totalCount) && Number.isInteger(payload?.returnedCount),
      'Missing UI directory completeness metadata'
    );
  }
  const entries = await pages(directory, 'directory');
  const sources = [
    ...new Set(
      entries
        .filter(
          (e) =>
            e.providerId.trim().toLowerCase() === 'opencode' ||
            (e.state !== 'ignored' && (e.state === 'connected' || e.metadata?.configuredAuthless))
        )
        .map((e) => e.providerId.trim().toLowerCase())
    ),
  ].sort();
  if (entries.length) assert(sources.includes('opencode'), 'No actual OpenCode source');
  const modelRecords = records.filter((r) => r.method === 'loadModels');
  assert.deepEqual(
    [...new Set(modelRecords.map((r) => r.input.providerId))].sort(),
    sources,
    'UI source inventory differs from measured directory'
  );
  const modelIds = [];
  const groups = new Set();
  for (const source of sources) {
    const selected = modelRecords.filter((r) => r.input.providerId === source);
    const group = selected[0]?.input.requestGroupId;
    assert(
      typeof group === 'string' &&
        group.endsWith(`:${source}`) &&
        /^dashboard-connected-catalog:\d+:/.test(group),
      'Not a measured dashboard request'
    );
    groups.add(group.slice(0, -source.length - 1));
    assert(
      selected.every((r) => r.input.requestGroupId === group),
      'Mixed UI refresh groups'
    );
    const models = await pages(selected, 'models', source);
    for (const model of models) {
      assert(!/\s/.test(model.modelId), 'Invalid model identifier');
      assert(
        !model.modelId.includes('/') || model.modelId.startsWith(`${source}/`),
        'Foreign model source'
      );
      modelIds.push(model.modelId.includes('/') ? model.modelId : `${source}/${model.modelId}`);
    }
  }
  assert(groups.size <= 1, 'Mixed dashboard refresh attempts');
  modelIds.sort();
  assert.deepEqual(
    [...completed.models].sort(),
    modelIds,
    'Rendered UI differs from measured completions'
  );
  return { sources, modelIds };
}

export async function verifyPackaged({
  root,
  data,
  evaluate,
  send,
  preloadScripts,
  scriptMetadata,
}) {
  assert(['cold', 'warm-1', 'warm-2'].includes(data.run), 'Use the explicit packaged runner');
  const evidence = {
    passed: false,
    mode: 'packaged',
    run: data.run,
    artifact: data.artifact,
    startedAt: new Date().toISOString(),
    outcomes: {},
  };
  const save = (name, value) => writeFile(path.join(root, data.run, name), value);
  const shot = async (name) =>
    save(`${name}.png`, Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
  // Existing IPC may take 90s. Poll a promise instead of exceeding the CDP 15s request limit.
  const probe = async (name, expression, timeout = 120000) => {
    const outcome = (evidence.outcomes[name] = { startedAt: new Date().toISOString() });
    await evaluate(`window.__packagedProbe = {done:false}; Promise.resolve().then(() => (${expression}))
      .then(value => window.__packagedProbe={done:true,value}, error => window.__packagedProbe={done:true,error:String(error)}); void 0`);
    const deadline = Date.now() + timeout;
    do {
      const result = await evaluate('window.__packagedProbe');
      if (result.done) {
        Object.assign(outcome, result, { completedAt: new Date().toISOString() });
        assert(!result.error, `${name}: ${result.error}`);
        return result.value;
      }
      await pause(250);
    } while (Date.now() < deadline);
    outcome.error = 'Bounded IPC observation timeout';
    throw new Error(`${name}: ${outcome.error}`);
  };
  let observe;
  try {
    try {
      observe = await installCatalogObservation(send, preloadScripts, data.artifact.archive.path);
    } finally {
      evidence.scriptMetadata = scriptMetadata;
      evidence.preloadDiscovery = preloadScripts.map(({ scriptId, executionContextId }) => ({
        scriptId,
        executionContextId,
      }));
    }
    evidence.appVersion = await probe(
      'appReady',
      `(${waitForAppVersion.toString()})(() => window.electronAPI.getAppVersion())`,
      125000
    );
    await probe('invalidateDiscovery', 'window.electronAPI.cliInstaller.invalidateStatus()');
    const discovery = await probe(
      'discovery',
      'window.electronAPI.cliInstaller.getStatus({providerStatusMode:"defer"})'
    );
    evidence.orchestrator = await runtimeProvenance(discovery, data, 'orchestrator');
    assert(discovery.installed && !discovery.launchError, 'Orchestrator resolution failed');
    evidence.outcomes.orchestratorVersion = await probeOrchestratorVersion(
      evidence.orchestrator.path,
      {
        env: packagedEnvironment(data),
        cwd: data.home,
      }
    );
    assert(
      evidence.outcomes.orchestratorVersion.passed,
      'Selected bundled orchestrator --version failed'
    );
    await probe('invalidateVersion', 'window.electronAPI.openCodeRuntime.invalidateStatus()');
    let version = await probe('opencodeVersion', 'window.electronAPI.openCodeRuntime.getStatus()');
    // Explicit future runner option only. This is the app's registry/integrity installer;
    // the harness never supplies a URL, runtime binary, manifest or credentials.
    if (
      !version.installed &&
      version.source === 'missing' &&
      data.runtimeSetup === 'app-install' &&
      data.run === 'cold'
    ) {
      await probe('runtimeSetup', 'window.electronAPI.openCodeRuntime.install()', 180000);
      await probe(
        'invalidateInstalledVersion',
        'window.electronAPI.openCodeRuntime.invalidateStatus()'
      );
      version = await probe(
        'opencodeInstalledVersion',
        'window.electronAPI.openCodeRuntime.getStatus()'
      );
    }
    if (version.binaryPath) evidence.opencode = await runtimeProvenance(version, data, 'opencode');
    assert(
      version.installed && version.version && version.state === 'ready' && !version.error,
      'OpenCode version failed/missing; cold setup requires explicit --runtime-setup app-install'
    );
    assert(evidence.opencode, 'Managed OpenCode binary path missing from runtime status');
    evidence.managedRuntime = JSON.parse(
      await readFile(path.join(data.userData, 'data/runtimes/opencode/current.json'), 'utf8')
    );
    assert.equal(
      evidence.managedRuntime.binaryPath.toLowerCase(),
      evidence.opencode.path.toLowerCase()
    );
    assert.equal(evidence.managedRuntime.version, version.version);
    assert(
      evidence.managedRuntime.integrity &&
        evidence.managedRuntime.platformPackage !== 'diagnostics-fixture'
    );
    await probe('invalidateSummary', 'window.electronAPI.cliInstaller.invalidateStatus()');
    const statusSnapshot = await probe(
      'statusSnapshot',
      'window.electronAPI.cliInstaller.getStatus({providerStatusMode:"defer"})'
    );
    await runtimeProvenance(statusSnapshot, data, 'orchestrator');
    // Discovery intentionally returns deferred provider placeholders. Await the same
    // scoped summary API used by renderer status checks, not the aggregate snapshot.
    const provider = await probe(
      'summary',
      'window.electronAPI.cliInstaller.getProviderStatus("opencode")'
    );
    evidence.summaryQualification = qualifySummary(provider);

    // Wait for bootstrap catalog to settle before starting the measured UI refresh.
    let before;
    for (let i = 0; i < 240; i++) {
      before = await evaluate(catalogState);
      if (before && before.state !== 'loading') break;
      await pause(500);
    }
    assert(
      before && before.state !== 'loading',
      'Real dashboard catalog props unavailable/unsettled'
    );
    evidence.ui = { before, startedAt: new Date().toISOString(), transitions: [] };
    await observe('globalThis.__packagedCatalogObservation.active = true');
    try {
      await clickControl(evaluate, send, refreshControl);
      let loading = false;
      let completed;
      for (let i = 0; i < 960; i++) {
        const current = await evaluate(catalogState);
        if (current?.state !== evidence.ui.transitions.at(-1)?.state)
          evidence.ui.transitions.push({ ...current, at: Date.now() });
        if (current?.state === 'loading') loading = true;
        const snapshot = await observe('globalThis.__packagedCatalogObservation');
        assert(!snapshot.overflow, 'UI completion observation overflow/failure');
        if (refreshSettled(snapshot, current)) {
          completed = current;
          break;
        }
        await pause(250);
      }
      evidence.ui.observedLoading = loading;
      evidence.ui.completed = completed;
      const observation = await observe('globalThis.__packagedCatalogObservation');
      evidence.ui.requests = observation.records;
      assert(!observation.overflow, 'UI completion observation overflow/failure');
      assert(completed?.state === 'ready', 'UI did not complete a successful catalog refresh');
      assert(!completed.diagnostics?.message, 'UI catalog diagnostics fail qualification');
      evidence.ui.inventory = await qualifyUIRefresh(observation.records, completed);
      evidence.qualification = evidence.ui.inventory.modelIds.length
        ? 'provider-inventory'
        : 'transport-only';
      evidence.providerQualified = evidence.qualification === 'provider-inventory';
    } finally {
      await observe('globalThis.__packagedCatalogObservation.active = false');
    }

    // Separate fresh main API attempts corroborate source/model payloads. Never injected
    // into UI state or claimed to carry the UI attempt's report IDs.
    const entries = await collectPages((cursor, page) => {
      const input = {
        runtimeId: 'opencode',
        projectPath: null,
        summary: true,
        filter: 'all',
        limit: 100,
        refresh: true,
        cursor,
      };
      return probe(
        `directory:${page}`,
        `window.electronAPI.runtimeProviderManagement.loadProviderDirectory(${JSON.stringify(input)})`
      );
    }, 'directory');
    const sources = entries
      .filter(
        (e) =>
          e.providerId.trim().toLowerCase() === 'opencode' ||
          (e.state !== 'ignored' && (e.state === 'connected' || e.metadata?.configuredAuthless))
      )
      .map((e) => e.providerId.trim().toLowerCase());
    if (entries.length) assert(sources.includes('opencode'), 'No actual OpenCode source');
    const uiSources = new Set(
      evidence.ui.requests.filter((r) => r.method === 'loadModels').map((r) => r.input.providerId)
    );
    assert.deepEqual(
      [...uiSources].sort(),
      [...new Set(sources)].sort(),
      'UI source inventory differs from fresh directory'
    );
    evidence.sources = [];
    const freshModelIds = [];
    for (const source of new Set(sources)) {
      const input = {
        runtimeId: 'opencode',
        providerId: source,
        projectPath: null,
        refresh: true,
        limit: null,
      };
      const models = await collectPages(
        (cursor, page) =>
          probe(
            `models:${source}:${page}`,
            `window.electronAPI.runtimeProviderManagement.loadModels(${JSON.stringify({ ...input, cursor })})`
          ),
        'models',
        source
      );
      evidence.sources.push({ source, modelCount: models.length });
      for (const model of models) {
        assert(!/\s/.test(model.modelId), 'Invalid model identifier');
        assert(
          !model.modelId.includes('/') || model.modelId.startsWith(`${source}/`),
          'Foreign model source'
        );
        freshModelIds.push(
          model.modelId.includes('/') ? model.modelId : `${source}/${model.modelId}`
        );
      }
    }
    assert.deepEqual(
      evidence.ui.inventory.modelIds,
      [...new Set(freshModelIds)].sort(),
      'Completed UI model inventory differs from the fresh main API snapshot'
    );
    assert.equal(
      await evaluate(
        `document.querySelector('[data-testid="opencode-catalog-error"], [data-testid="opencode-version-diagnostics"]')?.innerText || ''`
      ),
      ''
    );
    await shot('dashboard');
    evidence.passed = true;
  } catch (error) {
    evidence.error = String(error);
    try {
      await shot('failure');
    } catch (capture) {
      evidence.screenshotError = String(capture);
    }
    try {
      const alert = `document.querySelector('[data-testid="opencode-catalog-error"], [data-testid="opencode-version-diagnostics"]')`;
      evidence.failureUI = await evaluate('document.body.innerText');
      if (await evaluate(`Boolean(${alert})`)) {
        const previousClipboard = await evaluate('navigator.clipboard.readText()');
        await clickControl(evaluate, send, `${alert}.querySelector('button')`);
        let copied = '';
        for (let i = 0; i < 30; i++) {
          if ((await evaluate(`${alert}.querySelector('button').innerText`)).includes('Copied')) {
            copied = await evaluate('navigator.clipboard.readText()');
            break;
          }
          await pause(100);
        }
        await save('clipboard.txt', copied);
        assert.notEqual(copied, previousClipboard, 'Clipboard retained a previous report');
        const logs = await readFile(path.join(data.userData, 'logs/app-errors.ndjson'), 'utf8');
        evidence.reportIds = correlateReport(copied, logs);
        await save(
          'correlated-log.ndjson',
          logs
            .split('\n')
            .filter((line) => evidence.reportIds.some((id) => line.includes(id)))
            .join('\n')
        );
      } else evidence.clipboardUnavailable = 'No diagnostic alert/copy control';
    } catch (capture) {
      evidence.clipboardError = String(capture);
    }
    throw error;
  } finally {
    if (observe) {
      try {
        await observe('globalThis.__packagedCatalogObservation.active = false');
      } catch (error) {
        evidence.observerCleanupError = String(error);
      }
    }
    evidence.completedAt = new Date().toISOString();
    await save('evidence.json', JSON.stringify(evidence, null, 2));
  }
}
