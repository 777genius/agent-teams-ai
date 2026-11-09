#!/usr/bin/env node
/** Runs shipped, checksum-staged CLI against real OpenCode V1 metadata with no real credentials. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  assertStableConnectedProviders, connectedProviderIds, parseProviderDirectory, validateConnectedSummary,
} from './provider-real-runtime-policy.ts';

import type { ProviderDirectoryPage } from './provider-real-runtime-policy.ts';

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'runtime.lock.json'), 'utf8')) as {
  version: string; cliVersion: string;
  assets: Record<string, { binaryName: string }>;
};
const platform = process.platform + '-' + process.arch;
const asset = lock.assets[platform];
assert(asset, 'Pinned runtime not supported on this platform');
const binary = path.join(root, 'resources/runtime', asset.binaryName);
assert(fs.statSync(binary, { throwIfNoEntry: false })?.isFile(), 'Pinned runtime was not staged');
assert.equal(fs.readFileSync(path.join(root, 'resources/runtime/VERSION'), 'utf8').trim(),
  lock.version, 'Unexpected staged runtime version');
const opencodeBin = process.env.REAL_OPENCODE_TEST_BINARY;
assert(opencodeBin && path.isAbsolute(opencodeBin) &&
  fs.statSync(opencodeBin, { throwIfNoEntry: false })?.isFile(),
  'A real isolated OpenCode test binary must be provided');

interface Probe {
  phase: string;
  elapsedMs: number;
  stdoutBytes: number;
  totalCount: number;
  returnedCount: number;
  nextCursor: boolean;
}
interface ScenarioEvidence {
  name: string;
  summaryCount: number;
  summaryDirectoryTotal: number;
  warmSummaryCount: number;
  warmDirectoryTotal: number;
  unfilteredInventoryChanged: boolean;
  fullDirectoryTotal: number | null;
  fullPages: number;
  fullCatalogOver100: boolean | null;
  connectedIdsMatchFull: boolean | null;
  fullComparisonStatus: 'qualified' | 'incomplete_inventory' | 'runtime_unavailable' | 'not_run';
  /** Safe, fixed-category provenance; no paths/keys/provider diagnostic text. */
  configuredProviderState: 'connected' | 'available' | 'not-connected' | 'error' | 'missing' | 'other';
  probes: Probe[];
}
const report: {
  schemaVersion: number;
  pin: string;
  platform: string;
  observedRealRuntime: boolean;
  usesLiveAccounts: boolean;
  /** Only the real pinned CLI summary/filter contract, NOT full inventory or OAuth. */
  pass: boolean;
  qualificationScope: 'summary-filter-only';
  fullCatalogReconciled: boolean;
  desktopIpcQualified: false;
  scenarios: ScenarioEvidence[];
  inferenceRequests: number;
  failedPhase: string | null;
  failedReason: string | null;
  lastCommand: { phase: string; elapsedMs: number; stdoutBytes: number } | null;
  completedProbes: Probe[];
  nativeProbe: 'not_run' | 'failed' | 'connected_marker' | 'provider_mentioned' | 'absent';
  configuredAllEntryState: 'missing' | 'connected' | 'available' | 'not-connected' | 'error' | 'other';
} = {
  schemaVersion: 1, pin: lock.version, platform, observedRealRuntime: false,
  usesLiveAccounts: false, pass: false, qualificationScope: 'summary-filter-only',
  fullCatalogReconciled: false, desktopIpcQualified: false,
  scenarios: [], inferenceRequests: 0,
  failedPhase: null, failedReason: null, lastCommand: null, completedProbes: [],
  nativeProbe: 'not_run', configuredAllEntryState: 'missing',
};
const evidencePath = process.env.PROVIDER_REAL_E2E_EVIDENCE;
assert(evidencePath && path.isAbsolute(evidencePath), 'An absolute evidence path is required');
const testRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'TEST-real-provider-')));
let phase = 'start';
let inferenceRequests = 0;
let modelServer: ReturnType<typeof createServer> | null = null;

