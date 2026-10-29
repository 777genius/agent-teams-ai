import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clickControl, readPendingArtifact, verifyCatalog } from './catalog.mjs';
import { waitForPackagedRefreshPreparation } from './packaged.mjs';
import {
  assertSettledDirectoryPage,
  qualifyCatalogReadExpectation,
  qualifySettings,
  qualifyUIRefresh,
  settingsRefreshFailure,
  settingsRefreshSettled,
  waitForSettledDirectory,
} from './packaged-verify.mjs';

test('catalog fixture subprocess returns four sources, failures, partial models and recovery; refuses mutations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-diagnostics-e2e-catalog-test-'));
  try {
    const fixture = path.join(root, 'fixture.cjs');
    await copyFile(new URL('./fixture.cjs', import.meta.url), fixture);
    const run = (args) =>
      spawnSync(process.execPath, [fixture, 'orchestrator', ...args], {
        encoding: 'utf8',
        timeout: 5000,
      });
    for (const scenario of [
      'directory-error',
      'models-four-errors',
      'partial-success',
      'catalog-retry',
    ]) {
      await writeFile(path.join(root, 'scenario'), scenario);
      const directory = run([
        'runtime',
        'providers',
        'directory',
        '--runtime',
        'opencode',
        '--json',
        '--summary',
        '--filter',
        'all',
        '--limit',
        '100',
        '--refresh',
      ]);
      assert.equal(directory.status, 0, directory.stderr);
      const result = JSON.parse(directory.stdout);
      assert.equal(Boolean(result.error), scenario === 'directory-error');
      if (result.directory) assert.equal(result.directory.entries.length, 4);
      for (const source of ['opencode', 'anthropic', 'google', 'openrouter']) {
        const models = run([
          'runtime',
          'providers',
          'models',
          '--runtime',
          'opencode',
          '--provider',
          source,
          '--json',
        ]);
        assert.equal(models.status, 0, models.stderr);
        const value = JSON.parse(models.stdout);
        assert.equal(
          Boolean(value.error),
          scenario === 'models-four-errors' ||
            (scenario === 'partial-success' && source !== 'opencode')
        );
        if (value.models) assert.equal(value.models.models[0].providerId, source);
      }
    }
    for (const args of [
      ['runtime', 'status', '--json', '--summary', '--provider', 'opencode'],
      ['runtime', 'status', '--json', '--provider', 'opencode', '--summary'],
    ]) {
      const status = run(args);
      assert.equal(status.status, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).providers.opencode.authenticated, true);
    }
    for (const args of [
      [
        'runtime',
        'providers',
        'models',
        '--runtime',
        'opencode',
        '--provider',
        'opencode',
        '--json',
        '--execute',
      ],
      [
        'runtime',
        'providers',
        'directory',
        '--runtime',
        'opencode',
        '--json',
        '--project-path',
        '/real-project',
      ],
      ['team', 'launch'],
    ])
      assert.equal(run(args).status, 64);
    const events = (await readFile(path.join(root, 'calls.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    // Windows reuses PIDs across these sequential runs: a response belongs to the latest
    // start of its PID, never to an earlier process that had the same PID.
    const latestStart = new Map();
    for (const event of events) {
      if (event.event === 'start') latestStart.set(event.pid, event);
      if (event.event !== 'response') continue;
      const start = latestStart.get(event.pid);
      assert(start && start.at <= event.at && start.scenario === event.scenario);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('delayed summary exercises runtime status budget, not directory latency', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-diagnostics-e2e-summary-test-'));
  try {
    const fixture = path.join(root, 'fixture.cjs');
    await copyFile(new URL('./fixture.cjs', import.meta.url), fixture);
    await writeFile(path.join(root, 'scenario'), 'delayed8s');
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      [
        fixture,
        'orchestrator',
        'runtime',
        'status',
        '--json',
        '--summary',
        '--provider',
        'opencode',
      ],
      { encoding: 'utf8', timeout: 12000 }
    );
    assert.equal(result.status, 0, result.stderr);
    assert(Date.now() - started >= 7900);
    assert.equal(JSON.parse(result.stdout).providers.opencode.authenticated, true);
    const events = (await readFile(path.join(root, 'calls.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(events[1].operation, 'status');
    assert(events[1].at - events[0].at >= 7900);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pending artifacts tolerate absence, preserve content and surface other read errors', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-artifact-test-'));
  try {
    const file = path.join(root, 'calls.ndjson');
    assert.equal(await readPendingArtifact(file), '');
    await writeFile(file, '{"event":"start"}\n');
    assert.equal(await readPendingArtifact(file), '{"event":"start"}\n');
    await assert.rejects(readPendingArtifact(root), { code: 'EISDIR' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'catalog waits through duplicate and failed model responses for four distinct successful sources',
  { timeout: 10000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-readiness-TEST-'));
    const scenario = 'catalog-retry';
    let bodyReads = 0;
    const calls = [];
    const saveCalls = () =>
      writeFile(
        path.join(root, 'calls.ndjson'),
        calls.map((call) => JSON.stringify(call)).join('\n') + '\n'
      );
    const response = (source, failed = false) => ({
      event: 'response',
      operation: 'models',
      scenario,
      source,
      failed,
      at: Date.now(),
    });
    try {
      await verifyCatalog({
        root,
        scenario,
        evaluate: async (expression) => {
          if (expression.startsWith('(() => { const b =')) {
            calls.push(
              {
                event: 'start',
                scenario,
                at: Date.now(),
                args: ['runtime', 'providers', 'directory', '--summary'],
              },
              response('anthropic'),
              response('opencode'),
              response('anthropic'),
              response('google')
            );
            await saveCalls();
            return { x: 1, y: 1 };
          }
          if (expression === 'document.body.innerText') {
            bodyReads += 1;
            // First add a failed fourth source; only its later successful response may finish the wait.
            if (bodyReads <= 2) {
              calls.push(response('openrouter', bodyReads === 1));
              await saveCalls();
            }
            return 'Fixture opencode model';
          }
          if (expression === 'navigator.clipboard.readText()') return '';
          if (expression === 'window.__catalogProbe')
            return { done: true, value: { schemaVersion: 1 } };
          if (expression.startsWith('window.__catalogProbe =')) return undefined;
          if (expression.includes('opencode-catalog-error')) return '';
          throw new Error(`Unexpected catalog probe: ${expression}`);
        },
        send: async (method) => {
          assert(['Input.dispatchMouseEvent', 'Page.captureScreenshot'].includes(method));
          return method === 'Page.captureScreenshot' ? { data: '' } : {};
        },
      });
      assert.equal(bodyReads, 3, 'Duplicate or failed source responses ended polling early');
      const captured = JSON.parse(
        await readFile(path.join(root, `${scenario}-subprocess.json`), 'utf8')
      );
      assert.deepEqual(
        [
          ...new Set(
            captured
              .filter((call) => call.operation === 'models' && !call.failed)
              .map((call) => call.source)
          ),
        ].sort(),
        ['anthropic', 'google', 'opencode', 'openrouter']
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

const v2Disclaimer =
  'capabilities_pending: V2 catalog reads do not qualify authentication, team launch or one-shot execution.';
const nativePath = 'C:\\TEST-packaged\\user-data\\runtimes\\opencode\\bin\\opencode.exe';
const knownModels = ['opencode/known-one', 'opencode/known-two'];

function v2ReadEvidence() {
  const status = {
    providerId: 'opencode', supported: true, statusCheckOutcome: 'model_only',
    verificationState: 'unknown', authenticated: false,
    capabilities: { teamLaunch: false, oneShot: false },
    statusMessage: 'OpenCode V2 catalog available; capabilities_pending',
    models: [...knownModels],
    externalRuntimeDiagnostics: [{ id: 'cli-bin', detected: true, detailMessage: nativePath }],
    modelCatalog: {
      schemaVersion: 1, providerId: 'opencode', source: 'app-server', status: 'stale',
      models: knownModels.map((id) => ({ id })),
      diagnostics: { configReadState: 'ready', appServerState: 'healthy',
        code: 'capabilities_pending', message: 'capabilities_pending' },
    },
  };
  return [
    { installed: true, state: 'ready', source: 'app-managed', version: '2.1.4', binaryPath: nativePath },
    { source: 'app-managed', version: '2.1.4', path: nativePath, sha256: 'a'.repeat(64) },
    { schemaVersion: 1, version: '2.1.4', binaryPath: nativePath,
      platformPackage: '@opencode/cli-windows-x64', integrity: 'sha512-VEVTVA==' },
    [structuredClone(status), structuredClone(status)],
  ];
}

function v2Directory(summary = true) {
  return {
    schemaVersion: 1, runtimeId: 'opencode',
    directory: {
      runtimeId: 'opencode', diagnostics: [summary ? 'capabilities_pending' : v2Disclaimer],
      entries: [{ providerId: 'opencode', state: 'available',
        modelCount: summary ? null : 2, sources: ['seed', 'inventory'],
        metadata: { hasKnownModels: !summary } }],
      cursor: null, nextCursor: null, totalCount: 1, returnedCount: 1,
    },
  };
}

function catalogRecord(method, response, input = {}) {
  return {
    method, response, startedAt: 1, completedAt: 2,
    input: { runtimeId: 'opencode', projectPath: null, refresh: true, cursor: null,
      ...(method === 'loadProviderDirectory' ? { summary: true, filter: 'all' }
        : { providerId: 'opencode', requestGroupId: 'dashboard-connected-catalog:1:opencode' }),
      ...input },
  };
}

test('V2 catalog disclaimers require managed identity and both successful native read-only statuses', () => {
  const evidence = v2ReadEvidence();
  const expectation = qualifyCatalogReadExpectation(...evidence);
  assert.equal(expectation.kind, 'v2-catalog-only');
  assert.equal(expectation.nativeVersion, '2.1.4');
  assert.deepEqual(expectation.modelIds, knownModels);
  assert.equal(expectation.authenticationProven, false);
  assert.equal(expectation.launchReadinessProven, false);
  // A stale project-status projection is not a fresh-model qualification.
  assert.equal(evidence[3][0].modelCatalog.status, 'stale');
  for (const invalidate of [
    (e) => { e[0].source = 'path'; },
    (e) => { e[1].sha256 = 'not-a-digest'; },
    (e) => { e[2].binaryPath = 'C:\\foreign\\opencode.exe'; },
    (e) => { e[2].version = '2.1.3'; },
    (e) => { e[3].pop(); },
    (e) => { e[3][0].modelCatalog.diagnostics.appServerState = 'degraded'; },
    (e) => { e[3][1].modelCatalog.diagnostics.configReadState = 'failed'; },
    (e) => { e[3][1].statusCheckOutcome = 'transient_error'; },
    (e) => { e[3][1].capabilities.teamLaunch = true; },
    (e) => { e[3][1].externalRuntimeDiagnostics[0].detailMessage = 'C:\\foreign\\opencode.exe'; },
    (e) => { e[3][1].models = []; e[3][1].modelCatalog.models = []; },
    (e) => { e[3][1].modelCatalog.models.pop(); },
  ]) {
    const invalid = structuredClone(evidence);
    invalidate(invalid);
    assert.throws(() => qualifyCatalogReadExpectation(...invalid));
  }
  for (const version of ['1.19.4', '2.1.4-beta.1', '3.0.0']) {
    const unqualified = structuredClone(evidence);
    unqualified[0].version = version;
    assert.equal(qualifyCatalogReadExpectation(...unqualified), undefined);
  }
});

test('verified V2 summary settles immediately but V1, missing proof and additional diagnostics stay strict', async () => {
  const expectation = qualifyCatalogReadExpectation(...v2ReadEvidence());
  const summary = v2Directory();
  let calls = 0;
  assert.equal(await waitForSettledDirectory(async () => { calls++; return summary; }, 1000,
    expectation), summary);
  assert.equal(calls, 1);
  assert.throws(() => assertSettledDirectoryPage(summary.directory), /Pending\/degraded/);
  for (const diagnostics of [[], ['capabilities_pending', 'capabilities_pending'],
    ['capabilities_pending', 'OpenCode inventory probe timed out after 60000ms'], [v2Disclaimer]]) {
    const response = structuredClone(summary);
    response.directory.diagnostics = diagnostics;
    await assert.rejects(waitForSettledDirectory(async () => response, 1000, expectation),
      /readiness failed/);
  }
  await assert.rejects(waitForSettledDirectory(async () => ({ ...summary, error: { message: 'failed' } }),
    1000, expectation), /readiness failed/);
});

test('V2 measured UI still requires its own fresh complete model pages and exact rendered inventory', async () => {
  const expectation = qualifyCatalogReadExpectation(...v2ReadEvidence());
  const modelPage = (modelId, cursor, nextCursor) => ({
    schemaVersion: 1, runtimeId: 'opencode', models: {
      runtimeId: 'opencode', providerId: 'opencode', catalogState: 'fresh',
      cursor, nextCursor, totalCount: 2, returnedCount: 1,
      models: [{ providerId: 'opencode', modelId }],
    },
  });
  const records = [
    catalogRecord('loadProviderDirectory', v2Directory()),
    catalogRecord('loadModels', modelPage(knownModels[0], null, 'next')),
    catalogRecord('loadModels', modelPage(knownModels[1], 'next', null), { cursor: 'next' }),
  ];
  const completed = { state: 'ready', models: [...knownModels] };
  assert.deepEqual((await qualifyUIRefresh(records, completed, expectation)).modelIds, knownModels);
  await assert.rejects(qualifyUIRefresh(records, completed), /Pending\/degraded/);
  for (const invalidate of [
    (r) => { r[1].response.models.catalogState = 'stale'; },
    (r) => { delete r[1].response.models.catalogState; },
    (r) => { r.pop(); },
    (r) => { r[2].input.cursor = 'foreign'; },
    (r) => { r[1].input.providerId = 'foreign'; },
    (r) => { r[1].error = 'transport failed'; },
    (r) => { r[0].response.directory.diagnostics.push('native failure'); },
  ]) {
    const invalid = structuredClone(records);
    invalidate(invalid);
    await assert.rejects(qualifyUIRefresh(invalid, completed, expectation));
  }
  await assert.rejects(qualifyUIRefresh(records, { ...completed, models: [knownModels[0]] },
    expectation), /Rendered UI/);
  await assert.rejects(qualifyUIRefresh(records, { ...completed, state: 'error' }, expectation));
});

test('V2 full directory disclaimer never qualifies seed-only or failed inventory', () => {
  const expectation = qualifyCatalogReadExpectation(...v2ReadEvidence());
  const full = v2Directory(false);
  const observation = { overflow: false, records: [catalogRecord('loadProviderDirectory', full,
    { summary: false })] };
  assert.doesNotThrow(() => assertSettledDirectoryPage(full.directory, expectation, false));
  assert.throws(() => assertSettledDirectoryPage(full.directory), /Pending\/degraded/);
  assert.equal(settingsRefreshSettled(observation, 1000, 500, expectation), true);
  assert.equal(settingsRefreshFailure(observation, expectation), null);
  for (const invalidate of [
    (d) => { d.entries = []; d.returnedCount = 0; d.totalCount = 0; },
    (d) => { d.entries[0].modelCount = null; d.entries[0].metadata.hasKnownModels = false; },
    (d) => { d.entries[0].sources = ['seed']; },
    (d) => { d.entries[0].sources = 'not-inventory'; },
    (d) => { d.entries[0].providerId = 'foreign'; },
    (d) => { d.diagnostics.push('V2 read status unavailable'); },
    (d) => { d.diagnostics = ['capabilities_pending']; },
  ]) {
    const invalid = structuredClone(observation);
    invalidate(invalid.records[0].response.directory);
    assert.throws(() => assertSettledDirectoryPage(invalid.records[0].response.directory,
      expectation, false), /Pending\/degraded/);
    assert.equal(settingsRefreshSettled(invalid, 1000, 500, expectation), false);
    assert.equal(settingsRefreshFailure(invalid, expectation)?.category, 'native-diagnostics');
  }
  const failed = structuredClone(observation);
  failed.records[0].response.error = { message: 'native error' };
  assert.equal(settingsRefreshSettled(failed, 1000, 500, expectation), false);
  assert.equal(settingsRefreshFailure(failed, expectation)?.category, 'runtime-error');
});

test('V2 full settings accepts native provider provenance but rejects seed/config-only or failed reads', () => {
  const expectation = qualifyCatalogReadExpectation(...v2ReadEvidence());
  assert.equal(expectation.authenticationProven, false);
  assert.equal(expectation.launchReadinessProven, false);
  const response = v2Directory(false);
  Object.assign(response.directory.entries[0], { sources: ['opencode-provider'],
    sourceLabel: 'OpenCode catalog', state: 'available' });
  const observation = { overflow: false, records: [catalogRecord('loadProviderDirectory', response,
    { summary: false })] };
  assert.doesNotThrow(() => assertSettledDirectoryPage(response.directory, expectation, false));
  assert.equal(settingsRefreshSettled(observation, 1000, 500, expectation), true);
  assert.equal(settingsRefreshFailure(observation, expectation), null);
  // The same disclaimer and native-looking source cannot qualify a missing/failed inventory.
  for (const invalidate of [
    (d) => { d.entries[0].sources = ['seed']; },
    (d) => { d.entries[0].sources = ['config-provider']; },
    (d) => { d.entries[0].sources = []; },
    (d) => { d.entries[0].sources = 'opencode-provider'; },
    (d) => { d.entries[0].modelCount = null; },
    (d) => { d.entries[0].modelCount = 0; },
    (d) => { d.entries[0].modelCount = 2.5; },
    (d) => { d.entries[0].metadata.hasKnownModels = false; },
    (d) => { d.entries[0].providerId = 'foreign'; },
    (d) => { d.diagnostics.push('V2 read status unavailable'); },
    (d) => { d.diagnostics.push('inventory probe timed out'); },
    (d) => { d.diagnostics = ['capabilities_pending']; },
  ]) {
    const invalid = structuredClone(observation);
    invalidate(invalid.records[0].response.directory);
    assert.throws(() => assertSettledDirectoryPage(invalid.records[0].response.directory,
      expectation, false), /Pending\/degraded/);
    assert.equal(settingsRefreshSettled(invalid, 1000, 500, expectation), false);
    assert.equal(settingsRefreshFailure(invalid, expectation)?.category, 'native-diagnostics');
  }
  const failed = structuredClone(observation);
  failed.records[0].response.error = { message: 'actual native failure' };
  assert.equal(settingsRefreshSettled(failed, 1000, 500, expectation), false);
  assert.equal(settingsRefreshFailure(failed, expectation)?.category, 'runtime-error');
  // An unverified/V1 caller cannot use this V2-only disclaimer allowance.
  assert.equal(settingsRefreshSettled(observation, 1000), false);
  assert.equal(settingsRefreshFailure(observation)?.category, 'native-diagnostics');
});

test('V2 settings requires the same native identity and an actually observed fallback model', () => {
  const expectation = qualifyCatalogReadExpectation(...v2ReadEvidence());
  const response = {
    schemaVersion: 1, runtimeId: 'opencode', view: {
      runtimeId: 'opencode', runtime: { state: 'needs-auth', version: '2.1.4', cliPath: nativePath },
      providers: [{ providerId: 'opencode' }],
      configuredModels: [],
      fallbackModel: knownModels[0],
      diagnostics: [v2Disclaimer],
    },
  };
  assert.deepEqual(qualifySettings(response, expectation), { state: 'needs-auth', providers: 1, models: 0 });
  assert.throws(() => qualifySettings(response), /Settings diagnostics/);
  for (const invalidate of [
    (r) => { r.view.runtime.state = 'degraded'; },
    (r) => { r.view.runtime.version = '2.1.3'; },
    (r) => { r.view.runtime.cliPath = 'C:\\foreign\\opencode.exe'; },
    (r) => { delete r.view.fallbackModel; },
    (r) => { r.view.fallbackModel = null; },
    (r) => { r.view.fallbackModel = 'opencode/unobserved'; },
    (r) => {
      delete r.view.fallbackModel;
      r.view.configuredModels = [{ providerId: 'opencode', modelId: knownModels[0] }];
    },
    (r) => { r.view.providers = null; },
    (r) => { r.view.configuredModels = null; },
    (r) => { r.view.diagnostics.push('V2 read status unavailable'); },
    (r) => { r.error = { message: 'native failure' }; },
  ]) {
    const invalid = structuredClone(response);
    invalidate(invalid);
    assert.throws(() => qualifySettings(invalid, expectation));
  }
});

test('Settings refresh waits for a remounted control before exactly one mouse sequence', async () => {
  const points = [null, null, { x: 31, y: 42 }];
  const sent = []; let clock = 0;
  await clickControl(async () => points.shift(), async (_method, event) => sent.push(event), 'control', async readPoint => {
    const result = await waitForPackagedRefreshPreparation(async () => {
      const point = await readPoint();
      return { point, requestsSettled: true, catalog: { state: 'ready' }, control: { present: Boolean(point), connected: Boolean(point), rendered: Boolean(point), disabled: !point } };
    }, { phase: 'settings', now: () => clock, pause: async ms => { clock += ms; } });
    assert(result.ready); return result.point;
  });
  assert.equal(clock, 500);
  assert.deepEqual(sent.map(event => event.type), ['mousePressed', 'mouseReleased']);
  assert(sent.every(event => event.x === 31 && event.y === 42));
});
