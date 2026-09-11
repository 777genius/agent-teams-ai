import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, stat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  packagedArguments,
  closePackagedBrowser,
  packagedStopOrder,
  packagedDrainSnapshot,
  packagedEnvironment,
  packagedTarget,
  containedPath,
  fingerprint,
  runtimeProvenance,
  preparePackagedProfile,
  probeOrchestratorVersion,
} from './packaged.mjs';
import {
  waitForPackagedPreload,
  matchesPackagedPreload,
  refreshSettled,
  qualifySummary,
  qualifySettings,
  settingsRefreshSettled,
  waitForAppVersion,
  qualifyModels,
  collectPages,
  readCommittedCatalog,
  observeCatalogBridge,
  bridgeObservationLocation,
  qualifyUIRefresh,
} from './packaged-verify.mjs';

const exe = 'C:\\test builds\\win-unpacked\\Agent Teams AI.exe';
test('explicit packaged arguments are bounded, Windows-only and never accept runtime overrides', () => {
  assert.deepEqual(packagedArguments(['--packaged-executable', exe], 'win32'), {
    executable: exe,
    runtimeSetup: 'none',
  });
  assert.equal(
    packagedArguments(['--packaged-executable', exe, '--runtime-setup', 'app-install'], 'win32')
      .runtimeSetup,
    'app-install'
  );
  for (const bad of [
    'agent.exe',
    'C:agent.exe',
    '\\\\host\\share\\agent.exe',
    'https://host/app.exe',
    'C:\\Setup.exe',
    'C:\\uninstall.exe',
    'C:\\a.cmd',
    'C:\\app.exe:stream',
    'C:\\app.exe\n',
  ])
    assert.throws(() => packagedArguments(['--packaged-executable', bad], 'win32'));
  for (const args of [
    [],
    ['--exe', exe],
    ['--packaged-executable', exe, '--allow-fallback'],
    ['--packaged-executable', exe, '--runtime-setup', 'https://example/runtime'],
    ['--packaged-executable', exe, '--opencode', 'C:\\dev\\opencode.exe'],
  ])
    assert.throws(() => packagedArguments(args, 'win32'));
  assert.throws(() => packagedArguments(['--packaged-executable', exe], 'linux'));
});

test('packaged environment reuses isolation without inheriting credentials, PATH or developer runtime plumbing', () => {
  const data = {
    home: 'C:\\sandbox\\home',
    userData: 'C:\\sandbox\\user-data',
    temp: 'C:\\sandbox\\tmp',
  };
  const inherited = {
    SystemRoot: 'C:\\Windows',
    Path: 'C:\\developer\\bin',
    PATH: 'C:\\npm',
    HOME: 'C:\\real-user',
    APPDATA: 'C:\\real-user\\roaming',
    ProgramFiles: 'C:\\Program Files',
    NVM_HOME: 'C:\\nvm',
    NVM_SYMLINK: 'C:\\nodejs',
    NODE_OPTIONS: '--require=evil',
    ELECTRON_RUN_AS_NODE: '1',
    OPENCODE_BIN_PATH: 'C:\\installed.exe',
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: 'C:\\developer.exe',
    ANTHROPIC_API_KEY: 'secret',
    OPENAI_API_KEY: 'secret',
    OPENCODE_CONFIG: 'real.json',
    HTTP_PROXY: 'credential',
    ComSpec: 'C:\\custom-shell.exe',
    USERPROFILE: 'C:\\real-user',
  };
  const env = packagedEnvironment(data, inherited, path.win32);
  assert.equal(env.ProgramFiles, inherited.ProgramFiles);
  assert.equal(env.HOME, data.home);
  assert.equal(env.USERPROFILE, data.home);
  assert.equal(env.AGENT_TEAMS_ELECTRON_USER_DATA_DIR, data.userData);
  assert.equal(
    env.PATH,
    'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0'
  );
  assert.equal(env.ComSpec, 'C:\\Windows\\System32\\cmd.exe');
  for (const key of [
    'NVM_HOME',
    'NVM_SYMLINK',
    'NODE_OPTIONS',
    'NODE_BINARY',
    'OPENCODE_BIN_PATH',
    'CLAUDE_CLI_PATH',
    'CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'OPENCODE_CONFIG',
    'HTTP_PROXY',
    'ELECTRON_RUN_AS_NODE',
  ])
    assert.equal(env[key], undefined, key);
  assert(!JSON.stringify(env).includes('real-user'));
  assert(!JSON.stringify(env).includes('secret'));
  assert.throws(() => packagedEnvironment(data, {}, path.win32));
});