function isolatedEnv(home: string, configured: boolean): NodeJS.ProcessEnv {
  const permitted = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PSMODULEPATH'];
  const inherited: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (permitted.includes(key.toUpperCase()) && value !== undefined) inherited[key] = value;
  }
  const dirs: Record<string, string> = {
    HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData/Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData/Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local/state'),
    TMP: path.join(home, 'tmp'), TEMP: path.join(home, 'tmp'),
    TMPDIR: path.join(home, 'tmp'),
    CLAUDE_MULTIMODEL_DATA_HOME: path.join(home, 'runtime-data'),
    CLAUDE_MULTIMODEL_CACHE_HOME: path.join(home, 'runtime-cache'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    OPENCODE_BIN_PATH: opencodeBin!,
    CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: opencodeBin!,
  };
  Object.values(dirs).forEach(dir => {
    if (dir !== opencodeBin) fs.mkdirSync(dir, { recursive: true });
  });
  // Native Windows OpenCode/Bun reads HOMEDRIVE+HOMEPATH, not just USERPROFILE.
  // Derive them exclusively from this disposable root, never the runner home.
  const windowsHome = process.platform === 'win32'
    ? {
        HOMEDRIVE: path.parse(home).root.replace(/[\\/]+$/, ''),
        HOMEPATH: home.slice(path.parse(home).root.replace(/[\\/]+$/, '').length),
      }
    : {};
  return {
    ...inherited, ...dirs, ...windowsHome, NODE_BINARY: process.execPath,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    ...(configured ? { DEEPINFRA_API_KEY: 'TEST-nonsecret-local-catalog-only' } : {}),
  };
}

