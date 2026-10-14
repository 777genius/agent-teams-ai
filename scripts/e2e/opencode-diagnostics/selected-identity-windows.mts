// Model-free observation only. REJECTED is not a Windows qualification result.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, writeFileSync } from 'node:fs';
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_BASE = '9b75e305f7b0902601ca2bb8cf21c23dfd202fb2';
const SDK_HEAD = '7e0e4e6b330d376a654f189ac90aaa49912e7463';
const NATIVE_SHA = 'bb731f311416df16691fa16763eb87657c4a5f5f3bcff5202718c416e8f7ab1a';
const appPins = [
  ['runtime.lock.json', 'e61c02bc78b509d6d795cb17fa0d71e93f442ad79107987b36f544d8225749a9'],
  ['scripts/stage-runtime.mjs', 'b8349451a38d87cd55789ad548ae4ecc27b1e99deba08a52d0d33dab8b7fdab2'],
  [
    'scripts/stage-opencode-console-wrapper.mjs',
    '9b1edfd453aaa76e3aa34db6e3eaabc34200cafdcc3d0cc621c8e2cb9c5cf4f1',
  ],
  [
    'src/main/services/runtime/openCodeRuntimeBinaryEnv.ts',
    'd762b74c7bb4ab0cfb2f3afc2c923cd81bd462e297c3364f386c77ee95a402ed',
  ],
] as const;
const sdkSources = [
  'src/services/opencode/compatibility/OpenCodeNativeIdentity.ts',
  'src/services/opencode/compatibility/OpenCodeVersionProbe.ts',
  'src/services/opencode/OpenCodeCursorAgentTreeKill.ts',
  'src/utils/portableCli.ts',
  'src/utils/processKill.ts',
];
const receipt: Record<string, unknown> = {
  schemaVersion: 1,
  diagnosticOnly: true,
  appBase: APP_BASE,
  sdkHead: SDK_HEAD,
  outcome: 'NOT_RUN',
  qualification: 'NOT_ASSESSED',
  physicalRetirement: 'unproven',
  admissionCalls: 0,
  phase: 'inputs',
  helperFailure: null,
  terminalDiagnostic: null,
  executionMode: 'source_sdk_control_on_published_staged_bun',
  compiledCliIdentityInspection: 'not_run',
  rawHelperStderr: 'not_exposed_by_sdk_api',
  comparisonOnly: 'not_run',
};
let output: string | undefined;
const save = () => {
  if (output) writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function requireInput(value: unknown): asserts value {
  if (!value) throw new Error('diagnostic_precondition_failed');
}
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const contained = (file: string, root: string) => {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};
async function hash(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function json(file: string): Promise<unknown> {
  const leaf = await lstat(file);
  requireInput(leaf.isFile() && !leaf.isSymbolicLink() && leaf.size <= 64 * 1024);
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}
function helperFailure(value: unknown): Record<string, unknown> | null {
  if (
    !record(value) ||
    typeof value.operation !== 'string' ||
    typeof value.reason !== 'string' ||
    !['birth', 'tree'].includes(value.operation) ||
    ![
      'helper_timeout',
      'helper_nonzero',
      'helper_spawn_error',
      'helper_output_limit',
      'helper_error',
    ].includes(value.reason) ||
    (value.exitCode !== null && !integer(value.exitCode, -0x80000000, 0xffffffff)) ||
    !integer(value.elapsedMs, 0, 60000)
  )
    return null;
  let cause: Record<string, unknown> | null = null;
  if (record(value.helperCause)) {
    const raw = value.helperCause;
    if (
      typeof raw.stage === 'string' &&
      typeof raw.category === 'string' &&
      ['process_lookup', 'start_time'].includes(raw.stage) &&
      [
        'ArgumentException',
        'InvalidOperationException',
        'Win32Exception',
        'UnauthorizedAccessException',
        'other',
      ].includes(raw.category) &&
      integer(raw.hresult, -0x80000000, 0x7fffffff) &&
      (raw.nativeErrorCode === null || integer(raw.nativeErrorCode, -0x80000000, 0x7fffffff))
    ) {
      cause = {
        stage: raw.stage,
        category: raw.category,
        hresult: raw.hresult,
        nativeErrorCode: raw.nativeErrorCode,
      };
    }
  }
  return {
    operation: value.operation,
    reason: value.reason,
    exitCode: value.exitCode,
    elapsedMs: value.elapsedMs,
    helperCause: cause,
  };
}
function terminalDiagnostic(value: unknown): Record<string, unknown> | null {
  if (
    !record(value) ||
    typeof value.phase !== 'string' ||
    typeof value.guard !== 'string' ||
    ![
      'initial_birth',
      'census',
      'candidate_validation',
      'anchor_identity',
      'addition_identity',
      'identity_confirmation',
      'signal',
      'retirement',
      'wait',
      'roots_remove',
    ].includes(value.phase) ||
    ![
      'deadline',
      'protected_candidate',
      'candidate_alive',
      'candidate_unknown',
      'strict_candidate_census',
      'identity_missing',
      'identity_changed_live',
      'anchor_missing',
      'protected_addition',
      'parent_identity',
      'ancestry_changed',
      'signal_failed_live',
      'final_pending',
      'final_retirement',
      'census_unreadable',
      'roots_remove',
      'unexpected',
    ].includes(value.guard) ||
    !integer(value.pendingCount, 0, 4096)
  )
    return null;
  const result: Record<string, unknown> = {
    phase: value.phase,
    guard: value.guard,
    pendingCount: value.pendingCount,
  };
  for (const key of ['closed', 'ended']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'boolean') return null;
    result[key] = value[key];
  }
  for (const [key, max, nullable] of [
    ['exitCode', 0xffffffff, true],
    ['birthsCount', 4096, false],
    ['candidatesCount', 4096, false],
    ['lastGroupCount', 1000000, true],
    ['lastSurvivorCount', 1000000, true],
    ['remainingMs', 8000, false],
  ] as const) {
    if (value[key] === undefined) continue;
    if (
      !(nullable && value[key] === null) &&
      !integer(value[key], key === 'exitCode' ? -0x80000000 : 0, max)
    )
      return null;
    result[key] = value[key];
  }
  return result;
}

async function main() {
  const [sdkArg, nativeArg, outputArg, ...extra] = process.argv.slice(2);
  const runnerTemp = process.env.RUNNER_TEMP;
  requireInput(
    runnerTemp && outputArg && path.isAbsolute(runnerTemp) && path.isAbsolute(outputArg)
  );
  const temp = await realpath(runnerTemp);
  requireInput(
    (await realpath(path.dirname(outputArg))) === temp &&
      path.basename(outputArg) === 'selected-identity-windows.json'
  );
  const outputLeaf = await lstat(outputArg);
  requireInput(outputLeaf.isFile() && !outputLeaf.isSymbolicLink());
  output = outputArg;
  save();
  requireInput(
    process.platform === 'win32' &&
      process.arch === 'x64' &&
      extra.length === 0 &&
      sdkArg &&
      nativeArg
  );
  requireInput(path.isAbsolute(sdkArg) && path.isAbsolute(nativeArg));
  const app = await realpath(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  );
  const sdk = await realpath(sdkArg);
  const git = (root: string, args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  receipt.phase = 'source_binding';
  const appHead = git(app, ['rev-parse', 'HEAD']);
  requireInput(/^[a-f0-9]{40}$/.test(appHead) && git(sdk, ['rev-parse', 'HEAD']) === SDK_HEAD);
  git(app, ['merge-base', '--is-ancestor', APP_BASE, 'HEAD']);
  git(sdk, ['diff', '--quiet', 'HEAD', '--']);
  receipt.appHead = appHead;
  for (const [relative, expected] of appPins)
    requireInput((await hash(path.join(app, relative))) === expected);
  const bindings = [];
  for (const relative of sdkSources)
    bindings.push({ path: relative, sha256: await hash(path.join(sdk, relative)) });
  receipt.sdkSources = bindings;
  receipt.scriptSha256 = await hash(fileURLToPath(import.meta.url));
  receipt.workflowSha256 = await hash(
    path.join(app, '.github/workflows/opencode-packaged-e2e.yml')
  );
  const lock = await json(path.join(app, 'runtime.lock.json'));
  requireInput(
    record(lock) &&
      lock.version === '0.0.117' &&
      lock.sourceRef === 'v0.0.117' &&
      lock.sourceRepository === '777genius/agent_teams_orchestrator' &&
      lock.releaseRepository === '777genius/agent_teams_orchestrator_binaries' &&
      lock.releaseTag === 'runtime-v0.0.117'
  );
  requireInput(
    record(lock.assets) &&
      record(lock.assets['win32-x64']) &&
      lock.assets['win32-x64'].sha256 ===
        '203c617ad3ef3e3666a3aa28bd6b5a766be7d4f162ff57ae950400ee5ea68899'
  );
  receipt.runtimeLockSha256 = appPins[0][1];
  receipt.runtimeArchiveSha256 = lock.assets['win32-x64'].sha256;
  receipt.phase = 'staged_runtime';
  const runtime = path.join(app, 'resources/runtime');
  const bun = await realpath(path.join(runtime, 'Bun/bun.exe'));
  requireInput(
    (await realpath(process.execPath)) === bun &&
      typeof process.versions.bun === 'string' &&
      /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]{1,32})?$/.test(process.versions.bun)
  );
  receipt.engineVersions = { bun: process.versions.bun, nodeCompatibility: process.versions.node };
  receipt.bunRelativePath = 'resources/runtime/Bun/bun.exe';
  requireInput((await readFile(path.join(runtime, 'VERSION'), 'utf8')).length < 4096);
  requireInput((await readFile(path.join(runtime, 'VERSION'), 'utf8')).includes('0.0.117'));
  receipt.bunSha256 = await hash(bun);
  receipt.runtimeBinarySha256 = await hash(path.join(runtime, 'claude-multimodel.exe'));
  receipt.runtimeVersion = '0.0.117';
  receipt.phase = 'native_and_wrapper';
  const native = await realpath(nativeArg);
  requireInput(
    contained(native, temp) &&
      path.relative(temp, native).split(path.sep)[0]?.startsWith('TEST-opencode-native-')
  );
  requireInput((await hash(native)) === NATIVE_SHA);
  const metadata = await json(path.join(path.dirname(path.dirname(native)), 'package.json'));
  requireInput(
    record(metadata) && metadata.name === 'opencode-windows-x64' && metadata.version === '1.19.0'
  );
  const ownTmp = await mkdtemp(path.join(temp, 'TEST-opencode-identity-'));
  receipt.ownedRootBasename = path.basename(ownTmp);
  const clean: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) clean[key] = process.env[key];
  }
  clean.PATH = [path.dirname(bun), path.join(clean.SystemRoot ?? 'C:\\Windows', 'System32')].join(
    path.delimiter
  );
  Object.assign(clean, {
    HOME: ownTmp,
    USERPROFILE: ownTmp,
    APPDATA: ownTmp,
    LOCALAPPDATA: ownTmp,
    TMP: ownTmp,
    TEMP: ownTmp,
    TMPDIR: ownTmp,
  });
  const environment: unknown = await import(pathToFileURL(path.join(app, appPins[3][0])).href);
  requireInput(
    record(environment) && typeof environment.applyOpenCodeRuntimeBinaryEnv === 'function'
  );
  environment.applyOpenCodeRuntimeBinaryEnv(clean, native, {
    resourcesPath: path.join(app, 'resources'),
    platform: 'win32',
    env: clean,
  });
  const wrapper = await realpath(path.join(runtime, 'opencode-console/opencode.exe'));
  requireInput(contained(wrapper, await realpath(runtime)));
  requireInput(
    clean.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH === wrapper &&
      clean.OPENCODE_BIN_PATH === wrapper &&
      clean.OPENCODE_CONSOLE_WRAPPER_TARGET === native
  );
  const sidecar = path.join(path.dirname(wrapper), 'opencode.real.path');
  const sidecarLeaf = await lstat(sidecar);
  requireInput(
    sidecarLeaf.isFile() &&
      !sidecarLeaf.isSymbolicLink() &&
      sidecarLeaf.size <= 4096 &&
      (await readFile(sidecar, 'utf8')).trim() === native
  );
  const wrapperHash = await hash(wrapper);
  receipt.nativeSha256 = NATIVE_SHA;
  receipt.nativePackage = {
    name: 'opencode-windows-x64',
    version: '1.19.0',
    relativeToRunnerTemp: path.relative(temp, native),
  };
  receipt.wrapperSha256 = wrapperHash;
  receipt.wrapperSidecarMatchesNative = true;
  const cli = spawnSync(native, ['--version'], {
    cwd: ownTmp,
    env: clean,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4096,
    windowsHide: true,
  });
  receipt.nativeCli = { exitCode: cli.status, versionMatches: cli.stdout?.trim() === '1.19.0' };
  requireInput(cli.status === 0 && cli.stdout?.trim() === '1.19.0');
  const publicCli = spawnSync(path.join(runtime, 'claude-multimodel.exe'), ['--version'], {
    cwd: ownTmp,
    env: clean,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4096,
    windowsHide: true,
  });
  receipt.compiledCliPublicVersion = {
    exitCode: publicCli.status,
    versionMatches: /^2\.777\.777(?: \(Claude Code\))?$/.test(publicCli.stdout?.trim() ?? ''),
    identityInspection: 'not_run',
  };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, clean);
  receipt.phase = 'sdk_import';
  save();
  const identity: unknown = await import(pathToFileURL(path.join(sdk, sdkSources[0]!)).href);
  const cleanup: unknown = await import(pathToFileURL(path.join(sdk, sdkSources[1]!)).href);
  const tree: unknown = await import(pathToFileURL(path.join(sdk, sdkSources[2]!)).href);
  requireInput(
    record(identity) &&
      typeof identity.inspectOpenCodeReadSelection === 'function' &&
      record(cleanup) &&
      typeof cleanup.OpenCodeVersionProbeCleanupError === 'function' &&
      record(tree) &&
      typeof tree.nativePorts === 'function'
  );
  receipt.phase = 'self_birth';
  let selfFailure: unknown = null;
  const ports: unknown = tree.nativePorts({}, (failure: unknown) => {
    selfFailure = failure;
  });
  requireInput(record(ports) && typeof ports.birth === 'function');
  save();
  const selfStarted = performance.now();
  let selfTimedOut = false;
  const selfTimer = setTimeout(() => {
    selfTimedOut = true;
    receipt.outcome = 'TIMEOUT';
    receipt.ownedRootRetained = true;
    receipt.selfBirth = {
      outcome: 'observation_timeout',
      helperFailure: helperFailure(selfFailure),
    };
    receipt.physicalRetirement = 'unproven';
    save();
  }, 15000);
  try {
    const birth: unknown = await ports.birth(process.pid, 5000);
    if (selfTimedOut) {
      receipt.selfBirth = {
        selfPid: process.pid,
        knownAlive: true,
        outcome: 'observation_timeout',
        helperFailure: helperFailure(selfFailure),
      };
      return;
    }
    receipt.selfBirth = {
      selfPid: process.pid,
      knownAlive: true,
      outcome: integer(birth, 1, Number.MAX_SAFE_INTEGER) ? 'birth_observed' : 'birth_missing',
      birthTimeMs: integer(birth, 1, Number.MAX_SAFE_INTEGER) ? birth : null,
      elapsedMs: Math.round(performance.now() - selfStarted),
      helperFailure: helperFailure(selfFailure),
    };
  } finally {
    clearTimeout(selfTimer);
  }
  if (selfTimedOut) return;
  receipt.phase = 'admission';
  receipt.admissionCalls = 1;
  receipt.outcome = 'IN_PROGRESS';
  save();
  const started = performance.now();
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    receipt.outcome = 'TIMEOUT';
    receipt.physicalRetirement = 'unproven';
    save();
    abort.abort();
  }, 15000);
  try {
    const result: unknown = await identity.inspectOpenCodeReadSelection(abort.signal);
    if (timedOut) return;
    requireInput(
      record(result) &&
        record(result.policy) &&
        result.path === wrapper &&
        result.fingerprint === wrapperHash &&
        result.policy.generation === 'v1' &&
        result.policy.version === '1.19.0'
    );
    requireInput((await hash(native)) === NATIVE_SHA && (await hash(wrapper)) === wrapperHash);
    if (timedOut) return;
    receipt.outcome = 'ADMITTED';
    receipt.policy = { generation: 'v1', version: '1.19.0' };
    receipt.physicalRetirement = 'confirmed_by_owned_probe';
  } catch (error) {
    if (timedOut) return;
    receipt.outcome = 'REJECTED';
    receipt.physicalRetirement = 'unproven';
    receipt.class =
      error instanceof Error &&
      ['cleanup_unknown', 'selection_unavailable', 'identity_mismatch'].includes(error.message)
        ? error.message
        : 'other_error';
    if (error instanceof cleanup.OpenCodeVersionProbeCleanupError && record(error)) {
      receipt.helperFailure = helperFailure(error.helperFailure);
      receipt.terminalDiagnostic = terminalDiagnostic(error.terminalDiagnostic);
    }
  } finally {
    clearTimeout(timer);
    receipt.elapsedMs = Math.round(performance.now() - started);
    save();
    // Only successful owned SDK retirement permits removing this diagnostic's roots.
    if (receipt.outcome === 'ADMITTED') {
      try {
        await rm(ownTmp, { recursive: true, force: true });
        receipt.ownedRootRemoved = true;
      } catch {
        receipt.ownedRootRemoved = false;
      }
    } else receipt.ownedRootRetained = true;
  }
}
try {
  await main();
} catch {
  receipt.outcome = receipt.admissionCalls === 1 ? 'REJECTED' : 'NOT_RUN';
  receipt.physicalRetirement = 'unproven';
  receipt.errorClass = 'diagnostic_precondition_or_import_failed';
  if (receipt.ownedRootBasename) receipt.ownedRootRetained = true;
}
save();
if (receipt.outcome === 'NOT_RUN' || receipt.outcome === 'TIMEOUT') process.exitCode = 1;