test('only exact packaged file entrypoint after ownership proof, never arbitrary file pages', () => {
  const renderer = 'C:\\test builds\\win-unpacked\\resources\\app.asar\\out\\renderer\\index.html';
  const target = {
    type: 'page',
    url: 'file:///C:/test%20builds/win-unpacked/resources/app.asar/out/renderer/index.html',
  };
  assert.equal(packagedTarget([target], renderer, true, path.win32), target);
  assert.equal(
    packagedTarget([{ ...target, url: target.url + '#/dashboard' }], renderer, true, path.win32)
      .type,
    'page'
  );
  assert.throws(() => packagedTarget([target], renderer, false, path.win32));
  assert.throws(() => packagedTarget([target, target], renderer, true, path.win32));
  for (const url of [
    'http://localhost:5173',
    'file:///C:/other/index.html',
    target.url + '?dev=true',
    target.url.replace('app.asar', 'another.asar'),
    target.url.replace('file:///', 'file://server/'),
    'file:///C:/bad%ZZ',
  ])
    assert.throws(() => packagedTarget([{ ...target, url }], renderer, true, path.win32));
  assert.throws(() =>
    packagedTarget([{ ...target, type: 'service_worker' }], renderer, true, path.win32)
  );
});

test('provenance checks exact bundle hash and real disposable OpenCode path, including symlink escape', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-packaged-test-'));
  try {
    const managed = path.join(root, 'user-data/data/runtimes/opencode');
    await mkdir(managed, { recursive: true });
    const bundled = path.join(root, 'bundled.exe');
    const runtime = path.join(managed, 'opencode.exe');
    const foreign = path.join(root, 'foreign.exe');
    await writeFile(bundled, 'bundle');
    await writeFile(runtime, 'runtime');
    await writeFile(foreign, 'foreign');
    const data = {
      userData: path.join(root, 'user-data'),
      artifact: { orchestrator: await fingerprint(bundled) },
    };
    const status = { binaryPath: runtime, source: 'app-managed', version: '1.2.3' };
    assert.equal((await runtimeProvenance(status, data, 'opencode')).version, '1.2.3');
    await assert.rejects(runtimeProvenance({ ...status, source: 'path' }, data, 'opencode'));
    await assert.rejects(runtimeProvenance({ ...status, binaryPath: foreign }, data, 'opencode'));
    await runtimeProvenance({ binaryPath: bundled }, data, 'orchestrator');
    await writeFile(bundled, 'changed');
    await assert.rejects(runtimeProvenance({ binaryPath: bundled }, data, 'orchestrator'));
    if (process.platform !== 'win32') {
      const link = path.join(managed, 'escape.exe');
      await symlink(foreign, link);
      await assert.rejects(runtimeProvenance({ ...status, binaryPath: link }, data, 'opencode'));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert(!containedPath('C:\\sandbox-other\\runtime.exe', 'C:\\sandbox', path.win32));
  assert(!containedPath('D:\\sandbox\\runtime.exe', 'C:\\sandbox', path.win32));
  assert(containedPath('C:\\sandbox\\runtime.exe', 'c:\\SANDBOX', path.win32));
});

test('catalog qualification refuses error evidence, stale/unknown/empty/incomplete results', () => {
  const response = {
    schemaVersion: 1,
    runtimeId: 'opencode',
    models: {
      runtimeId: 'opencode',
      providerId: 'opencode',
      catalogState: 'fresh',
      models: [{ providerId: 'opencode', modelId: 'actual' }],
      totalCount: 1,
    },
  };
  assert.equal(qualifyModels(response, 'opencode').length, 1);
  assert.throws(() =>
    qualifyModels(
      { ...response, error: { message: 'failed', diagnostics: { reportId: 'oc-id' } } },
      'opencode'
    )
  );
  for (const patch of [
    { catalogState: 'stale' },
    { catalogState: undefined },
    { models: null },
    { providerId: 'foreign' },
  ])
    assert.throws(() =>
      qualifyModels({ ...response, models: { ...response.models, ...patch } }, 'opencode')
    );
});

test('prelaunch creates only disposable profile paths and refuses installed fallback or escaped managed manifests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-packaged-profile-'));
  try {
    const data = {
      root,
      home: path.join(root, 'home'),
      userData: path.join(root, 'user-data'),
      temp: path.join(root, 'tmp'),
    };
    const systemRoot = path.join(root, 'test-system');
    await mkdir(path.join(systemRoot, 'System32'), { recursive: true });
    const inherited = { SystemRoot: systemRoot };
    const env = await preparePackagedProfile(data, inherited);
    for (const key of [
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'TMP',
      'TEMP',
      'TMPDIR',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'XDG_STATE_HOME',
      'AGENT_TEAMS_ELECTRON_USER_DATA_DIR',
    ]) {
      assert(containedPath(env[key], root));
      assert((await stat(env[key])).isDirectory());
    }
    assert.deepEqual(await readdir(path.join(data.userData, 'data/runtimes/opencode')), []);
    assert(!(await readdir(root)).some((name) => /fixture|scenario|bin/.test(name)));
    const installed = path.join(systemRoot, 'System32/opencode.exe');
    await writeFile(installed, 'installed');
    await assert.rejects(preparePackagedProfile(data, inherited), /Installed runtime fallback/);
    await rm(installed);
    const runtimeRoot = path.join(data.userData, 'data/runtimes/opencode');
    await mkdir(runtimeRoot, { recursive: true });
    const foreign = path.join(root, 'foreign.exe');
    await writeFile(foreign, 'foreign');
    await writeFile(
      path.join(runtimeRoot, 'current.json'),
      JSON.stringify({
        schemaVersion: 1,
        platformPackage: 'opencode-windows-x64',
        integrity: 'sha512-example',
        binaryPath: foreign,
      })
    );
    await assert.rejects(
      preparePackagedProfile(data, inherited),
      /escapes disposable runtime root/
    );
    await assert.rejects(
      preparePackagedProfile({ ...data, home: os.tmpdir() }, inherited),
      /Profile escapes/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prelaunch refuses a junction ancestor before creating directories outside the profile', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-profile-junction-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'opencode-profile-outside-'));
  try {
    await symlink(
      outside,
      path.join(root, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const data = {
      root,
      home: path.join(root, 'home'),
      userData: path.join(root, 'user-data'),
      temp: path.join(root, 'escape/new-temp'),
    };
    await assert.rejects(
      preparePackagedProfile(data, { SystemRoot: path.join(root, 'test-system') }),
      /before directory creation/
    );
    assert.deepEqual(await readdir(outside), [], 'Preflight wrote through the escaping ancestor');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('deferred discovery without cached version qualifies provenance, separately from execution', async () => {
  const binary = await fingerprint(process.execPath);
  const result = await runtimeProvenance(
    { installed: true, installedVersion: null, binaryPath: process.execPath },
    { artifact: { orchestrator: binary } },
    'orchestrator'
  );
  assert.equal(result.version, null);
  const version = await probeOrchestratorVersion(result.path, { env: {}, cwd: os.tmpdir() });
  assert.equal(version.passed, true);
  assert.match(version.stdout, /v\d+/);
  assert.equal(version.timeoutMs, 10000);
  assert.equal(version.exitCode, 0);
});

test('actual subprocess version failure and timeout retain output and execution evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'packaged-version-'));
  try {
    const fixture = path.join(root, 'fixture.cjs');
    const executeFixture = (binary, args, options, callback) =>
      execFile(binary, [fixture, ...args], options, callback);
    await writeFile(
      fixture,
      "process.stdout.write('partial-version'); process.stderr.write('fixture-error'); process.exit(7);"
    );
    const failed = await probeOrchestratorVersion(
      process.execPath,
      {
        env: {},
        cwd: root,
      },
      executeFixture
    );
    assert.equal(failed.passed, false);
    assert.equal(failed.exitCode, 7);
    assert.equal(failed.stdout, 'partial-version');
    assert.equal(failed.stderr, 'fixture-error');
    assert(failed.error && failed.durationMs >= 0);
    await writeFile(fixture, "process.stdout.write('before-timeout'); while(true) {};");
    const timed = await probeOrchestratorVersion(
      process.execPath,
      {
        env: {},
        cwd: root,
        timeout: 1000,
      },
      executeFixture
    );
    assert.equal(timed.passed, false);
    assert.equal(timed.timedOut, true);
    assert.equal(timed.stdout, 'before-timeout');
    assert(timed.error && timed.durationMs >= 900);
    const missing = await probeOrchestratorVersion(path.join(root, 'missing'), {
      env: {},
      cwd: root,
    });
    assert.equal(missing.passed, false);
    assert.equal(missing.exitCode, null);
    assert(missing.error);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const modelPage = (ids, cursor, nextCursor, totalCount = 2) => ({
  schemaVersion: 1,
  runtimeId: 'opencode',
  models: {
    runtimeId: 'opencode',
    providerId: 'opencode',
    catalogState: 'fresh',
    models: ids.map((modelId) => ({ providerId: 'opencode', modelId })),
    cursor,
    nextCursor,
    totalCount,
    returnedCount: ids.length,
  },
});
test('models follow normal pagination and compare the complete fresh inventory', async () => {
  const calls = [];
  const models = await collectPages(
    async (cursor, page) => {
      calls.push(cursor);
      return page === 0 ? modelPage(['one'], null, 'next') : modelPage(['two'], 'next', null);
    },
    'models',
    'opencode'
  );
  assert.deepEqual(calls, [null, 'next']);
  assert.deepEqual(
    models.map((m) => m.modelId),
    ['one', 'two']
  );
});

test('pagination refuses duplicate identities, loops, changed totals, stale/error pages and truncation', async () => {
  for (const second of [
    modelPage(['opencode/one'], 'next', null),
    modelPage(['two'], 'next', 'next'),
    modelPage(['two'], 'wrong', null),
    modelPage(['two'], 'next', null, 3),
    modelPage([], 'next', null),
    { ...modelPage(['two'], 'next', null), error: { message: 'failed' } },
    {
      ...modelPage(['two'], 'next', null),
      models: { ...modelPage(['two'], 'next', null).models, catalogState: 'stale' },
    },
  ]) {
    await assert.rejects(
      collectPages(
        async (_, page) => (page ? second : modelPage(['one'], null, 'next')),
        'models',
        'opencode'
      )
    );
  }
  await assert.rejects(
    collectPages(async () => modelPage(['one'], null, 'next'), 'models', 'opencode', 1),
    /bounded/
  );
});

test('directory pagination accumulates sources with duplicate protection', async () => {
  const load = async (cursor, page) => ({
    schemaVersion: 1,
    runtimeId: 'opencode',
    directory: {
      runtimeId: 'opencode',
      entries: [{ providerId: page ? 'other' : 'opencode' }],
      cursor,
      nextCursor: page ? null : 'next',
      returnedCount: 1,
      totalCount: 2,
    },
  });
  assert.equal((await collectPages(load, 'directory')).length, 2);
  await assert.rejects(
    collectPages(async (cursor, page) => {
      const response = await load(cursor, page);
      response.directory.entries = [{ providerId: 'opencode' }];
      return response;
    }, 'directory'),
    /Duplicate/
  );
});

test('committed catalog follows shared bailout children and successive root commits', () => {
  const root = {};
  const old = { stateNode: root };
  const current = { stateNode: root };
  const status = (state) => ({
    cliStatus: {
      providers: [
        { providerId: 'opencode', modelCatalogRefreshState: state, models: ['opencode/actual'] },
      ],
    },
  });
  const shared = { return: old, memoizedProps: status('ready') };
  old.child = shared;
  current.child = shared;
  old.alternate = current;
  current.alternate = old;
  root.current = current;
  const document = { querySelectorAll: () => [{ __reactFiber$test: shared }] };
  assert.equal(readCommittedCatalog(document).state, 'ready');
  old.child = { memoizedProps: status('loading'), return: old };
  root.current = old;
  assert.equal(readCommittedCatalog(document).state, 'loading');
  current.child = { sibling: { memoizedProps: status('ready'), return: current } };
  root.current = current;
  assert.equal(readCommittedCatalog(document).state, 'ready');
});

test('absent manifest never bypasses managed runtime junction containment', async () => {
  for (const suffix of ['data', 'data/runtimes', 'data/runtimes/opencode']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'packaged-managed-junction-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'packaged-managed-outside-'));
    try {
      const data = {
        root,
        home: path.join(root, 'home'),
        userData: path.join(root, 'user-data'),
        temp: path.join(root, 'tmp'),
      };
      const link = path.join(data.userData, suffix);
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(
        preparePackagedProfile(data, { SystemRoot: path.join(root, 'system') }),
        /before directory creation/
      );
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }
});

const uiRecord = (method, response, patch = {}) => ({
  method,
  startedAt: 1,
  completedAt: 2,
  response,
  input: {
    runtimeId: 'opencode',
    projectPath: null,
    refresh: true,
    cursor: null,
    ...(method === 'loadModels'
      ? { providerId: 'opencode', requestGroupId: 'dashboard-connected-catalog:1:opencode' }
      : { summary: true, filter: 'all' }),
    ...patch,
  },
});
const uiDirectory = (entries) =>
  uiRecord('loadProviderDirectory', {
    schemaVersion: 1,
    runtimeId: 'opencode',
    directory: {
      runtimeId: 'opencode',
      entries,
      cursor: null,
      nextCursor: null,
      returnedCount: entries.length,
      totalCount: entries.length,
    },
  });

test('measured unknown UI freshness fails even with ready UI and identical fresh separate API models', async () => {
  const fresh = modelPage(['one'], null, null, 1);
  const records = [uiDirectory([{ providerId: 'opencode' }]), uiRecord('loadModels', fresh)];
  const completed = { state: 'ready', models: ['opencode/one'] };
  assert.deepEqual((await qualifyUIRefresh(records, completed)).modelIds, completed.models);
  assert.equal((await collectPages(async () => fresh, 'models', 'opencode')).length, 1);
  for (const catalogState of [undefined, 'unknown', 'stale']) {
    await assert.rejects(
      qualifyUIRefresh(
        [
          records[0],
          uiRecord('loadModels', {
            ...fresh,
            models: { ...fresh.models, catalogState },
          }),
        ],
        completed
      ),
      /unknown models/
    );
  }
});

test('measured UI requires all actual fresh pages, matching sources and completed responses', async () => {
  const records = [
    uiDirectory([{ providerId: 'opencode' }]),
    uiRecord('loadModels', modelPage(['one'], null, 'next')),
    uiRecord('loadModels', modelPage(['two'], 'next', null), { cursor: 'next' }),
  ];
  const completed = { state: 'ready', models: ['opencode/one', 'opencode/two'] };
  assert.equal((await qualifyUIRefresh(records, completed)).modelIds.length, 2);
  await assert.rejects(qualifyUIRefresh(records.slice(0, 2), completed), /Missing UI page/);
  for (const patch of [
    { completedAt: undefined },
    { response: undefined },
    { error: 'failed' },
    { input: { ...records[2].input, providerId: 'foreign' } },
    { input: { ...records[2].input, refresh: false } },
    { input: { ...records[2].input, requestGroupId: 'another' } },
  ]) {
    await assert.rejects(
      qualifyUIRefresh([...records.slice(0, 2), { ...records[2], ...patch }], completed)
    );
  }
  await assert.rejects(
    qualifyUIRefresh(records, { ...completed, models: ['opencode/one'] }),
    /Rendered UI/
  );
});

test('empty successful inventory is transport evidence; freshness and source checks still apply', async () => {
  const completed = { state: 'ready', models: [] };
  assert.deepEqual(await qualifyUIRefresh([uiDirectory([])], completed), {
    sources: [],
    modelIds: [],
  });
  const records = [
    uiDirectory([{ providerId: 'opencode' }]),
    uiRecord('loadModels', modelPage([], null, null, 0)),
  ];
  assert.deepEqual((await qualifyUIRefresh(records, completed)).modelIds, []);
  await assert.rejects(
    qualifyUIRefresh([uiDirectory([{ providerId: 'foreign' }])], completed),
    /No actual OpenCode source/
  );
  await assert.rejects(
    qualifyUIRefresh(
      [
        records[0],
        uiRecord('loadModels', {
          ...records[1].response,
          models: { ...records[1].response.models, catalogState: undefined },
        }),
      ],
      completed
    )
  );
});

test('preload observer returns identical promises/data and records only armed catalog calls', async () => {
  const host = {};
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  const input = { providerId: 'opencode' };
  let seen;
  const api = {
    runtimeProviderManagement: {
      loadModels(value) {
        seen = value;
        return promise;
      },
      loadProviderDirectory() {
        return Promise.reject(new Error('real rejection'));
      },
    },
  };
  observeCatalogBridge(api, host);
  assert.equal(api.runtimeProviderManagement.loadModels(input), promise);
  assert.equal(host.__packagedCatalogObservation.records.length, 0);
  host.__packagedCatalogObservation.active = true;
  assert.equal(api.runtimeProviderManagement.loadModels(input), promise);
  assert.equal(seen, input);
  const response = modelPage(['one'], null, null, 1);
  resolve(response);
  assert.equal(await promise, response);
  await Promise.resolve();
  assert.deepEqual(host.__packagedCatalogObservation.records[0].response, response);
  assert.notEqual(host.__packagedCatalogObservation.records[0].response, response);
  await assert.rejects(api.runtimeProviderManagement.loadProviderDirectory({}), /real rejection/);
  assert.match(host.__packagedCatalogObservation.records[1].error, /real rejection/);
  host.__packagedCatalogObservation.active = false;
  await api.runtimeProviderManagement.loadModels(input);
  assert.equal(host.__packagedCatalogObservation.records.length, 2);
});

test('observation resolves only the single public bridge exposure, including minified names', () => {
  const source = 'const x = 1;\n  e.contextBridge.exposeInMainWorld("electronAPI",a);';
  const location = bridgeObservationLocation(source);
  assert.equal(location.lineNumber, 1);
  assert.equal(location.columnNumber, 2);
  assert.match(location.condition, /\(a,globalThis\)/);
  assert.throws(() => bridgeObservationLocation('no exposure'));
  assert.throws(() => bridgeObservationLocation(source + source));
});

test('preload discovery waits for delayed CDP events and rejects missing or ambiguous targets', async () => {
  const scripts = [];
  const expected = { scriptId: 'owned', executionContextId: 7 };
  const timer = setTimeout(() => scripts.push(expected), 20);
  try {
    assert.equal(await waitForPackagedPreload(scripts, 1000), expected);
  } finally {
    clearTimeout(timer);
  }
  await assert.rejects(waitForPackagedPreload([], 0), /found 0/);
  await assert.rejects(waitForPackagedPreload([expected, expected], 0), /found 2/);
});

test('anonymous preload selection requires exact packaged source and bounded wrapper', () => {
  const expected = 'unique packaged preload source';
  assert(matchesPackagedPreload(expected, expected));
  assert(matchesPackagedPreload(`(function(){${expected}})`, expected));
  assert(!matchesPackagedPreload('other script', expected));
  assert(!matchesPackagedPreload(expected + expected, expected));
  assert(!matchesPackagedPreload('x'.repeat(2049) + expected, expected));
  assert(!matchesPackagedPreload('', ''));
});

test('fast refresh can settle without a sampled loading state but cannot use cached readiness', () => {
  const ready = { state: 'ready' };
  assert(refreshSettled({ records: [{ completedAt: 123 }], overflow: false }, ready));
  assert(!refreshSettled({ records: [], overflow: false }, ready));
  assert(!refreshSettled({ records: [{}], overflow: false }, ready));
  assert(
    !refreshSettled({ records: [{ completedAt: 123 }], overflow: false }, { state: 'loading' })
  );
  assert(!refreshSettled({ records: [{ completedAt: 123 }], overflow: true }, ready));
});

test('passive summary permits catalog qualification without claiming auth or launch readiness', () => {
  const passive = {
    providerId: 'opencode',
    supported: true,
    statusCheckOutcome: 'model_only',
    statusCheckErrorCode: 'partial_response',
    statusMessage: 'OpenCode detected (passive)',
    verificationState: 'unknown',
    authenticated: false,
    capabilities: { teamLaunch: false, oneShot: false },
  };
  assert.deepEqual(qualifySummary(passive), {
    kind: 'passive-detection',
    authenticationProven: false,
    launchReadinessProven: false,
  });
  for (const patch of [
    { supported: false },
    { statusCheckErrorCode: 'timeout' },
    { statusMessage: 'Incomplete response' },
    { statusCheckOutcome: 'pending' },
    { providerId: 'codex' },
  ])
    assert.throws(() => qualifySummary({ ...passive, ...patch }));
});

test('main readiness waits only for missing version handler and preserves real failures', async () => {
  let calls = 0;
  assert.equal(
    await waitForAppVersion(() => {
      if (++calls === 1) throw new Error("No handler registered for 'get-app-version'");
      return '2.1.2';
    }, 1000),
    '2.1.2'
  );
  assert.equal(calls, 2);
  await assert.rejects(
    waitForAppVersion(() => {
      throw new Error('main crashed');
    }),
    /main crashed/
  );
  await assert.rejects(
    waitForAppVersion(() => {
      throw new Error("No handler registered for 'get-app-version'");
    }, 0),
    /No handler/
  );
});

test('native settings qualification rejects degraded or failed reads', () => {
  const response = { schemaVersion: 1, runtimeId: 'opencode', view: {
    runtimeId: 'opencode', runtime: { state: 'ready' }, providers: [], configuredModels: [], diagnostics: [],
  } };
  assert.equal(qualifySettings(response).state, 'ready');
  for (const state of ['degraded', 'needs-setup', undefined]) {
    assert.throws(() => qualifySettings({ ...response, view: { ...response.view, runtime: { state } } }));
  }
  assert.throws(() => qualifySettings({ ...response, error: { message: 'timeout' } }));
  assert.throws(() => qualifySettings({ ...response, view: { ...response.view, diagnostics: ['HTTP timeout'] } }));
});

test('settings refresh waits for fresh explicit request and delayed settlement', () => {
  const first = { method: 'loadProviderDirectory', input: { runtimeId: 'opencode', refresh: true }, response: { schemaVersion: 1, runtimeId: 'opencode', directory: { runtimeId: 'opencode', entries: [], returnedCount: 0, totalCount: 0, diagnostics: [] } }, completedAt: 1000 };
  const observation = { records: [first], overflow: false };
  assert.equal(settingsRefreshSettled(observation, 1499), false);
  assert.equal(settingsRefreshSettled(observation, 1500), true);
  first.response.directory.diagnostics.push({ message: 'inventory timed out' });
  assert.equal(settingsRefreshSettled(observation, 1500), false);
  first.response.directory.diagnostics = [];
  const delayed = { method: 'loadModels', startedAt: 1400 };
  observation.records.push(delayed);
  assert.equal(settingsRefreshSettled(observation, 2000), false);
  Object.assign(delayed, { response: { schemaVersion: 1, runtimeId: 'opencode', models: { runtimeId: 'opencode', catalogState: 'fresh', models: [] } }, completedAt: 1800 });
  assert.equal(settingsRefreshSettled(observation, 2000), false);
  assert.equal(settingsRefreshSettled(observation, 2300), true);
  delayed.response.error = 'late failure';
  assert.equal(settingsRefreshSettled(observation, 2400), false);
  assert.equal(settingsRefreshSettled({ records: [{ ...first, input: { refresh: false } }], overflow: false }, 3000), false);
});

test('packaged cleanup stops main before recovering helpers and drains sockets jointly', () => {
  const launcher = { pid: 1, birth: 'one' };
  const main = { pid: 2, parent: 1, birth: 'two', executable: exe };
  const helper = { pid: 3, parent: 2, birth: 'three', executable: exe };
  const owned = [launcher, main, helper];
  assert.deepEqual(packagedStopOrder(owned, exe), [main, helper, launcher]);
  assert.deepEqual(owned, [launcher, main, helper]);
  assert.equal(packagedDrainSnapshot(owned, [], [2]).drained, false);
  assert.equal(packagedDrainSnapshot(owned, [main], []).drained, false);
  assert.equal(packagedDrainSnapshot(owned, [], []).drained, true);
  assert.equal(packagedDrainSnapshot(owned, [{ ...main, birth: 'reused' }], [2]).drained, false);
});

function browserCloseFixture({ endpoint = 'ws://127.0.0.1:9222/devtools/browser/test', failCheck = 0, respond = true } = {}) {
  const socket = new EventEmitter();
  socket.readyState = 1;
  const sent = [];
  let checks = 0;
  let connected = false;
  let terminated = false;
  socket.send = message => {
    sent.push(JSON.parse(message));
    if (respond) queueMicrotask(() => socket.emit('message', '{"id":1,"result":{}}'));
  };
  socket.terminate = () => { terminated = true; socket.readyState = 3; };
  return {
    options: {
      assertOwnership: async () => { if (++checks === failCheck) throw new Error('PID reused'); },
      readVersion: async () => ({ webSocketDebuggerUrl: endpoint }),
      connect: () => { connected = true; queueMicrotask(() => socket.emit('open')); return socket; },
      timeoutMs: 50,
    },
    state: () => ({ sent, checks, connected, terminated }),
  };
}

test('graceful packaged cleanup checks ownership before discovery, connection and Browser.close', async () => {
  const fixture = browserCloseFixture();
  assert.equal(await closePackagedBrowser(fixture.options), 'acknowledged');
  assert.deepEqual(fixture.state(), {
    sent: [{ id: 1, method: 'Browser.close' }], checks: 3, connected: true, terminated: true,
  });
});

test('graceful packaged cleanup rejects foreign endpoints and ownership changes', async () => {
  for (const endpoint of ['ws://foreign:9222/devtools/browser/test', 'ws://127.0.0.1:9223/devtools/browser/test',
    'ws://127.0.0.1:9222/devtools/page/test', 'ws://user@127.0.0.1:9222/devtools/browser/test']) {
    const fixture = browserCloseFixture({ endpoint });
    await assert.rejects(closePackagedBrowser(fixture.options), /Unexpected/);
    assert.equal(fixture.state().connected, false);
  }
  for (const failCheck of [1, 2, 3]) {
    const fixture = browserCloseFixture({ failCheck });
    await assert.rejects(closePackagedBrowser(fixture.options), /PID reused/);
    assert.deepEqual(fixture.state().sent, []);
  }
});

test('graceful packaged cleanup bounds an unresponsive browser and closes its socket', async () => {
  const fixture = browserCloseFixture({ respond: false });
  await assert.rejects(closePackagedBrowser(fixture.options), /timed out/);
  assert.equal(fixture.state().terminated, true);
});