async function runCommand(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{
  stdout: string;
  elapsedMs: number;
  bytes: number;
}> {
  const startedAt = performance.now();
  let stdout: string;
  try {
    const result = await execute(binary, args, {
      cwd, env, timeout: 120_000, maxBuffer: 6 * 1024 * 1024,
      windowsHide: true,
    });
    stdout = result.stdout;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Deliberately no raw stdout/stderr/arguments: they may contain credentials.
    throw new Error(code === 'ETIMEDOUT' ? 'runtime_timeout' : 'runtime_command_failed');
  }
  return { stdout, elapsedMs: Math.round(performance.now() - startedAt),
    bytes: Buffer.byteLength(stdout) };
}

async function directory(
  filter: 'all' | 'connected', summary: boolean, cursor: string | null,
  cwd: string, env: NodeJS.ProcessEnv, probes: Probe[], label: string,
): Promise<ProviderDirectoryPage> {
  phase = label;
  const flags = ['runtime', 'providers', 'directory', '--runtime', 'opencode', '--json',
    ...(summary ? ['--summary'] : []),
    '--project-path', cwd, '--filter', filter, '--limit', '100',
    ...(cursor === null ? [] : ['--cursor', cursor])];
  const result = await runCommand(flags, cwd, env);
  report.lastCommand = { phase: label, elapsedMs: result.elapsedMs, stdoutBytes: result.bytes };
  const page = parseProviderDirectory(result.stdout, filter, cursor);
  const observation = { phase: label, elapsedMs: result.elapsedMs, stdoutBytes: result.bytes,
    totalCount: page.totalCount, returnedCount: page.returnedCount,
    nextCursor: page.nextCursor !== null };
  probes.push(observation);
  report.completedProbes.push(observation);
  return page;
}

async function checkScenario(name: 'clean' | 'ambient' | 'configured',
  port: number): Promise<ScenarioEvidence> {
  const home = path.join(testRoot, name);
  const cwd = path.join(home, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const configured = name !== 'clean';
  const env = isolatedEnv(home, configured);
  if (configured) {
    const configRoot = path.join(home, '.config/opencode');
    fs.mkdirSync(configRoot, { recursive: true });
    // A documented V1 metadata-only provider, pointed exclusively at local HTTP.
    fs.writeFileSync(path.join(configRoot, 'opencode.jsonc'), JSON.stringify({
      plugin: [], provider: { deepinfra: {
        options: { baseURL: 'http://127.0.0.1:' + port + '/v1',
          apiKey: '{env:DEEPINFRA_API_KEY}' },
        models: { 'TEST-local-catalog-model': {
          name: 'TEST catalog model', limit: { context: 8192, output: 1024 },
        } },
      } },
    }));
  }
  if (name === 'configured') {
    // A nonsecret, purely synthetic credential exercises the real OpenCode
    // saved-auth path on both OSes; all model endpoints stay on loopback.
    const authDir = path.join(env.XDG_DATA_HOME!, 'opencode');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'auth.json'),
      JSON.stringify({ deepinfra: { type: 'api', key: 'TEST-nonsecret-local-catalog-only' } }),
      { mode: 0o600, flag: 'wx' });
  }
  const probes: Probe[] = [];
  if (name === 'ambient') {
    // Same disposable config and environment, but invoke OpenCode directly.
    // Never retain stdout/stderr, which could contain profile paths or secrets.
    phase = name + '-native-providers-list';
    try {
      const read = await execute(opencodeBin!, ['providers', 'list'], {
        cwd, env, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true,
      });
      const output = read.stdout;
      report.nativeProbe = /●\s+deepinfra(?:\s|$)/iu.test(output)
        ? 'connected_marker'
        : /\bdeepinfra\b/iu.test(output) ? 'provider_mentioned' : 'absent';
    } catch {
      report.nativeProbe = 'failed';
    }
  }
  const all = await directory('all', true, null, cwd, env, probes, name + '-summary-all');
  if (configured) {
    const state = all.entries.find((row) =>
      row.providerId.trim().toLowerCase() === 'deepinfra')?.state ?? 'missing';
    report.configuredAllEntryState = ['connected', 'available', 'not-connected', 'error', 'missing']
      .includes(state) ? state as typeof report.configuredAllEntryState : 'other';
  }
  const connected = await directory('connected', true, null, cwd, env, probes,
    name + '-summary-connected');
  const summaryCount = validateConnectedSummary(all, connected);
  if (name === 'configured') {
    assert(connectedProviderIds(connected.entries).includes('deepinfra'),
      'Configured loopback provider missing from real CLI connected summary');
    assert(summaryCount > 0, 'No positive connected-filter evidence');
  } else if (name === 'clean') {
    assert.equal(summaryCount, 0, 'Credential-free baseline unexpectedly connected');
  }
  // Reobserve the connected identities, not the total unfiltered inventory.
  // The published V1 host can discover/drop *available* providers between
  // independent metadata reads even when no credentials change.
  const warmAll = await directory('all', true, null, cwd, env, probes,
    name + '-summary-all-warm');
  const warmConnected = await directory('connected', true, null, cwd, env, probes,
    name + '-summary-connected-warm');
  const warmSummaryCount = validateConnectedSummary(warmAll, warmConnected);
  assert.equal(warmSummaryCount, summaryCount,
    'Connected summary changed without a credential mutation');
  assertStableConnectedProviders(connected.entries, warmConnected.entries);
  // The full catalog is *not* required to establish a complete summary count.
  // The real V1 host may fail to start or return incomplete inventory in a
  // credential-free sandbox. Record that limitation rather than claiming its
  // partial rows prove an exact all-provider total.
  let fullDirectoryTotal: number | null = null;
  let fullPages = 0;
  let fullCatalogOver100: boolean | null = null;
  let connectedIdsMatchFull: boolean | null = null;
  let fullComparisonStatus: ScenarioEvidence['fullComparisonStatus'] = 'not_run';
  if (name === 'configured') {
    const full: ProviderDirectoryPage[] = [];
    const ids = new Set<string>();
    let cursor: string | null = null;
    try {
      do {
        const page = await directory('all', false, cursor, cwd, env, probes,
          name + '-full-page-' + (full.length + 1));
        if (full.length > 0) assert.equal(page.totalCount, full[0].totalCount);
        for (const entry of page.entries) {
          const id = entry.providerId.trim().toLowerCase();
          assert(!ids.has(id), 'Full pages duplicate provider identity');
          ids.add(id);
        }
        full.push(page);
        cursor = page.nextCursor;
        assert(full.length <= 12, 'Provider directory exceeds bounded 1200-entry budget');
      } while (cursor !== null);
      assert.equal(ids.size, full[0].totalCount);
      const fullConnected = connectedProviderIds(full.flatMap(x => x.entries));
      const summaryConnected = connectedProviderIds(connected.entries);
      assert.deepEqual(summaryConnected, fullConnected,
        'Summary count differs from complete real CLI directory');
      fullDirectoryTotal = ids.size;
      fullPages = full.length;
      fullCatalogOver100 = ids.size > 100;
      connectedIdsMatchFull = true;
      fullComparisonStatus = 'qualified';
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (!['runtime_timeout', 'runtime_command_failed',
        'Directory contains incomplete inventory diagnostics',
        'Genuine runtime refused directory read'].includes(code)) throw error;
      fullComparisonStatus = code ===
        'Directory contains incomplete inventory diagnostics'
        ? 'incomplete_inventory' : 'runtime_unavailable';
    }
  }
  const observedState = all.entries.find((row) =>
    row.providerId.trim().toLowerCase() === 'deepinfra')?.state ?? 'missing';
  const configuredProviderState = ['connected', 'available', 'not-connected', 'error', 'missing']
    .includes(observedState) ? observedState as ScenarioEvidence['configuredProviderState'] : 'other';
  return { name, summaryCount, summaryDirectoryTotal: all.totalCount,
    warmSummaryCount, warmDirectoryTotal: warmAll.totalCount,
    unfilteredInventoryChanged: warmAll.totalCount !== all.totalCount,
    fullDirectoryTotal, fullPages, fullCatalogOver100, connectedIdsMatchFull,
    fullComparisonStatus, configuredProviderState, probes };
}

try {
  if (process.platform === 'win32') {
    phase = 'windows-private-acl';
    // Reuse the existing reviewed TEST-only ACL boundary for native auth.json.
    const { protectWindowsTestDirectory } = await import('./opencode-native-test-auth.ts');
    await protectWindowsTestDirectory(testRoot);
  }
  phase = 'version';
  const version = await runCommand(['--version'], testRoot, isolatedEnv(testRoot, false));
  assert(version.stdout.includes(lock.cliVersion), 'Wrong released runtime CLI version');
  report.observedRealRuntime = true;
  modelServer = createServer((req, res) => {
    if (req.method !== 'GET') {
      inferenceRequests++;
      res.writeHead(405); res.end();
      return;
    }
    if (req.url === '/v1/models' || req.url === '/models' || req.url === '/auth') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list',
        data: [{ id: 'TEST-local-catalog-model', object: 'model' }] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve, reject) => {
    modelServer!.once('error', reject);
    modelServer!.listen(0, '127.0.0.1', resolve);
  });
  const address = modelServer.address();
  assert(address && typeof address === 'object');
  report.scenarios.push(await checkScenario('clean', address.port));
  // Record the env-only path as an explicit observation: the shipped Windows
  // V1 runtime may not count it even though Linux does. Do not mask divergence.
  report.scenarios.push(await checkScenario('ambient', address.port));
  report.scenarios.push(await checkScenario('configured', address.port));
  report.inferenceRequests = inferenceRequests;
  assert.equal(inferenceRequests, 0, 'A nonmetadata local model request was attempted');
  report.fullCatalogReconciled =
    report.scenarios.find(s => s.name === 'configured')?.fullComparisonStatus === 'qualified';
  // Do not overstate this result. The full host-backed directory is optional
  // diagnostic evidence and can fail in a credential-free runner.
  report.pass = true;
} catch (error) {
  report.failedPhase = phase;
  const reason = error instanceof Error ? error.message : '';
  // Existing ACL helper emits only fixed fields (phase, reason, errno, exit).
  // Allow its bounded diagnostic, never arbitrary stderr/profile paths.
  const safeAclReason = /^Private Windows TEST ACL qualification failed: reason=(?:process_failure|process_exit|spawn_failure|output_limit|timeout); phase=(?:startup|owner|set_acl|read_acl|verify_acl); errno=(?:none|E[A-Z0-9_]{1,48}); exit=(?:none|-?[0-9]{1,10})$/.test(reason)
    ? reason : null;
  report.failedReason = safeAclReason ?? [
    'runtime_timeout', 'runtime_command_failed',
    'Runtime stdout is not a single valid JSON value',
    'Genuine runtime refused directory read',
    'Directory contains incomplete inventory diagnostics',
    'Summary count differs from complete real CLI directory',
    'Configured loopback provider missing from real CLI connected summary',
    'Provider directory exceeds bounded 1200-entry budget',
    'Connected summary is incomplete',
  ].find((value) => reason.includes(value)) ?? 'contract_error';
  process.exitCode = 1;
} finally {
  // Only fixed safe numeric measurements leave the E2E process, never raw CLI
  // output, user paths, environment, host address or credentials.
  try {
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, JSON.stringify(report, null, 2) + '\n');
  } catch {
    // A missing evidence artifact invalidates the CI qualification. Do not
    // replace or erase the originating assertion failure, and never log paths.
    report.pass = false;
    report.failedPhase ??= 'evidence-write';
    report.failedReason ??= 'evidence_write_failed';
    process.exitCode = 1;
  } finally {
    try {
      if (modelServer) {
        modelServer.closeAllConnections();
        await new Promise<void>(resolve => modelServer!.close(() => resolve()));
      }
    } finally {
      // Always delete the isolated test home, even if evidence writing fails.
      // Windows may retain a native OpenCode handle briefly after command completion.
      // Retry bounded transient locks; a persistent failure still fails this E2E.
      fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
    }
  }
  console.log('real-runtime-provider-e2e: ' +
    (report.pass
      ? 'PASS summary-filter-only; full-catalog=' +
        (report.fullCatalogReconciled ? 'qualified' : 'unqualified')
      : 'FAIL phase=' + report.failedPhase));
}
